import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db-node.js'
import { createApp } from '../src/app.js'
import { today } from '../src/db.js'

// Pack/loose selling, till sessions and day close.
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

const inDays = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10)
const stockOf = (batchId) => db.prepare('SELECT qty_on_hand FROM batches WHERE id = ?').get(batchId).qty_on_hand

// Batches inserted directly so these tests don't depend on the purchase entry format.
function addBatch(productId, batchNo, expiry, qty, packPrice, packSize) {
  const unit = packPrice === null ? 300 : Math.round(packPrice / packSize)
  return Number(
    db.prepare(
      `INSERT INTO batches (product_id, batch_no, expiry_date, cost_price, sale_price, qty_on_hand, pack_price, pack_size)
       VALUES (?, ?, ?, 100, ?, ?, ?, ?)`,
    ).run(productId, batchNo, expiry, unit, qty, packPrice, packSize).lastInsertRowid,
  )
}

test('setup: users and products', async () => {
  await call('POST', '/auth/setup', { username: 'owner', full_name: 'Owner', password: 'secret123' })
  tokens.admin = (await call('POST', '/auth/login', { username: 'owner', password: 'secret123' })).body.token
  for (const [u, role, key] of [['cash1', 'cashier', 'cashier'], ['cash2', 'cashier', 'cashier2'], ['pharm1', 'pharmacist', 'pharmacist']]) {
    assert.equal((await call('POST', '/users', { username: u, full_name: u, role, password: 'password1' })).status, 201)
    tokens[key] = (await call('POST', '/auth/login', { username: u, password: 'password1' })).body.token
  }
  const mk = async (body) => {
    const r = await call('POST', '/products', body)
    assert.equal(r.status, 201, JSON.stringify(r.body))
    return r.body.id
  }
  ids.strip = await mk({ name: 'Strip 14', pack_size: 14, pack_price: 22500, allow_loose: 1 })
  ids.box = await mk({ name: 'Box 10', pack_size: 10, pack_price: 10000, allow_loose: 0 })
  ids.legacy = await mk({ name: 'Legacy', sale_price: 300 })
  ids.stripA = addBatch(ids.strip, 'A', inDays(30), 31, 22500, 14)
  ids.stripB = addBatch(ids.strip, 'B', inDays(300), 100, 23800, 14)
  ids.boxA = addBatch(ids.box, 'BX', inDays(300), 50, 10000, 10)
  ids.legacyA = addBatch(ids.legacy, 'L', inDays(300), 50, null, null) // pre-migration shape
})

test('a sale needs an open till; nothing changes until one is open', async () => {
  const blocked = await call('POST', '/sales', { items: [{ product_id: ids.strip, packs: 2 }], payment_method: 'card' })
  assert.equal(blocked.status, 409)
  assert.match(blocked.body.message, /Open your till/)
  assert.equal(stockOf(ids.stripA), 31)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sales').get().n, 0)
  assert.equal((await call('GET', '/tills/current')).body.session, null)
  assert.equal((await call('POST', '/tills/current/movements', { direction: 'in', amount: 100, reason: 'x' })).status, 409)

  const open = await call('POST', '/tills/open', { opening_cash: 100000 })
  assert.equal(open.status, 201, JSON.stringify(open.body))
  assert.equal(open.body.opening_cash, 100000)
  assert.equal(open.body.business_date, today())
  assert.equal((await call('POST', '/tills/open', { opening_cash: 0 })).status, 409, 'one open till per user')
  ids.adminTill = open.body.id
})

test('whole packs are priced exactly', async () => {
  const r = await call('POST', '/sales', { items: [{ product_id: ids.strip, packs: 2 }], payment_method: 'card' })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  assert.equal(r.body.items.length, 1)
  const line = r.body.items[0]
  assert.equal(line.qty, 28)
  assert.equal(line.line_total, 45000)
  assert.equal(line.pack_size, 14)
  assert.equal(line.unit_price, Math.round(22500 / 14), 'unit price stays the per-unit batch price')
  assert.equal(r.body.subtotal, 45000)
  assert.equal(r.body.total, 45000)
  assert.equal(r.body.till_session_id, ids.adminTill)
})

test('loose units are pro rata per slice across batches', async () => {
  const r = await call('POST', '/sales', { items: [{ product_id: ids.strip, loose: 5 }], payment_method: 'card' })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  assert.deepEqual(r.body.items.map((i) => [i.batch_no, i.qty, i.line_total]), [
    ['A', 3, Math.round((3 * 22500) / 14)],
    ['B', 2, Math.round((2 * 23800) / 14)],
  ])
  assert.equal(r.body.subtotal, 4821 + 3400)
  assert.equal(stockOf(ids.stripA), 0)
  assert.equal(stockOf(ids.stripB), 98)
})

test('packs + loose and duplicate lines are merged into units', async () => {
  const r = await call('POST', '/sales', {
    items: [{ product_id: ids.strip, packs: 1, loose: 2 }, { product_id: ids.strip, loose: 1 }],
    payment_method: 'card',
  })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  assert.deepEqual(r.body.items.map((i) => [i.batch_no, i.qty, i.line_total]), [['B', 17, Math.round((17 * 23800) / 14)]])
  assert.equal(stockOf(ids.stripB), 81)
})

test('loose units are refused when the item sells in full packs only', async () => {
  assert.equal((await call('POST', '/sales', { items: [{ product_id: ids.box, loose: 3 }], payment_method: 'card' })).status, 400)
  assert.equal((await call('POST', '/sales', { items: [{ product_id: ids.box, qty: 5 }], payment_method: 'card' })).status, 400)
  assert.equal((await call('POST', '/sales', { items: [{ product_id: ids.box, packs: 0 }], payment_method: 'card' })).status, 400)
  assert.equal(stockOf(ids.boxA), 50)
  const ok = await call('POST', '/sales', { items: [{ product_id: ids.box, packs: 1, loose: 0 }], payment_method: 'card' })
  assert.equal(ok.status, 201)
  assert.equal(ok.body.items[0].line_total, 10000)
})

test('batches without pack columns still price per unit', async () => {
  const r = await call('POST', '/sales', { items: [{ product_id: ids.legacy, qty: 2 }], payment_method: 'card' })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  assert.equal(r.body.items[0].line_total, 600)
  assert.equal(r.body.items[0].pack_size, 1)
})

test('opening notes are counted and must be listed denominations', async () => {
  assert.equal((await call('POST', '/tills/open', { notes: { 3: 1 } }, 'pharmacist')).status, 400)
  assert.equal((await call('POST', '/tills/open', { notes: { 1000: -1 } }, 'pharmacist')).status, 400)
  assert.equal((await call('POST', '/tills/open', { notes: { 1000: 1.5 } }, 'pharmacist')).status, 400)
  assert.equal((await call('POST', '/tills/open', { opening_cash: -5 }, 'pharmacist')).status, 400)
  const r = await call('POST', '/tills/open', { notes: { 1000: 2, 100: 5, 50: 0 } }, 'pharmacist')
  assert.equal(r.status, 201, JSON.stringify(r.body))
  assert.equal(r.body.opening_cash, 250000)
  assert.deepEqual(r.body.opening_notes, { 1000: 2, 100: 5 })
  ids.pharmTill = r.body.id
})

test('refunds need an open till and are tied to it', async () => {
  const sale = await call('POST', '/sales', { items: [{ product_id: ids.legacy, qty: 2 }], payment_method: 'card' }, 'pharmacist')
  assert.equal(sale.status, 201)
  assert.equal(sale.body.till_session_id, ids.pharmTill)
  const cash = await call('POST', '/sales', { items: [{ product_id: ids.box, packs: 1 }], payment_method: 'cash', amount_paid: 10000 }, 'pharmacist')
  assert.equal(cash.status, 201)
  ids.pharmCardSale = sale.body

  // Cashiers can't refund at all.
  assert.equal((await call('POST', `/sales/${sale.body.id}/returns`, { items: [{ sale_item_id: sale.body.items[0].id, qty: 1 }], reason: 'x' }, 'cashier2')).status, 403)

  const r = await call('POST', `/sales/${sale.body.id}/returns`, {
    items: [{ sale_item_id: sale.body.items[0].id, qty: 1 }], reason: 'Unwanted',
  }, 'pharmacist')
  assert.equal(r.status, 201, JSON.stringify(r.body))
  assert.equal(r.body.returns[0].refund_total, 300)
  assert.equal(r.body.returns[0].till_session_id, ids.pharmTill)
})

test('a refund without an open till is refused', async () => {
  // A second pharmacist who has not opened a till.
  assert.equal((await call('POST', '/users', { username: 'pharm2', full_name: 'pharm2', role: 'pharmacist', password: 'password1' })).status, 201)
  tokens.pharm2 = (await call('POST', '/auth/login', { username: 'pharm2', password: 'password1' })).body.token
  const si = ids.pharmCardSale.items[0]
  const before = stockOf(ids.legacyA)
  const r = await call('POST', `/sales/${ids.pharmCardSale.id}/returns`, { items: [{ sale_item_id: si.id, qty: 1 }], reason: 'x' }, 'pharm2')
  assert.equal(r.status, 409)
  assert.equal(stockOf(ids.legacyA), before)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM returns').get().n, 1)
})

test('cash in/out validation and expected cash', async () => {
  assert.equal((await call('POST', '/tills/current/movements', { direction: 'in', amount: 0, reason: 'x' }, 'pharmacist')).status, 400)
  assert.equal((await call('POST', '/tills/current/movements', { direction: 'in', amount: 500 }, 'pharmacist')).status, 400)
  assert.equal((await call('POST', '/tills/current/movements', { direction: 'sideways', amount: 500, reason: 'x' }, 'pharmacist')).status, 400)
  const cin = await call('POST', '/tills/current/movements', { direction: 'in', amount: 5000, reason: 'Change from bank' }, 'pharmacist')
  assert.equal(cin.status, 201, JSON.stringify(cin.body))
  assert.equal(cin.body.till_session_id, ids.pharmTill)
  const cout = await call('POST', '/tills/current/movements', { direction: 'out', amount: 2000, reason: 'Tea', notes: { 20: 1 } }, 'pharmacist')
  assert.equal(cout.status, 201)
  assert.deepEqual(cout.body.notes, { 20: 1 })

  const cur = (await call('GET', '/tills/current', null, 'pharmacist')).body
  assert.equal(cur.session.id, ids.pharmTill)
  assert.deepEqual(
    { ...cur.totals },
    {
      opening_cash: 250000, cash_sales: 10000, card_sales: 600, wallet_sales: 0, invoices: 2, refunds: 300,
      cash_in: 5000, cash_out: 2000, expected_cash: 250000 + 10000 - 300 + 5000 - 2000,
    },
  )
})

test('closing a till records counted cash and variance', async () => {
  // Rs 2000 + Rs 600 + Rs 20 = 262000 paisa counted, 262700 expected.
  const r = await call('POST', '/tills/current/close', { notes: { 1000: 2, 100: 6, 20: 1 }, note: 'Short by 7' }, 'pharmacist')
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.status, 'closed')
  assert.equal(r.body.expected_cash, 262700)
  assert.equal(r.body.counted_cash, 262000)
  assert.equal(r.body.variance, -700)
  assert.equal(r.body.close_note, 'Short by 7')
  assert.match(r.body.closed_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  assert.equal(r.body.closed_at.slice(0, 10), today())
  assert.equal((await call('POST', '/tills/current/close', { counted_cash: 0 }, 'pharmacist')).status, 409)
  assert.equal((await call('POST', '/sales', { items: [{ product_id: ids.legacy, qty: 1 }], payment_method: 'card' }, 'pharmacist')).status, 409)
})

test('cashier sells only after opening a till', async () => {
  const before = stockOf(ids.legacyA)
  assert.equal((await call('POST', '/sales', { items: [{ product_id: ids.legacy, qty: 1 }] }, 'cashier')).status, 409)
  assert.equal(stockOf(ids.legacyA), before)
  const open = await call('POST', '/tills/open', {}, 'cashier')
  assert.equal(open.status, 201)
  assert.equal(open.body.opening_cash, 0)
  ids.cashTill = open.body.id
  const ok = await call('POST', '/sales', { items: [{ product_id: ids.legacy, qty: 1 }], payment_method: 'cash', amount_paid: 500 }, 'cashier')
  assert.equal(ok.status, 201)
  assert.equal(ok.body.till_session_id, ids.cashTill)
})

test('cashiers see only their own tills', async () => {
  const mine = (await call('GET', `/tills?date=${today()}`, null, 'cashier')).body
  assert.deepEqual(mine.map((t) => t.id), [ids.cashTill])
  assert.equal(mine[0].user_name, 'cash1')
  assert.equal(mine[0].totals.cash_sales, 300)
  assert.equal((await call('GET', `/tills/${ids.pharmTill}`, null, 'cashier')).status, 404)
  assert.equal((await call('GET', `/tills/${ids.cashTill}`, null, 'cashier')).status, 200)
  const all = (await call('GET', `/tills?date=${today()}`, null, 'pharmacist')).body
  assert.deepEqual(all.map((t) => t.id).sort(), [ids.adminTill, ids.pharmTill, ids.cashTill].sort())
  const one = (await call('GET', `/tills/${ids.pharmTill}`)).body
  assert.equal(one.session.variance, -700)
  assert.equal(one.movements.length, 2)
  assert.equal(one.totals.expected_cash, 262700)
  assert.deepEqual((await call('GET', '/tills?date=2000-01-01')).body, [])
})

test('day close waits for every till, then locks the date', async () => {
  const date = today()
  assert.equal((await call('POST', '/tills/day-close', { date }, 'cashier')).status, 403)
  const blocked = await call('POST', '/tills/day-close', { date }, 'pharmacist')
  assert.equal(blocked.status, 409)
  assert.equal((await call('GET', `/tills/day-close?date=${date}`)).body.day_close, null)

  assert.equal((await call('POST', '/tills/current/close', { counted_cash: 300 }, 'cashier')).status, 200)
  const adminClose = await call('POST', '/tills/current/close', { counted_cash: 100000 })
  assert.equal(adminClose.status, 200)
  assert.equal(adminClose.body.variance, 0, 'admin only took card payments')

  const r = await call('POST', '/tills/day-close', { date }, 'pharmacist')
  assert.equal(r.status, 201, JSON.stringify(r.body))
  const s = r.body.day_close.summary
  assert.equal(s.tills.length, 3)
  assert.equal(s.sales.count, db.prepare('SELECT COUNT(*) AS n FROM sales').get().n)
  assert.equal(s.sales.total, db.prepare('SELECT SUM(total) AS t FROM sales').get().t)
  assert.equal(s.returns.total, 300)
  assert.equal(s.totals.cash_sales, 10000 + 300)
  assert.equal(s.totals.expected_cash, 100000 + 262700 + 300)
  assert.equal(s.totals.variance, -700)

  assert.equal((await call('POST', '/tills/day-close', { date }, 'pharmacist')).status, 409)
  const got = (await call('GET', `/tills/day-close?date=${date}`, null, 'cashier')).body.day_close
  assert.equal(got.business_date, date)
  assert.equal(got.summary.tills.length, 3)
})
