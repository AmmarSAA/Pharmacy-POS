import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { testStore, stopTestStore, put } from './helpers/mongo.js'
import { createApp } from '../src/app.js'
import { today, nowStamp } from '../src/db.js'
import { addDays } from '../src/lib/supplier-ledger.js'

// Sales made while the counter was offline and synced later.
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
const ago = (minutes) => {
  const now = nowStamp()
  const d = new Date(Date.parse(now.replace(' ', 'T') + 'Z') - minutes * 60000)
  return d.toISOString().slice(0, 19).replace('T', ' ')
}

test('setup', async () => {
  await call('POST', '/auth/setup', { username: 'owner', full_name: 'Owner', password: 'secret123' })
  tokens.admin = (await call('POST', '/auth/login', { username: 'owner', password: 'secret123' })).body.token
  ids.para = (await call('POST', '/products', { name: 'Paracetamol', pack_size: 10, pack_price: 1000 })).body.id
  ids.morph = (await call('POST', '/products', { name: 'Morphine', pack_size: 1, pack_price: 5000, schedule: 'controlled' })).body.id
  ids.b1 = await put(db, 'batches', { product_id: ids.para, batch_no: 'P1', expiry_date: addDays(today(), 200), cost_price: 50, sale_price: 100, pack_price: 1000, pack_size: 10, qty_on_hand: 30 })
  await put(db, 'batches', { product_id: ids.morph, batch_no: 'M1', expiry_date: addDays(today(), 200), cost_price: 3000, sale_price: 5000, pack_price: 5000, pack_size: 1, qty_on_hand: 10 })
})

test('the offline catalogue has stock and FEFO prices for every active item', async () => {
  const r = await call('GET', '/products/offline-catalog')
  assert.equal(r.status, 200)
  const p = r.body.products.find((x) => x.id === ids.para)
  assert.equal(p.stock, 30)
  assert.equal(p.current_pack_price, 1000)
  assert.match(r.body.at, /^\d{4}-\d{2}-\d{2} /)
})

test('an offline sale syncs once, dated when it happened, into the till open then', async () => {
  // Till opened 2 hours ago; the sale happened 30 minutes ago while offline.
  const till = await call('POST', '/tills/open', { opening_cash: 0 })
  await db.col('till_sessions').updateOne({ _id: till.body.id }, { $set: { opened_at: ago(120) } })
  const at = ago(30)
  const body = { offline_id: 'abc12345-device1-0001', offline_at: at, items: [{ product_id: ids.para, packs: 1 }], payment_method: 'cash' }
  const first = await call('POST', '/sales', body)
  assert.equal(first.status, 201, JSON.stringify(first.body))
  assert.equal(first.body.created_at, at)
  assert.equal(first.body.till_session_id, till.body.id)
  const again = await call('POST', '/sales', body)
  assert.equal(again.status, 200)
  assert.equal(again.body.id, first.body.id)
  assert.equal(await db.col('sales').countDocuments({ offline_id: body.offline_id }), 1)
  assert.equal((await db.get('batches', ids.b1)).qty_on_hand, 20)
  // Two copies at the same moment still make one sale.
  const twin = { ...body, offline_id: 'abc12345-device1-0002' }
  const [a, b] = await Promise.all([call('POST', '/sales', twin), call('POST', '/sales', twin)])
  assert.deepEqual([a.status, b.status].sort(), [200, 201])
  assert.equal(a.body.id, b.body.id)
})

test('offline sales are accepted even when no till was open, and refused when they cannot be right', async () => {
  const closed = await call('POST', '/tills/current/close', { counted_cash: 0 })
  await db.col('till_sessions').updateOne({ _id: closed.body.id }, { $set: { closed_at: ago(10) } })
  const noTill = await call('POST', '/sales', { offline_id: 'abc12345-device1-0003', offline_at: ago(5), items: [{ product_id: ids.para, qty: 1 }] })
  assert.equal(noTill.status, 201, JSON.stringify(noTill.body))
  assert.equal(noTill.body.till_session_id, null)
  const bad = async (patch, status, re) => {
    const r = await call('POST', '/sales', { offline_id: `abc12345-x-${Math.random().toString(36).slice(2, 8)}`, offline_at: ago(5), items: [{ product_id: ids.para, qty: 1 }], ...patch })
    assert.equal(r.status, status, JSON.stringify(r.body))
    if (re) assert.match(r.body.message, re)
  }
  await bad({ items: [{ product_id: ids.morph, qty: 1 }], prescription: { patient_name: 'P', prescriber_name: 'D', patient_cnic: '1', prescriber_reg_no: '2' } }, 409, /Controlled drugs cannot be sold offline/)
  await bad({ offline_at: `${addDays(today(), 1)} 10:00:00` }, 400, /future/)
  await bad({ offline_at: `${addDays(today(), -9)} 10:00:00` }, 400, /more than 7 days/)
  await bad({ offline_at: 'yesterday' }, 400)
  await bad({ offline_id: 'x' }, 400)
  await bad({ items: [{ product_id: ids.para, qty: 500 }] }, 409, /Not enough stock/)
})
