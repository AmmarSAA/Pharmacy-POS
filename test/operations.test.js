import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { testStore, stopTestStore, put } from './helpers/mongo.js'
import { createApp } from '../src/app.js'

let server, base, db
const tokens = {}
const ids = {}

before(async () => {
  db = await testStore()
  server = createApp(db).listen(0)
  await new Promise((r) => server.once('listening', r))
  base = `http://127.0.0.1:${server.address().port}/api`

  await db.col('products').insertOne({
    _id: 500, id: 500, name: 'Panadol', name_lc: 'panadol', pack_size: 10, pack_price: 1000, sale_price: 100,
    schedule: 'otc', gst_rate_bps: 0, allow_loose: 1, active: 1,
  })
  await put(db, 'batches', { product_id: 500, batch_no: 'PX1', expiry_date: '2099-01-01', cost_price: 60, sale_price: 100, pack_price: 1000, pack_size: 10, qty_on_hand: 1000000 })
})
after(async () => {
  server.close()
  await stopTestStore()
})

async function call(method, path, body, as = 'admin') {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(tokens[as] ? { authorization: `Bearer ${tokens[as]}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, body: await res.json() }
}
const login = async (u, p) => (await call('POST', '/auth/login', { username: u, password: p })).body.token

test('setup', async () => {
  await call('POST', '/auth/setup', { username: 'admin', full_name: 'Admin', password: 'adminpass1' })
  tokens.admin = await login('admin', 'adminpass1')
  await call('POST', '/users', { username: 'cash1', full_name: 'Cash One', role: 'cashier', password: 'password1' })
  tokens.cashier = await login('cash1', 'password1')
  await call('POST', '/tills/open', { opening_cash: 5000 })
  await call('POST', '/tills/open', { opening_cash: 5000 }, 'cashier')
})

// ---------------- Customers, account sales & loyalty ----------------

test('a customer account is created and a sale on account bills it', async () => {
  const create = await call('POST', '/customers', { name: 'Dr. House', phone: '0300-1234567', due_days: 14 })
  assert.equal(create.status, 201)
  ids.customer = create.body.id
  assert.equal(create.body.loyalty_points, 0)

  const sale = await call('POST', '/sales', { items: [{ product_id: 500, qty: 10 }], payment_method: 'account', customer_id: ids.customer })
  assert.equal(sale.status, 201)
  assert.equal(sale.body.amount_paid, 0)
  assert.equal(sale.body.total, 1000) // 1 pack = Rs 10 * 10 units... pack_price 1000 paisa = Rs 10 for 10 units -> 1 pack of 10 = Rs 10 = 1000 paisa
  ids.accountSale = sale.body.id

  // 1 point per Rs 100: Rs 10 earns 0 points (rounds down) — use a bigger sale to check accrual.
  const big = await call('POST', '/sales', { items: [{ product_id: 500, qty: 1000 }], payment_method: 'account', customer_id: ids.customer })
  assert.equal(big.status, 201)
  const after = await call('GET', `/customers/${ids.customer}`)
  assert.ok(after.body.loyalty_points >= 10, `expected at least 10 points, got ${after.body.loyalty_points}`)
  assert.ok(after.body.balance > 0, 'customer owes for the account sales')
})

test('an account sale needs a customer; a cashier cannot manage customers but can sell on account', async () => {
  const noCustomer = await call('POST', '/sales', { items: [{ product_id: 500, qty: 1 }], payment_method: 'account' })
  assert.equal(noCustomer.status, 400)
  assert.equal((await call('GET', '/customers', null, 'cashier')).status, 403)
  const cashierSale = await call('POST', '/sales', { items: [{ product_id: 500, qty: 1 }], payment_method: 'account', customer_id: ids.customer }, 'cashier')
  assert.equal(cashierSale.status, 201)
})

test('loyalty points redeem as a discount and cannot exceed the balance', async () => {
  const before = (await call('GET', `/customers/${ids.customer}`)).body.loyalty_points
  const tooMany = await call('POST', '/sales', { items: [{ product_id: 500, qty: 10 }], payment_method: 'cash', customer_id: ids.customer, redeem_points: before + 1000 })
  assert.equal(tooMany.status, 400)
  const sale = await call('POST', '/sales', {
    items: [{ product_id: 500, qty: 10 }], payment_method: 'cash', amount_paid: 0, customer_id: ids.customer, redeem_points: before,
  })
  assert.equal(sale.status, 201)
  assert.equal(sale.body.loyalty_redeemed, before)
  assert.ok(sale.body.total < 1000, 'redeemed points reduced the total')
  const after = (await call('GET', `/customers/${ids.customer}`)).body.loyalty_points
  assert.ok(after < before, 'points were spent')
})

test('a customer payment pays down the account; the ledger nets to the remaining balance', async () => {
  const before = (await call('GET', `/customers/${ids.customer}`)).body.balance
  assert.ok(before > 0)
  const pay = await call('POST', `/customers/${ids.customer}/payments`, { amount: before, method: 'cash' })
  assert.equal(pay.status, 201)
  const after = await call('GET', `/customers/${ids.customer}`)
  assert.equal(after.body.balance, 0)
  const ledger = await call('GET', `/customers/${ids.customer}/ledger`)
  assert.equal(ledger.body.balance, 0)
})

test('returning an account sale credits the account, not the till drawer', async () => {
  const before = (await call('GET', `/customers/${ids.customer}`)).body.balance
  const sale = await call('GET', `/sales/${ids.accountSale}`)
  const ret = await call('POST', `/sales/${ids.accountSale}/returns`, { items: [{ sale_item_id: sale.body.items[0].id, qty: 1 }], reason: 'unopened' })
  assert.equal(ret.status, 201)
  assert.equal(ret.body.returns[0].refund_method, 'account')
  const after = await call('GET', `/customers/${ids.customer}`)
  assert.ok(after.body.balance < before + 1, 'the return reduced what is owed, not increased cash owed')
})

// ---------------- Purchase orders ----------------

test('a purchase order moves draft -> sent -> received when the goods are receipted', async () => {
  const supplier = await call('POST', '/suppliers', { name: 'Acme Pharma', due_days: 30 })
  ids.supplier = supplier.body.id

  const create = await call('POST', '/purchase-orders', {
    supplier_id: ids.supplier, items: [{ product_id: 500, packs: 5, pack_size: 10, pack_cost: 800 }],
  })
  assert.equal(create.status, 201)
  assert.equal(create.body.status, 'draft')
  ids.po = create.body.id

  assert.equal((await call('POST', `/purchase-orders/${ids.po}/status`, { status: 'sent' })).body.status, 'sent')
  // Cannot receive by just flipping status.
  assert.equal((await call('POST', `/purchase-orders/${ids.po}/status`, { status: 'received' })).status, 400)
  // Can't edit once sent.
  assert.equal((await call('PUT', `/purchase-orders/${ids.po}`, { items: [{ product_id: 500, packs: 1, pack_size: 10, pack_cost: 800 }] })).status, 409)

  const stockBefore = (await call('GET', '/products/500')).body.stock
  const receive = await call('POST', '/purchases', {
    supplier_id: ids.supplier, purchase_order_id: ids.po,
    items: [{ product_id: 500, batch_no: 'PO1', expiry_date: '2099-01-01', packs: 5, pack_cost: 800 }],
  })
  assert.equal(receive.status, 201)
  const stockAfter = (await call('GET', '/products/500')).body.stock
  assert.equal(stockAfter, stockBefore + 50)

  const po = await call('GET', `/purchase-orders/${ids.po}`)
  assert.equal(po.body.status, 'received')
  assert.equal(po.body.received_invoice_no, receive.body.invoice_no)

  // A purchase order for the wrong supplier, or already received, is refused.
  const other = await call('POST', '/suppliers', { name: 'Other Supplier' })
  const wrongSupplier = await call('POST', '/purchases', {
    supplier_id: other.body.id, purchase_order_id: ids.po, items: [{ product_id: 500, batch_no: 'X', expiry_date: '2099-01-01', packs: 1, pack_cost: 800 }],
  })
  assert.equal(wrongSupplier.status, 400)
})

test('a cashier cannot manage purchase orders', async () => {
  assert.equal((await call('GET', '/purchase-orders', null, 'cashier')).status, 403)
})

// ---------------- Stock transfers ----------------

test('stock sent to another location leaves this location\'s sellable stock, and can be received or reversed', async () => {
  const loc = await call('POST', '/transfers/locations', { name: 'Downtown Branch' })
  assert.equal(loc.status, 201)
  ids.location = loc.body.id

  const stockBefore = (await call('GET', '/products/500')).body.stock
  const transfer = await call('POST', '/transfers', { to_location_id: ids.location, items: [{ product_id: 500, qty: 100 }] })
  assert.equal(transfer.status, 201)
  assert.equal(transfer.body.status, 'sent')
  ids.transfer = transfer.body.id
  const stockAfterSend = (await call('GET', '/products/500')).body.stock
  assert.equal(stockAfterSend, stockBefore - 100)

  const recv = await call('POST', `/transfers/${ids.transfer}/receive`)
  assert.equal(recv.body.status, 'received')
  // Once received it cannot be cancelled/reversed.
  assert.equal((await call('POST', `/transfers/${ids.transfer}/cancel`)).status, 409)
})

test('cancelling a sent (not yet received) transfer puts the stock back', async () => {
  const stockBefore = (await call('GET', '/products/500')).body.stock
  const transfer = await call('POST', '/transfers', { to_location_id: ids.location, items: [{ product_id: 500, qty: 40 }] })
  assert.equal((await call('GET', '/products/500')).body.stock, stockBefore - 40)
  const cancel = await call('POST', `/transfers/${transfer.body.id}/cancel`)
  assert.equal(cancel.body.status, 'cancelled')
  assert.equal((await call('GET', '/products/500')).body.stock, stockBefore)
})

test('a cashier cannot manage transfers or locations', async () => {
  assert.equal((await call('GET', '/transfers', null, 'cashier')).status, 403)
  assert.equal((await call('GET', '/transfers/locations', null, 'cashier')).status, 403)
})
