import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { testStore, stopTestStore, put } from './helpers/mongo.js'
import { createApp } from '../src/app.js'
import { today } from '../src/db.js'
import { addDays } from '../src/lib/supplier-ledger.js'

// Demand lists: suggestions from real use, items not needed again, lists sent to suppliers.
let server, base, db
const tokens = {}
const ids = {}
before(async () => {
  db = await testStore()
  server = createApp(db).listen(0)
  await new Promise((r) => server.once('listening', r))
  base = `http://127.0.0.1:${server.address().port}/api`
})
after(async () => {
  server?.close()
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
const ago = (n) => `${addDays(today(), -n)} 12:00:00`
// Use recorded directly as stock movements (what sales and ward issues write).
const use = (productId, units, daysAgo, reason = 'sale') =>
  put(db, 'stock_movements', { product_id: productId, batch_id: 0, change: -units, balance: 0, reason, user_id: 1, created_at: ago(daysAgo) })

test('setup', async () => {
  await call('POST', '/auth/setup', { username: 'owner', full_name: 'Owner', password: 'secret123' })
  tokens.admin = (await call('POST', '/auth/login', { username: 'owner', password: 'secret123' })).body.token
  await call('POST', '/users', { username: 'cash1', full_name: 'Cash', role: 'cashier', password: 'password1' })
  tokens.cashier = (await call('POST', '/auth/login', { username: 'cash1', password: 'password1' })).body.token
  const mk = async (name, extra = {}) => (await call('POST', '/products', { name, pack_size: 10, pack_price: 1000, ...extra })).body.id
  ids.steady = await mk('Steady Seller', { reorder_level: 50 }) // sells 10/day, 30 in stock
  ids.idle = await mk('Old Syrup', { reorder_level: 20 })       // low, but nothing sold for months
  ids.plenty = await mk('Plenty', { reorder_level: 10 })        // sells, lots in stock
  ids.fast = await mk('Fast Mover')                             // no reorder level, runs out in 2 days
  ids.gone = await mk('Discontinued', { reorder_level: 20 })    // low and sold recently, but not needed again
  const sup = (await call('POST', '/suppliers', { name: 'Premier Agencies', phone: '0300-1234567' })).body
  ids.sup = sup.id
  const line = (product_id, packs, batch_no) => ({ product_id, batch_no, expiry_date: addDays(today(), 400), packs, pack_cost: 800 })
  const p = await call('POST', '/purchases', { supplier_id: sup.id, payment_type: 'credit', items: [
    line(ids.steady, 3, 'S1'), line(ids.idle, 1, 'O1'), line(ids.plenty, 50, 'P1'), line(ids.fast, 1, 'F1'), line(ids.gone, 1, 'G1'),
  ] })
  assert.equal(p.status, 201, JSON.stringify(p.body))
  for (let d = 1; d <= 30; d++) await use(ids.steady, 10, d)
  await use(ids.plenty, 30, 5)
  for (let d = 1; d <= 10; d++) await use(ids.fast, 5, d)
  await use(ids.gone, 2, 3)
  await use(ids.idle, 5, 200) // last sold months ago
})

test('suggestions follow real use; items not sold for 90 days are listed, not ordered', async () => {
  const r = await call('GET', '/demand/suggestions?days=30&cover_days=21')
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const by = (id) => r.body.suggestions.find((s) => s.product_id === id)
  const steady = by(ids.steady)
  assert.ok(steady, 'steady seller suggested')
  assert.equal(steady.daily, 10)
  assert.match(steady.reason, /reorder level/)
  // 21 days at 10/day = 210 units, minus 30 in stock = 180 -> 18 packs
  assert.equal(steady.suggested_packs, 18)
  assert.equal(steady.supplier_name, 'Premier Agencies')
  assert.equal(steady.last_pack_cost, 800)
  assert.equal(steady.est_cost, 18 * 800)
  assert.ok(by(ids.fast), 'fast mover suggested though it has no reorder level')
  assert.match(by(ids.fast).reason, /Runs out/)
  assert.ok(!by(ids.plenty), 'enough stock: not suggested')
  assert.ok(!by(ids.idle), 'no recent use: not suggested')
  assert.ok(r.body.idle.some((x) => x.product_id === ids.idle), 'listed as idle instead')
})

test('items marked not needed or skipped leave suggestions and low-stock alerts', async () => {
  const before = (await call('GET', '/demand/suggestions')).body.suggestions.find((s) => s.product_id === ids.gone)
  assert.ok(before, 'discontinued item is suggested before it is marked')
  assert.equal((await call('POST', '/demand/skip', { product_id: ids.gone, mode: 'never' })).status, 200)
  assert.equal((await call('POST', '/demand/skip', { product_id: ids.idle, mode: 'snooze', days: 30 })).status, 200)
  const r = await call('GET', '/demand/suggestions')
  assert.ok(!r.body.suggestions.some((s) => s.product_id === ids.gone))
  assert.ok(!r.body.idle.some((s) => s.product_id === ids.idle))
  const low = (await call('GET', '/reports/low-stock')).body
  assert.ok(!low.some((p) => p.id === ids.idle), 'snoozed item left the low-stock report')
  const nn = (await call('GET', '/demand/not-needed')).body
  assert.deepEqual(nn.map((p) => p.id).sort(), [ids.gone, ids.idle].sort())
  assert.equal((await call('POST', '/demand/skip', { product_id: ids.gone, mode: 'restore' })).status, 200)
  assert.ok((await call('GET', '/demand/suggestions')).body.suggestions.some((s) => s.product_id === ids.gone))
})

test('a demand list is created, edited as a draft, and items on it are not suggested twice', async () => {
  const bad = await call('POST', '/demand/lists', { items: [] })
  assert.equal(bad.status, 400)
  const r = await call('POST', '/demand/lists', {
    supplier_id: ids.sup, note: 'Urgent',
    items: [{ product_id: ids.steady, packs: 18, last_pack_cost: 800 }, { product_id: ids.fast, packs: 2, loose: 5 }],
  })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  assert.match(r.body.demand_no, /^DL-\d{5}$/)
  assert.equal(r.body.status, 'draft')
  assert.equal(r.body.supplier_name, 'Premier Agencies')
  assert.equal(r.body.items[1].units, 25)
  assert.equal(r.body.est_total, 18 * 800)
  ids.list = r.body.id
  const sug = (await call('GET', '/demand/suggestions')).body.suggestions
  assert.ok(!sug.some((s) => s.product_id === ids.steady), 'already on order')
  const ed = await call('PUT', `/demand/lists/${ids.list}`, { items: [{ product_id: ids.steady, packs: 10 }] })
  assert.equal(ed.status, 200)
  assert.equal(ed.body.item_count, 1)
  const list = (await call('GET', '/demand/lists')).body
  assert.equal(list[0].id, ids.list)
  assert.equal(list[0].items, undefined, 'list view is light')
})

test('status moves draft -> sent -> received; finished lists cannot be edited', async () => {
  const sent = await call('POST', `/demand/lists/${ids.list}/status`, { status: 'sent' })
  assert.equal(sent.status, 200)
  assert.ok(sent.body.sent_at)
  assert.equal((await call('PUT', `/demand/lists/${ids.list}`, { note: 'x' })).status, 409)
  assert.equal((await call('POST', `/demand/lists/${ids.list}/status`, { status: 'received' })).body.status, 'received')
  assert.equal((await call('POST', `/demand/lists/${ids.list}/status`, { status: 'sent' })).status, 409)
  // Received lists no longer count as on order.
  assert.ok((await call('GET', '/demand/suggestions')).body.suggestions.some((s) => s.product_id === ids.steady))
})

test('cashiers cannot see or make demand lists', async () => {
  assert.equal((await call('GET', '/demand/suggestions', null, 'cashier')).status, 403)
  assert.equal((await call('POST', '/demand/lists', { items: [{ product_id: ids.steady, packs: 1 }] }, 'cashier')).status, 403)
})
