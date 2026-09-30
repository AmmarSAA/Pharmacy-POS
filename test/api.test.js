import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db-node.js'
import { createApp } from '../src/app.js'

let server, base
const tokens = {}

// TEST_BASE_URL runs the same checks against a running server with an empty database
// (e.g. `npx wrangler dev` for the Cloudflare build).
before(async () => {
  if (process.env.TEST_BASE_URL) {
    base = `${process.env.TEST_BASE_URL}/api`
    return
  }
  const db = openDb(':memory:')
  server = createApp(db).listen(0)
  await new Promise((r) => server.once('listening', r))
  base = `http://127.0.0.1:${server.address().port}/api`
})
after(() => server?.close())

async function call(method, path, body, as = 'admin') {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(tokens[as] ? { authorization: `Bearer ${tokens[as]}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, body: await res.json() }
}

const inDays = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10)
const ids = {}

test('first-run setup creates the admin and then locks', async () => {
  assert.equal((await call('GET', '/auth/status')).body.needsSetup, true)
  const r = await call('POST', '/auth/setup', { username: 'owner', full_name: 'Owner', password: 'secret123', pharmacy_name: 'Test Pharmacy' })
  assert.equal(r.status, 201)
  const again = await call('POST', '/auth/setup', { username: 'x', full_name: 'X', password: 'secret123' })
  assert.equal(again.status, 409)
  tokens.admin = (await call('POST', '/auth/login', { username: 'owner', password: 'secret123' })).body.token
  assert.ok(tokens.admin)
  assert.equal((await call('GET', '/settings')).body.pharmacy_name, 'Test Pharmacy')
  assert.equal((await call('GET', '/settings')).body.jwt_secret, undefined)
})

test('requests without a token are rejected', async () => {
  assert.equal((await call('GET', '/products', null, 'nobody')).status, 401)
})

test('admin creates staff; cashier cannot manage users', async () => {
  for (const [u, role] of [['cash1', 'cashier'], ['pharm1', 'pharmacist']]) {
    assert.equal((await call('POST', '/users', { username: u, full_name: u, role, password: 'password1' })).status, 201)
    tokens[role] = (await call('POST', '/auth/login', { username: u, password: 'password1' })).body.token
  }
  assert.equal((await call('GET', '/users', null, 'cashier')).status, 403)
})

// Selling and refunding need an open till (setting require_open_till = '1' by default).
test('staff open their tills', async () => {
  for (const as of ['admin', 'cashier', 'pharmacist']) {
    const r = await call('POST', '/tills/open', { opening_cash: 0 }, as)
    assert.equal(r.status, 201, JSON.stringify(r.body))
    assert.equal(r.body.status, 'open')
  }
})

test('catalogue and purchase receiving create batches', async () => {
  const mk = (name, schedule, gst = 0, barcode) =>
    call('POST', '/products', { name, schedule, sale_price: 250, gst_rate_bps: gst, reorder_level: 50, barcode })
  ids.otc = (await mk('Panadol 500mg', 'otc', 0, '111')).body.id
  ids.taxed = (await mk('Face Mask', 'otc', 1800)).body.id
  ids.rx = (await mk('Augmentin 625mg', 'rx')).body.id
  ids.ctrl = (await mk('Xanax 0.5mg', 'controlled')).body.id
  assert.equal((await mk('Dup', 'otc', 0, '111')).status, 409)

  ids.supplier = (await call('POST', '/suppliers', { name: 'City Pharma' })).body.id
  const r = await call('POST', '/purchases', {
    supplier_id: ids.supplier, invoice_no: 'P-1',
    items: [
      { product_id: ids.otc, batch_no: 'late', expiry_date: inDays(400), qty: 100, cost_price: 180, sale_price: 260 },
      { product_id: ids.otc, batch_no: 'soon', expiry_date: inDays(30), qty: 10, cost_price: 180, sale_price: 250 },
      { product_id: ids.otc, batch_no: 'old', expiry_date: inDays(-5), qty: 20, cost_price: 180, sale_price: 250 },
      { product_id: ids.taxed, batch_no: 'm1', expiry_date: inDays(700), qty: 100, cost_price: 600, sale_price: 1180 },
      { product_id: ids.rx, batch_no: 'a1', expiry_date: inDays(300), qty: 12, bonus_qty: 2, cost_price: 4000, sale_price: 5000 },
      { product_id: ids.ctrl, batch_no: 'x1', expiry_date: inDays(300), qty: 30, cost_price: 500, sale_price: 700 },
    ],
  })
  assert.equal(r.status, 201)
  const p = (await call('GET', `/products/${ids.otc}`)).body
  assert.equal(p.stock, 110, 'expired batch is not sellable stock')
  assert.equal((await call('GET', `/products/barcode/111`)).body.id, ids.otc)
  assert.equal((await call('GET', `/products/${ids.rx}`)).body.stock, 14, 'bonus goods are added to stock')
})

test('sale uses FEFO, rounds to the rupee and computes inclusive GST', async () => {
  const r = await call('POST', '/sales', {
    items: [{ product_id: ids.otc, qty: 15 }, { product_id: ids.taxed, qty: 1 }],
    payment_method: 'cash', amount_paid: 10000,
  }, 'cashier')
  assert.equal(r.status, 201, JSON.stringify(r.body))
  const s = r.body
  const otcLines = s.items.filter((i) => i.product_id === ids.otc)
  assert.deepEqual(otcLines.map((i) => [i.batch_no, i.qty]), [['SOON', 10], ['LATE', 5]])
  // 10*250 + 5*260 + 1180 = 4980 paisa
  assert.equal(s.subtotal, 4980)
  assert.equal(s.total, 5000)
  assert.equal(s.round_off, 20)
  assert.equal(s.tax, 180) // 1180 includes 18% GST = 180
  assert.equal(s.change_due, 5000)
  assert.match(s.invoice_no, /^INV-\d{6}$/)
  ids.sale = s.id
})

test('insufficient stock is refused and nothing is deducted', async () => {
  const r = await call('POST', '/sales', { items: [{ product_id: ids.otc, qty: 1000 }] }, 'cashier')
  assert.equal(r.status, 409)
  assert.equal((await call('GET', `/products/${ids.otc}`)).body.stock, 95)
})

test('prescription medicines need prescription details', async () => {
  const noRx = await call('POST', '/sales', { items: [{ product_id: ids.rx, qty: 2 }] }, 'cashier')
  assert.equal(noRx.status, 400)
  const ok = await call('POST', '/sales', {
    items: [{ product_id: ids.rx, qty: 2 }], payment_method: 'card',
    prescription: { patient_name: 'Ali', prescriber_name: 'Dr. Khan' },
  }, 'cashier')
  assert.equal(ok.status, 201)
  assert.equal(ok.body.prescription.patient_name, 'Ali')
  assert.equal(ok.body.customer_name, 'Ali')
})

test('controlled drugs need a pharmacist, CNIC and PMDC number, and appear in the register', async () => {
  const rx = { patient_name: 'Sara', prescriber_name: 'Dr. Ahmed' }
  assert.equal((await call('POST', '/sales', { items: [{ product_id: ids.ctrl, qty: 5 }], prescription: rx }, 'cashier')).status, 403)
  assert.equal((await call('POST', '/sales', { items: [{ product_id: ids.ctrl, qty: 5 }], prescription: rx }, 'pharmacist')).status, 400)
  const ok = await call('POST', '/sales', {
    items: [{ product_id: ids.ctrl, qty: 5 }],
    prescription: { ...rx, patient_cnic: '35202-1234567-1', prescriber_reg_no: 'PMDC-123' },
  }, 'pharmacist')
  assert.equal(ok.status, 201)
  const reg = (await call('GET', '/reports/controlled-register')).body
  assert.deepEqual(reg.map((m) => [m.reason, m.change, m.balance]), [['purchase', 30, 30], ['sale', -5, 25]])
  assert.equal(reg[1].patient_cnic, '35202-1234567-1')
  assert.equal(reg[0].supplier_name, 'City Pharma')
})

test('cashier discount is capped', async () => {
  const r = await call('POST', '/sales', { items: [{ product_id: ids.otc, qty: 1, discount_bps: 2000 }] }, 'cashier')
  assert.equal(r.status, 403)
})

test('returns refund the charged amount and restock the batch', async () => {
  assert.equal((await call('POST', `/sales/${ids.sale}/returns`, { items: [], reason: 'x' }, 'cashier')).status, 403)
  const sale = (await call('GET', `/sales/${ids.sale}`)).body
  const line = sale.items.find((i) => i.batch_no === 'SOON')
  const over = await call('POST', `/sales/${ids.sale}/returns`, { items: [{ sale_item_id: line.id, qty: 11 }], reason: 'x' })
  assert.equal(over.status, 400)
  const r = await call('POST', `/sales/${ids.sale}/returns`, { items: [{ sale_item_id: line.id, qty: 4 }], reason: 'Wrong item' }, 'pharmacist')
  assert.equal(r.status, 201)
  assert.equal(r.body.returns[0].refund_total, 1000)
  assert.equal(r.body.items.find((i) => i.id === line.id).returned_qty, 4)
  assert.equal((await call('GET', `/products/${ids.otc}`)).body.stock, 99)
})

test('reports summarise the day', async () => {
  const s = (await call('GET', '/reports/summary')).body
  assert.equal(s.sales.invoices, 3)
  assert.equal(s.returns.total, 1000)
  assert.equal(s.net_sales, s.sales.total - 1000)
  assert.ok(s.byGstRate.find((g) => g.gst_rate_bps === 1800).tax === 180)
  const low = (await call('GET', '/reports/low-stock')).body
  assert.ok(low.some((p) => p.id === ids.rx), 'rx product (12 left, reorder 50) is low')
  const exp = (await call('GET', '/reports/expiry')).body
  assert.ok(exp.some((b) => b.batch_no === 'OLD'))
  assert.equal((await call('GET', '/reports/summary', null, 'cashier')).status, 403)
})

test('expired stock can be written off, but not increased', async () => {
  const old = (await call('GET', '/inventory/batches?status=expired')).body[0]
  assert.equal(old.batch_no, 'OLD')
  assert.equal((await call('POST', '/inventory/adjustments', { batch_id: old.id, change: 5, reason: 'expired' })).status, 400)
  const r = await call('POST', '/inventory/adjustments', { batch_id: old.id, change: -20, reason: 'expired' })
  assert.equal(r.status, 201)
  assert.equal(r.body.balance, 0)
})

test('cashiers only see their own sales', async () => {
  const mine = (await call('GET', '/sales', null, 'cashier')).body
  assert.ok(mine.length >= 2)
  assert.ok(mine.every((s) => s.cashier_name === 'cash1'))
  assert.equal((await call('GET', '/sales')).body.length, 3)
})
