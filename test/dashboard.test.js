import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db-node.js'
import { createApp } from '../src/app.js'
import { today } from '../src/db.js'
import { addDays } from '../src/lib/supplier-ledger.js'

// Role-based home dashboard: what each role receives and that the numbers match the data.
let server, base, db
const tokens = {}
const ids = {}
const t = today()

before(async () => {
  db = openDb(':memory:')
  server = createApp(db).listen(0)
  await new Promise((r) => server.once('listening', r))
  base = `http://127.0.0.1:${server.address().port}/api`
})
after(() => server?.close())

async function call(method, path, body, as = 'owner') {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(tokens[as] ? { authorization: `Bearer ${tokens[as]}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, body: await res.json() }
}
const dash = async (as) => {
  const r = await call('GET', '/dashboard', null, as)
  assert.equal(r.status, 200, JSON.stringify(r.body))
  return r.body
}

const addProduct = (name, packPrice, reorder = 0) =>
  Number(db.prepare('INSERT INTO products (name, pack_size, pack_price, sale_price, reorder_level) VALUES (?, 10, ?, ?, ?)')
    .run(name, packPrice, Math.round(packPrice / 10), reorder).lastInsertRowid)
const addBatch = (productId, no, expiry, qty, packPrice) =>
  db.prepare(
    `INSERT INTO batches (product_id, batch_no, expiry_date, cost_price, sale_price, qty_on_hand, pack_price, pack_size)
     VALUES (?, ?, ?, 40, ?, ?, ?, 10)`,
  ).run(productId, no, expiry, Math.round(packPrice / 10), qty, packPrice)
const inDays = (n) => addDays(t, n)

test('setup: users, products, stock, sales, supplier', async () => {
  await call('POST', '/auth/setup', { username: 'owner', full_name: 'Owner', password: 'secret123' })
  tokens.owner = (await call('POST', '/auth/login', { username: 'owner', password: 'secret123' })).body.token
  for (const [u, role] of [['admin2', 'admin'], ['pharm1', 'pharmacist'], ['cash1', 'cashier'], ['cash2', 'cashier']]) {
    const r = await call('POST', '/users', { username: u, full_name: u, role, password: 'password1' })
    assert.equal(r.status, 201)
    ids[u] = r.body.id
    tokens[u] = (await call('POST', '/auth/login', { username: u, password: 'password1' })).body.token
  }

  ids.a = addProduct('Alpha', 1000, 50)     // low: 30 units in date, reorder 50
  ids.b = addProduct('Bravo', 2000, 5)      // not low
  ids.c = addProduct('Charlie', 1500, 3)    // low: no stock at all
  ids.u1 = addProduct('Unpriced none', 0)   // unpriced, no stock
  ids.u2 = addProduct('Unpriced stock', 0)  // unpriced, in stock
  addBatch(ids.a, 'A1', inDays(30), 20, 1000)   // near expiry
  addBatch(ids.a, 'A2', inDays(200), 10, 1000)
  addBatch(ids.a, 'AX', inDays(-5), 5, 1000)    // expired
  addBatch(ids.b, 'B1', inDays(300), 100, 2000)
  addBatch(ids.u2, 'U1', inDays(400), 10, 0)

  // Cashier: till with Rs 500, one cash sale of a pack of Alpha (Rs 10).
  assert.equal((await call('POST', '/tills/open', { opening_cash: 50000 }, 'cash1')).status, 201)
  const s1 = await call('POST', '/sales', { items: [{ product_id: ids.a, packs: 1 }], payment_method: 'cash' }, 'cash1')
  assert.equal(s1.status, 201, JSON.stringify(s1.body))
  // Pharmacist: card sale of two packs of Bravo (Rs 40).
  assert.equal((await call('POST', '/tills/open', { opening_cash: 0 }, 'pharm1')).status, 201)
  const s2 = await call('POST', '/sales', { items: [{ product_id: ids.b, packs: 2 }], payment_method: 'card' }, 'pharm1')
  assert.equal(s2.status, 201, JSON.stringify(s2.body))

  // Earlier days, inserted directly.
  const old = db.prepare(
    `INSERT INTO sales (invoice_no, user_id, subtotal, discount, tax, total, payment_method, amount_paid, created_at)
     VALUES (?, ?, ?, 0, 0, ?, 'cash', ?, ?)`,
  )
  old.run('Y-1', ids.cash1, 5000, 5000, 5000, `${inDays(-1)} 10:00:00`)
  old.run('Y-2', ids.cash2, 7000, 7000, 7000, `${inDays(-1)} 18:30:00`)
  old.run('D3', ids.cash1, 2000, 2000, 2000, `${inDays(-3)} 09:00:00`)
  old.run('D9', ids.cash1, 9900, 9900, 9900, `${inDays(-9)} 09:00:00`) // outside the 7-day window

  // Supplier with an overdue opening balance of Rs 1000.
  db.prepare('INSERT INTO suppliers (name, opening_balance, opening_date, due_days) VALUES (?, ?, ?, 30)').run('Supplier A', 100000, inDays(-60))
})

test('cashier gets only own till and sales, no store-wide money', async () => {
  const d = await dash('cash1')
  assert.equal(d.role, 'cashier')
  assert.equal(d.date, t)
  for (const k of ['sales_today', 'sales_yesterday', 'gross_profit_today', 'stock_value', 'supplier_dues', 'cash_in_open_tills', 'alerts', 'issues_today']) {
    assert.ok(!(k in d.cards), `cashier must not get ${k}`)
  }
  const json = JSON.stringify(d)
  for (const k of ['stock_value', 'supplier_dues', 'gross_profit', 'recent_audit', 'sales_7d', 'top_products']) assert.ok(!json.includes(k), k)
  assert.deepEqual(d.charts, {})

  assert.deepEqual(d.cards.my_sales_today, { invoices: 1, total: 1000 })
  assert.equal(d.cards.my_till.session.user_id, ids.cash1)
  assert.equal(d.cards.my_till.totals.expected_cash, 50000 + 1000)
  // Own sales only, newest first.
  assert.deepEqual(d.lists.recent_sales.map((s) => s.invoice_no).slice(1), ['Y-1', 'D3', 'D9'])
  assert.ok(d.lists.recent_sales.every((s) => s.cashier_name === 'cash1'))
  assert.equal(d.lists.recent_sales.length, 4)

  const other = await dash('cash2')
  assert.equal(other.cards.my_till, null)
  assert.deepEqual(other.cards.my_sales_today, { invoices: 0, total: 0 })
  assert.deepEqual(other.lists.recent_sales.map((s) => s.invoice_no), ['Y-2'])
})

test('pharmacist gets sales and stock alerts but no profit, dues or stock value', async () => {
  const d = await dash('pharm1')
  assert.equal(d.role, 'pharmacist')
  for (const k of ['gross_profit_today', 'stock_value', 'supplier_dues', 'cash_in_open_tills']) assert.ok(!(k in d.cards), k)
  const json = JSON.stringify(d)
  for (const k of ['stock_value', 'supplier_dues', 'gross_profit', 'recent_audit']) assert.ok(!json.includes(k), k)

  assert.deepEqual(d.cards.sales_today, { invoices: 2, total: 1000 + 4000, prescriptions: 0, controlled: 0 })
  assert.deepEqual(d.cards.my_sales_today, { invoices: 1, total: 4000 })
  assert.equal(d.cards.alerts.low_stock, 2)
  assert.equal(d.cards.alerts.near_expiry, 1)
  assert.equal(d.cards.alerts.expired, 1)
  assert.equal(d.cards.alerts.unpriced_items, 2)
  assert.equal(d.cards.alerts.unpriced_in_stock, 1)
  assert.equal(d.cards.open_requisitions, 0)
  assert.deepEqual(d.lists.low_stock.map((p) => [p.name, p.stock]), [['Charlie', 0], ['Alpha', 20]])
  assert.deepEqual(d.lists.expiring_soon.map((b) => [b.batch_no, b.qty_on_hand, b.days_to_expiry]), [['A1', 10, 30]])
  // Supervisors see the latest sales from everyone.
  assert.equal(d.lists.recent_sales.length, 6)
})

test('admin gets everything except the audit; numbers match reports', async () => {
  const d = await dash('admin2')
  assert.equal(d.role, 'admin')
  assert.equal(d.is_owner, false)
  assert.ok(!('recent_audit' in d.lists))
  assert.deepEqual(d.cards.sales_today, { invoices: 2, total: 5000, prescriptions: 0, controlled: 0 })
  assert.deepEqual(d.cards.sales_yesterday, { invoices: 2, total: 12000 })

  const summary = (await call('GET', `/reports/summary?from=${t}&to=${t}`)).body
  assert.equal(d.cards.gross_profit_today, summary.gross_profit)
  const val = (await call('GET', '/reports/stock-valuation')).body
  assert.deepEqual(d.cards.stock_value, { cost: val.cost_value, retail: val.retail_value })
  assert.deepEqual(d.cards.supplier_dues, { balance: 100000, overdue: 100000, suppliers_overdue: 1 })
  assert.deepEqual(d.cards.cash_in_open_tills, { tills: 2, expected_cash: 51000 })
  assert.deepEqual(d.cards.issues_today, { count: 0, cost: 0 })

  const s7 = d.charts.sales_7d
  assert.equal(s7.length, 7)
  assert.deepEqual(s7.map((x) => x.day), [6, 5, 4, 3, 2, 1, 0].map((n) => inDays(-n)))
  assert.deepEqual(s7.map((x) => x.total), [0, 0, 0, 2000, 0, 12000, 5000])
  assert.deepEqual(s7.map((x) => x.invoices), [0, 0, 0, 1, 0, 2, 1 + 1])
  assert.deepEqual(d.lists.top_products_today.map((p) => [p.name, p.revenue]), [['Bravo', 4000], ['Alpha', 1000]])
})

test('owner also gets recent audit entries', async () => {
  const d = await dash('owner')
  assert.equal(d.is_owner, true)
  assert.ok(Array.isArray(d.lists.recent_audit))
  assert.ok(d.lists.recent_audit.length >= 1 && d.lists.recent_audit.length <= 5)
  assert.equal(d.lists.recent_audit[0].action, 'user.create')
  assert.equal(typeof d.lists.recent_audit[0].detail, 'object')
  assert.ok(d.cards.stock_value && d.charts.sales_7d)
})

test('a brand-new day with no data still returns a full shape', async () => {
  const empty = openDb(':memory:')
  const srv = createApp(empty).listen(0)
  await new Promise((r) => srv.once('listening', r))
  try {
    const b = `http://127.0.0.1:${srv.address().port}/api`
    await fetch(b + '/auth/setup', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'o', full_name: 'O', password: 'secret123' }) })
    const tok = (await (await fetch(b + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'o', password: 'secret123' }) })).json()).token
    const d = await (await fetch(b + '/dashboard', { headers: { authorization: `Bearer ${tok}` } })).json()
    assert.equal(d.charts.sales_7d.length, 7)
    assert.ok(d.charts.sales_7d.every((x) => x.total === 0 && x.invoices === 0))
    assert.deepEqual(d.cards.alerts, { low_stock: 0, near_expiry: 0, expired: 0, unpriced_items: 0, unpriced_in_stock: 0, near_expiry_days: 90 })
    assert.equal(d.cards.gross_profit_today, 0)
    assert.deepEqual(d.lists.recent_sales, [])
  } finally {
    srv.close()
  }
})
