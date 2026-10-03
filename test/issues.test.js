import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { testStore, stopTestStore, put } from './helpers/mongo.js'
import { createApp } from '../src/app.js'

// Department issues: requests, FEFO issuing at cost, returns, reports.
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

const inDays = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10)
const stockOf = async (id) => (await db.get('batches', id)).qty_on_hand
const addBatch = (productId, no, expiry, qty, cost) =>
  put(db, 'batches', { product_id: productId, batch_no: no, expiry_date: expiry, cost_price: cost, sale_price: cost * 2, qty_on_hand: qty, pack_size: 10 })

test('setup', async () => {
  await call('POST', '/auth/setup', { username: 'owner', full_name: 'Owner', password: 'secret123' })
  tokens.admin = (await call('POST', '/auth/login', { username: 'owner', password: 'secret123' })).body.token
  for (const [u, role] of [['cash1', 'cashier'], ['pharm1', 'pharmacist']]) {
    await call('POST', '/users', { username: u, full_name: u, role, password: 'password1' })
    tokens[role] = (await call('POST', '/auth/login', { username: u, password: 'password1' })).body.token
  }
  const mk = async (body) => (await call('POST', '/products', body)).body.id
  ids.para = await mk({ name: 'Paracetamol', pack_size: 10, pack_price: 1000, allow_loose: 1 })
  ids.box = await mk({ name: 'Boxed', pack_size: 10, pack_price: 1000, allow_loose: 0 })
  ids.morph = await mk({ name: 'Morphine', pack_size: 10, pack_price: 5000, allow_loose: 1, schedule: 'controlled' })
  ids.expired = await addBatch(ids.para, 'OLD', inDays(-5), 50, 10)
  ids.b1 = await addBatch(ids.para, 'B1', inDays(30), 20, 50)
  ids.b2 = await addBatch(ids.para, 'B2', inDays(200), 100, 60)
  ids.mb = await addBatch(ids.morph, 'M1', inDays(200), 30, 400)
  ids.boxb = await addBatch(ids.box, 'X1', inDays(200), 5, 70)
})

test('departments: CRUD, duplicates, roles', async () => {
  const ot = await call('POST', '/departments', { name: 'OT', incharge: 'Dr A' }, 'pharmacist')
  assert.equal(ot.status, 201)
  ids.ot = ot.body.id
  assert.equal((await call('POST', '/departments', { name: 'ot' })).status, 409)
  assert.equal((await call('POST', '/departments', { name: ' ' })).status, 400)
  ids.er = (await call('POST', '/departments', { name: 'Emergency' })).body.id
  assert.equal((await call('POST', '/departments', { name: 'OT' }, 'cashier')).status, 403)
  assert.equal((await call('PUT', `/departments/${ids.er}`, { name: 'OT' })).status, 409)
  const put = await call('PUT', `/departments/${ids.er}`, { name: 'ER', active: 0 })
  assert.equal(put.body.active, 0)
  assert.equal((await call('GET', '/departments', null, 'cashier')).body.length, 1)
  assert.equal((await call('GET', '/departments?all=1', null, 'cashier')).body.length, 2)
  await call('PUT', `/departments/${ids.er}`, { active: 1 })
  assert.equal((await call('GET', '/issues', null, 'cashier')).status, 403)
  assert.equal((await call('GET', '/issue-requests', null, 'cashier')).status, 403)
})

test('request create, list and get; issue FEFO with cost and status', async () => {
  const bad = await call('POST', '/issue-requests', { department_id: ids.ot, items: [{ product_id: ids.box, loose: 3 }] })
  assert.equal(bad.status, 400)
  const rq = await call('POST', '/issue-requests', {
    department_id: ids.ot, requested_by: 'Sister B',
    items: [{ product_id: ids.para, packs: 3, loose: 5 }, { product_id: ids.para, qty: 5 }],
  })
  assert.equal(rq.status, 201)
  assert.equal(rq.body.items.length, 1)
  assert.equal(rq.body.items[0].qty_requested, 40)
  assert.equal(rq.body.items[0].stock, 120)
  assert.equal(rq.body.status, 'open')
  ids.rq = rq.body.id
  assert.equal((await call('GET', `/issue-requests?status=open&department_id=${ids.ot}`)).body.length, 1)
  assert.equal((await call('GET', `/issue-requests/${ids.rq}`)).body.items[0].pack_size, 10)

  // 25 units: 20 from B1 (cost 50), 5 from B2 (cost 60); expired batch skipped
  const iss = await call('POST', '/issues', { department_id: ids.ot, request_id: ids.rq, items: [{ product_id: ids.para, qty: 25 }] }, 'pharmacist')
  assert.equal(iss.status, 201, JSON.stringify(iss.body))
  assert.equal(iss.body.issue_no, `ISS-${String(iss.body.id).padStart(6, '0')}`)
  assert.equal(iss.body.items.length, 2)
  assert.deepEqual(iss.body.items.map((i) => [i.batch_no, i.qty, i.unit_cost, i.line_cost]), [['B1', 20, 50, 1000], ['B2', 5, 60, 300]])
  assert.equal(iss.body.total_cost, 1300)
  assert.equal(await stockOf(ids.b1), 0)
  assert.equal(await stockOf(ids.b2), 95)
  assert.equal(await stockOf(ids.expired), 50)
  ids.issue1 = iss.body.id
  let req = (await call('GET', `/issue-requests/${ids.rq}`)).body
  assert.equal(req.status, 'partial')
  assert.equal(req.items[0].qty_issued, 25)

  const iss2 = await call('POST', '/issues', { department_id: ids.ot, request_id: ids.rq, items: [{ product_id: ids.para, qty: 20 }] })
  assert.equal(iss2.status, 201)
  req = (await call('GET', `/issue-requests/${ids.rq}`)).body
  assert.equal(req.status, 'closed')
  assert.equal(req.items[0].qty_issued, 45) // over-issue allowed
  assert.equal((await call('POST', '/issues', { department_id: ids.ot, request_id: ids.rq, items: [{ product_id: ids.para, qty: 1 }] })).status, 409)

  const mv = await db.all('stock_movements', { reason: 'issue', ref_id: ids.issue1 }, { sort: { id: 1 } })
  assert.equal(mv.length, 2)
  assert.equal(mv[0].change, -20)
  assert.equal(mv[0].note, 'OT')
  assert.equal(mv[0].balance, 0)
})

test('request item must belong to request; cancelled request', async () => {
  const a = await call('POST', '/issue-requests', { department_id: ids.ot, items: [{ product_id: ids.para, qty: 5 }] })
  const b = await call('POST', '/issue-requests', { department_id: ids.ot, items: [{ product_id: ids.para, qty: 5 }] })
  const wrong = await call('POST', '/issues', {
    department_id: ids.ot, request_id: a.body.id, items: [{ product_id: ids.para, qty: 1, request_item_id: b.body.items[0].id }],
  })
  assert.equal(wrong.status, 400)
  assert.equal((await call('POST', `/issue-requests/${a.body.id}/cancel`)).body.status, 'cancelled')
  const c = await call('POST', '/issues', { department_id: ids.ot, request_id: a.body.id, items: [{ product_id: ids.para, qty: 1 }] })
  assert.equal(c.status, 409)
})

test('short stock 409 writes nothing', async () => {
  const before = await db.col('issues').countDocuments()
  const short = await call('POST', '/issues', { department_id: ids.ot, items: [{ product_id: ids.para, qty: 1 }, { product_id: ids.box, packs: 1 }] })
  assert.equal(short.status, 409)
  assert.match(short.body.message, /Not enough stock for Boxed: 5 available/)
  assert.equal(await db.col('issues').countDocuments(), before)
  assert.equal(await stockOf(ids.b2), 75)
})

test('controlled drugs need received_by; register shows department', async () => {
  const none = await call('POST', '/issues', { department_id: ids.er, items: [{ product_id: ids.morph, qty: 4 }] })
  assert.equal(none.status, 400)
  const ok = await call('POST', '/issues', { department_id: ids.er, received_by: 'Nurse C', items: [{ product_id: ids.morph, qty: 4 }] })
  assert.equal(ok.status, 201)
  assert.equal(ok.body.received_by, 'Nurse C')
  ids.issueM = ok.body.id
  const ret = await call('POST', `/issues/${ids.issueM}/returns`, { reason: 'unused', items: [{ issue_item_id: ok.body.items[0].id, qty: 1 }] })
  assert.equal(ret.status, 201)
  const reg = (await call('GET', '/reports/controlled-register')).body
  const rows = reg.filter((m) => m.reason === 'issue' || m.reason === 'issue_return')
  assert.equal(rows.length, 2)
  assert.ok(rows.every((m) => m.department_name === 'ER'))
  assert.equal(rows[0].department_name, 'ER')
})

test('issue return restocks, caps, expired not restocked', async () => {
  const issue = (await call('GET', `/issues/${ids.issue1}`)).body
  const [i1, i2] = issue.items
  const over = await call('POST', `/issues/${ids.issue1}/returns`, { reason: 'x', items: [{ issue_item_id: i2.id, qty: 6 }] })
  assert.equal(over.status, 400)
  const before = await stockOf(ids.b2)
  const ok = await call('POST', `/issues/${ids.issue1}/returns`, { reason: 'unused', items: [{ issue_item_id: i2.id, qty: 2 }, { issue_item_id: i1.id, qty: 3 }] })
  assert.equal(ok.status, 201)
  assert.equal(await stockOf(ids.b2), before + 2)
  assert.equal(await stockOf(ids.b1), 3)
  assert.equal(ok.body.returns[0].total_cost, 2 * 60 + 3 * 50)
  assert.equal(ok.body.returned_cost, 270)
  assert.equal(ok.body.items[1].returned_qty, 2)
  const again = await call('POST', `/issues/${ids.issue1}/returns`, { reason: 'x', items: [{ issue_item_id: i2.id, qty: 4 }] })
  assert.equal(again.status, 400)
  const mv = await db.all('stock_movements', { reason: 'issue_return', ref_id: ok.body.returns[0].id }, { sort: { id: 1 } })
  assert.equal(mv.length, 2)
  assert.equal(mv[0].note, 'OT')
  // no-restock
  const nr = await call('POST', `/issues/${ids.issue1}/returns`, { reason: 'damaged', items: [{ issue_item_id: i2.id, qty: 1, restock: false }] })
  assert.equal(nr.status, 201)
  assert.equal(await stockOf(ids.b2), before + 2)
  // expired batch: not restocked
  const expId = await put(db, 'issue_items', {
    issue_id: ids.issue1, product_id: ids.para, batch_id: ids.expired, qty: 5, unit_cost: 10, line_cost: 50, pack_size: 10, returned_qty: 0,
  })
  const ex = await call('POST', `/issues/${ids.issue1}/returns`, { reason: 'x', items: [{ issue_item_id: expId, qty: 5 }] })
  assert.equal(ex.status, 201)
  assert.equal(await stockOf(ids.expired), 50)
  await db.col('issue_return_items').deleteMany({ issue_item_id: expId })
  await db.col('issue_items').deleteOne({ _id: expId })
})

test('issue list and department-usage', async () => {
  const list = (await call('GET', `/issues?department_id=${ids.ot}`)).body
  assert.equal(list.length, 2)
  assert.ok(list[0].department_name && 'item_count' in list[0] && 'returned_cost' in list[0])
  const by = (await call('GET', '/reports/department-usage')).body
  const ot = by.find((d) => d.name === 'OT')
  assert.equal(ot.issues, 2)
  assert.equal(ot.issued_cost, 1300 + 20 * 60)
  assert.ok(ot.returned_cost >= 270)
  assert.equal(ot.net_cost, ot.issued_cost - ot.returned_cost)
  assert.equal(by.find((d) => d.name === 'ER').issued_cost, 1600)
  const prods = (await call('GET', `/reports/department-usage?department_id=${ids.ot}`)).body
  assert.equal(prods.length, 1)
  assert.equal(prods[0].name, 'Paracetamol')
  assert.equal(prods[0].qty_issued, 45)
  assert.ok(prods[0].qty_returned >= 5)
  assert.equal((await call('GET', '/reports/department-usage', null, 'cashier')).status, 403)
  const none = await call('GET', '/reports/department-usage?from=2000-01-01&to=2000-01-02')
  assert.deepEqual(none.body, [])
})
