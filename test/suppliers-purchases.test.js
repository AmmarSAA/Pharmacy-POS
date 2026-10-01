import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db-node.js'
import { createApp } from '../src/app.js'
import { today } from '../src/db.js'

// Supplier credit (ledger, payments, dues) and pack-based purchases.

let server, base, db
const tokens = {}
const ids = {}

before(async () => {
  db = openDb(':memory:')
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

// Server's business date plus n days (UTC arithmetic on the date string).
const d = (n) => {
  const t = today()
  return new Date(Date.UTC(+t.slice(0, 4), +t.slice(5, 7) - 1, +t.slice(8, 10)) + n * 864e5).toISOString().slice(0, 10)
}

test('setup users, products and suppliers', async () => {
  assert.equal((await call('POST', '/auth/setup', { username: 'owner', full_name: 'Owner', password: 'secret123' })).status, 201)
  tokens.admin = (await call('POST', '/auth/login', { username: 'owner', password: 'secret123' })).body.token
  assert.equal((await call('POST', '/users', { username: 'cash1', full_name: 'Cash One', role: 'cashier', password: 'password1' })).status, 201)
  tokens.cashier = (await call('POST', '/auth/login', { username: 'cash1', password: 'password1' })).body.token
  assert.equal((await call('PUT', '/owner/settings', { require_open_till: '0', current_password: 'secret123' })).status, 200)

  ids.priced = (await call('POST', '/products', { name: 'Brufen 400', pack_size: 10, pack_price: 1200 })).body.id
  ids.unpriced = (await call('POST', '/products', { name: 'Flagyl 400', pack_size: 10, sale_price: 0 })).body.id
  ids.legacy = (await call('POST', '/products', { name: 'ORS', sale_price: 50 })).body.id

  const s1 = await call('POST', '/suppliers', {
    name: 'Muller Distributors', due_days: 30, opening_balance: 50000, opening_date: d(-100),
    contact_person: 'Asif', email: 'asif@example.com',
  })
  assert.equal(s1.status, 201, JSON.stringify(s1.body))
  assert.equal(s1.body.due_days, 30)
  assert.equal(s1.body.active, 1)
  assert.equal(s1.body.balance, 50000)
  ids.s1 = s1.body.id
  ids.s2 = (await call('POST', '/suppliers', { name: 'Cash Wholesale' })).body.id
})

test('supplier validation and partial update', async () => {
  assert.equal((await call('POST', '/suppliers', { name: 'X', due_days: 400 })).status, 400)
  assert.equal((await call('POST', '/suppliers', { name: 'X', due_days: -1 })).status, 400)
  const neg = await call('POST', '/suppliers', { name: 'X', opening_balance: -5 })
  assert.equal(neg.status, 400)
  assert.match(neg.body.message, /Opening balance/)
  assert.equal((await call('POST', '/suppliers', { name: 'X', email: 'nope' })).status, 400)
  assert.equal((await call('POST', '/suppliers', { due_days: 5 })).status, 400)

  const u = await call('PUT', `/suppliers/${ids.s2}`, { phone: '0300-1234567', active: false })
  assert.equal(u.status, 200)
  assert.equal(u.body.name, 'Cash Wholesale')
  assert.equal(u.body.phone, '0300-1234567')
  assert.equal(u.body.active, 0)
  assert.equal((await call('PUT', `/suppliers/${ids.s2}`, { active: true })).body.active, 1)
  assert.equal((await call('PUT', '/suppliers/9999', { name: 'Y' })).status, 404)
})

test('pack line: packs + loose, bonus, discount, cost incl. bonus, default margin price, due date', async () => {
  const r = await call('POST', '/purchases', {
    supplier_id: ids.s1, invoice_no: 'MD-1', invoice_date: d(-70),
    items: [{ product_id: ids.unpriced, batch_no: 'f1', expiry_date: d(500), packs: 2, loose_qty: 5, bonus_qty: 5,
      pack_cost: 1000, discount_bps: 1000 }],
  })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  const p = r.body
  ids.p1 = p.id
  // 25 units at 1000 per 10 = 2500 gross, 10% off = 250, net 2250
  assert.equal(p.gross, 2500)
  assert.equal(p.discount, 250)
  assert.equal(p.total, 2250)
  assert.equal(p.payment_type, 'credit')
  assert.equal(p.due_date, d(-40))
  const it = p.items[0]
  assert.equal(it.packs, 2)
  assert.equal(it.loose_qty, 5)
  assert.equal(it.bonus_qty, 5)
  assert.equal(it.pack_cost, 1000)
  assert.equal(it.discount_bps, 1000)
  assert.equal(it.pack_size, 10)
  assert.equal(it.qty, 30, 'received units include bonus')
  assert.equal(it.cost_price, 75, '2250 / 30 units')
  assert.equal(it.line_total, 2250)
  // Net cost per pack 900; 15% margin -> 900 / 0.85 = 1058.8 -> 1059
  assert.equal(it.pack_price, 1059)
  assert.equal(it.sale_price, 106)

  const batch = db.prepare('SELECT * FROM batches WHERE id = ?').get(it.batch_id)
  assert.equal(batch.pack_price, 1059)
  assert.equal(batch.pack_size, 10)
  assert.equal(batch.cost_price, 75)
  assert.equal(batch.qty_on_hand, 30)
  const product = (await call('GET', `/products/${ids.unpriced}`)).body
  assert.equal(product.pack_price, 1059)
  assert.equal(product.sale_price, 106)
  assert.equal(product.stock, 30)
  const move = db.prepare("SELECT * FROM stock_movements WHERE batch_id = ? AND reason = 'purchase'").get(it.batch_id)
  assert.equal(move.change, 30)
  assert.equal(move.ref_id, p.id)
  assert.match(move.note, /5 bonus/)
})

test('pack price falls back to the product price, and a given pack price updates the product', async () => {
  const r = await call('POST', '/purchases', {
    supplier_id: ids.s1, invoice_no: 'MD-2', invoice_date: d(-10),
    items: [{ product_id: ids.priced, batch_no: 'b1', expiry_date: d(400), packs: 5, pack_cost: 1000 }],
  })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  ids.p2 = r.body.id
  assert.equal(r.body.total, 5000)
  assert.equal(r.body.due_date, d(20))
  assert.equal(r.body.items[0].pack_price, 1200)

  const again = await call('POST', '/purchases', {
    supplier_id: ids.s2, payment_type: 'cash',
    items: [{ product_id: ids.priced, batch_no: 'b1', expiry_date: d(400), packs: 1, pack_cost: 1000, pack_price: 1300 }],
  })
  assert.equal(again.status, 201, JSON.stringify(again.body))
  ids.p3 = again.body.id
  assert.equal(again.body.items[0].batch_id, r.body.items[0].batch_id, 'same batch is topped up')
  const product = (await call('GET', `/products/${ids.priced}`)).body
  assert.equal(product.pack_price, 1300)
  assert.equal(product.sale_price, 130)
  assert.equal(product.stock, 60)
})

test('cash purchase records its payment and the ledger nets to zero', async () => {
  const p = (await call('GET', `/purchases/${ids.p3}`)).body
  assert.equal(p.payment_type, 'cash')
  assert.equal(p.due_date, today())
  assert.equal(p.paid, 1000)
  const pays = (await call('GET', `/suppliers/payments?supplier_id=${ids.s2}`)).body
  assert.equal(pays.length, 1)
  assert.equal(pays[0].amount, 1000)
  assert.equal(pays[0].method, 'cash')
  assert.equal(pays[0].purchase_id, ids.p3)
  assert.equal(pays[0].supplier_name, 'Cash Wholesale')
  const l = (await call('GET', `/suppliers/${ids.s2}/ledger`)).body
  assert.deepEqual(l.entries.map((e) => [e.type, e.debit, e.credit, e.balance]), [['purchase', 1000, 0, 1000], ['payment', 0, 1000, 0]])
  assert.equal(l.balance, 0)
})

test('legacy unit lines still work', async () => {
  const r = await call('POST', '/purchases', {
    supplier_id: ids.s2, payment_type: 'cash', payment_method: 'bank',
    items: [{ product_id: ids.legacy, batch_no: 'o1', expiry_date: d(300), qty: 10, cost_price: 30, sale_price: 55 }],
  })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  assert.equal(r.body.total, 300)
  assert.equal(r.body.items[0].sale_price, 55)
  assert.equal(r.body.items[0].cost_price, 30)
  assert.equal((await call('GET', `/products/${ids.legacy}`)).body.sale_price, 55)
  const pays = (await call('GET', `/suppliers/payments?supplier_id=${ids.s2}`)).body
  assert.equal(pays[0].method, 'bank')
  assert.equal((await call('GET', `/suppliers/${ids.s2}/ledger`)).body.balance, 0)
})

test('purchase validation', async () => {
  const base = { supplier_id: ids.s1, invoice_date: d(-1) }
  const line = { product_id: ids.priced, batch_no: 'v1', expiry_date: d(300), packs: 1, pack_cost: 100 }
  const bad = async (body, status, re) => {
    const r = await call('POST', '/purchases', { ...base, ...body })
    assert.equal(r.status, status, JSON.stringify(r.body))
    if (re) assert.match(r.body.message, re)
  }
  await bad({ items: [] }, 400, /at least one/)
  await bad({ items: [line, { ...line, batch_no: '' }] }, 400, /^Line 2: batch number/)
  await bad({ items: [{ ...line, packs: 0 }] }, 400, /^Line 1: enter the number of packs/)
  await bad({ items: [{ ...line, pack_cost: undefined }] }, 400, /^Line 1: pack cost/)
  await bad({ items: [{ ...line, discount_bps: 20000 }] }, 400, /^Line 1: discount/)
  await bad({ items: [{ ...line, bonus_qty: -1 }] }, 400, /^Line 1: bonus/)
  await bad({ items: [{ ...line, product_id: 9999 }] }, 400, /^Line 1: product not found/)
  await bad({ items: [{ ...line, expiry_date: 'soon' }] }, 400, /^Line 1: expiry date/)
  await bad({ payment_type: 'later', items: [line] }, 400, /Payment type/)
  await bad({ payment_type: 'cash', payment_method: 'cheque', items: [line] }, 400, /Payment method/)
  await bad({ items: [{ ...line, batch_no: 'b1', expiry_date: d(100) }] }, 409, /already recorded with expiry/)
  await bad({ supplier_id: 9999, items: [line] }, 404)
  // Till payment needs an open till even though the till is not required for sales here.
  await bad({ payment_type: 'cash', payment_method: 'till', items: [line] }, 409, /Open your till/)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM batches WHERE batch_no = 'V1'").get().n, 0, 'nothing was saved')
})

test('supplier payments: validation, bank and till', async () => {
  const pay = (body, as) => call('POST', `/suppliers/${ids.s1}/payments`, body, as)
  const zero = await pay({ amount: 0, method: 'cash' })
  assert.equal(zero.status, 400)
  assert.match(zero.body.message, /more than 0/)
  assert.equal((await pay({ amount: -10, method: 'cash' })).status, 400)
  assert.equal((await pay({ amount: 100, method: 'card' })).status, 400)
  assert.equal((await pay({ amount: 100, purchase_id: ids.p3 })).status, 400, 'purchase of another supplier')
  assert.equal((await call('POST', '/suppliers/9999/payments', { amount: 100 })).status, 404)

  const bank = await pay({ amount: 30000, method: 'bank', reference: 'TRX-9', paid_on: d(-5) })
  assert.equal(bank.status, 201, JSON.stringify(bank.body))
  assert.equal(bank.body.paid_on, d(-5))
  assert.equal(bank.body.till_session_id, null)

  const noTill = await pay({ amount: 2000, method: 'till' })
  assert.equal(noTill.status, 409)
  const adminId = db.prepare("SELECT id FROM users WHERE username = 'owner'").get().id
  const tillId = Number(db.prepare('INSERT INTO till_sessions (user_id, business_date, opening_cash) VALUES (?, ?, ?)')
    .run(adminId, today(), 10000).lastInsertRowid)
  const till = await pay({ amount: 2000, method: 'till', note: 'Part payment' })
  assert.equal(till.status, 201, JSON.stringify(till.body))
  assert.equal(till.body.paid_on, today())
  assert.equal(till.body.till_session_id, tillId)
  const mv = db.prepare('SELECT * FROM cash_movements WHERE supplier_payment_id = ?').get(till.body.id)
  assert.ok(mv, 'cash movement recorded')
  assert.equal(mv.direction, 'out')
  assert.equal(mv.amount, 2000)
  assert.equal(mv.till_session_id, tillId)
  assert.equal(mv.reason, 'Payment to Muller Distributors')

  const list = (await call('GET', `/suppliers/payments?from=${d(-6)}&to=${d(-4)}`)).body
  assert.deepEqual(list.map((p) => p.amount), [30000])
})

test('ledger runs the balance from the opening balance', async () => {
  const l = (await call('GET', `/suppliers/${ids.s1}/ledger`)).body
  assert.equal(l.supplier.name, 'Muller Distributors')
  assert.deepEqual(
    l.entries.map((e) => [e.date, e.type, e.debit, e.credit, e.balance]),
    [
      [d(-100), 'opening', 50000, 0, 50000],
      [d(-70), 'purchase', 2250, 0, 52250],
      [d(-10), 'purchase', 5000, 0, 57250],
      [d(-5), 'payment', 0, 30000, 27250],
      [today(), 'payment', 0, 2000, 25250],
    ],
  )
  assert.equal(l.entries[1].ref, 'MD-1')
  assert.equal(l.balance, 25250)

  const part = (await call('GET', `/suppliers/${ids.s1}/ledger?from=${d(-20)}&to=${d(-1)}`)).body
  assert.deepEqual(part.entries.map((e) => [e.type, e.debit, e.credit, e.balance]), [
    ['opening', 52250, 0, 52250],
    ['purchase', 5000, 0, 57250],
    ['payment', 0, 30000, 27250],
  ])
  assert.equal(part.balance, 27250)
  assert.equal((await call('GET', `/suppliers/${ids.s1}/ledger?from=bad`)).status, 400)
})

test('dues report ages unpaid bills, oldest settled first', async () => {
  // Bills: opening 50000 (dated d-100, due d-70 on 30-day terms), MD-1 2250 (due d-40), MD-2 5000 (due d+20).
  // Paid 32000 -> opening left 18000.
  const rows = (await call('GET', '/reports/supplier-dues')).body
  const s1 = rows.find((r) => r.supplier_id === ids.s1)
  assert.deepEqual(s1, {
    supplier_id: ids.s1, name: 'Muller Distributors', due_days: 30, balance: 25250,
    not_due: 5000, d1_30: 0, d31_60: 2250, d61_90: 18000, d90_plus: 0, overdue: 20250, oldest_unpaid_date: d(-100),
  })
  // Owner policy "opening balance due immediately": due on its own date, 100 days ago.
  db.prepare("UPDATE settings SET value = 'immediate' WHERE key = 'opening_balance_due'").run()
  const immediate = (await call('GET', '/reports/supplier-dues')).body.find((r) => r.supplier_id === ids.s1)
  assert.deepEqual([immediate.d61_90, immediate.d90_plus], [0, 18000])
  db.prepare("UPDATE settings SET value = 'terms' WHERE key = 'opening_balance_due'").run()
  const s2 = rows.find((r) => r.supplier_id === ids.s2)
  assert.equal(s2.balance, 0)
  assert.equal(s2.overdue, 0)
  assert.equal(s2.oldest_unpaid_date, null)
  assert.equal(rows[0].supplier_id, ids.s1, 'most overdue first')
  assert.ok(!(await call('GET', '/reports/supplier-dues?owing=1')).body.some((r) => r.supplier_id === ids.s2))

  const list = (await call('GET', '/suppliers')).body
  const row = list.find((s) => s.id === ids.s1)
  assert.equal(row.balance, 25250)
  assert.equal(row.overdue, 20250)
  assert.equal((await call('GET', `/suppliers/${ids.s1}`)).body.balance, 25250)

  // Paying off the rest clears the overdue amount, oldest first.
  await call('POST', `/suppliers/${ids.s1}/payments`, { amount: 20250, method: 'cheque', reference: 'CHQ-1' })
  const after = (await call('GET', '/reports/supplier-dues')).body.find((r) => r.supplier_id === ids.s1)
  assert.equal(after.overdue, 0)
  assert.equal(after.not_due, 5000)
  assert.equal(after.oldest_unpaid_date, d(-10))
})

test('due date follows supplier terms; zero terms are due on the invoice date', async () => {
  const r = await call('POST', '/purchases', {
    supplier_id: ids.s2, invoice_date: d(-3),
    items: [{ product_id: ids.priced, batch_no: 'z1', expiry_date: d(300), packs: 1, pack_cost: 500 }],
  })
  assert.equal(r.status, 201)
  assert.equal(r.body.due_date, d(-3))
  const s2 = (await call('GET', '/reports/supplier-dues')).body.find((x) => x.supplier_id === ids.s2)
  assert.equal(s2.d1_30, 500)
  assert.equal(s2.overdue, 500)
})

test('cashiers cannot reach suppliers, purchases, payments or dues', async () => {
  assert.equal((await call('GET', '/suppliers', null, 'cashier')).status, 403)
  assert.equal((await call('GET', `/suppliers/${ids.s1}/ledger`, null, 'cashier')).status, 403)
  assert.equal((await call('GET', '/suppliers/payments', null, 'cashier')).status, 403)
  assert.equal((await call('POST', `/suppliers/${ids.s1}/payments`, { amount: 100 }, 'cashier')).status, 403)
  assert.equal((await call('POST', '/purchases', { supplier_id: ids.s1, items: [] }, 'cashier')).status, 403)
  assert.equal((await call('GET', '/reports/supplier-dues', null, 'cashier')).status, 403)
})
