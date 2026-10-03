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
})
after(async () => {
  server.close()
  await stopTestStore()
})

async function call(method, path, body, as = 'owner') {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(tokens[as] ? { authorization: `Bearer ${tokens[as]}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, body: await res.json() }
}
const login = async (u, p) => (await call('POST', '/auth/login', { username: u, password: p })).body.token

test('the setup account is the owner', async () => {
  await call('POST', '/auth/setup', { username: 'owner', full_name: 'Owner', password: 'ownerpass1' })
  tokens.owner = await login('owner', 'ownerpass1')
  assert.equal((await call('GET', '/auth/me')).body.user.is_owner, 1)
  ids.admin2 = (await call('POST', '/users', { username: 'admin2', full_name: 'Admin Two', role: 'admin', password: 'adminpass1' })).body.id
  tokens.admin2 = await login('admin2', 'adminpass1')
  assert.equal((await call('GET', '/auth/me', null, 'admin2')).body.user.is_owner, 0)
})

test('policy settings are owner-only and need the password', async () => {
  for (const who of ['owner', 'admin2']) {
    assert.equal((await call('PUT', '/settings', { require_open_till: '0' }, who)).status, 403)
  }
  // Unchanged protected values in a full settings form are fine; other keys still save.
  const ok = await call('PUT', '/settings', { require_open_till: '1', pharmacy_name: 'Federal Hospital Pharmacy' }, 'admin2')
  assert.equal(ok.status, 200)
  assert.equal(ok.body.pharmacy_name, 'Federal Hospital Pharmacy')

  assert.equal((await call('PUT', '/owner/settings', { require_open_till: '0', current_password: 'x' })).status, 403)
  assert.equal((await call('PUT', '/owner/settings', { require_open_till: '0', current_password: 'adminpass1' }, 'admin2')).status, 403)
  assert.equal((await call('PUT', '/owner/settings', { refund_card_sales: 'maybe', current_password: 'ownerpass1' })).status, 400)
  assert.equal((await call('PUT', '/owner/settings', { pharmacy_name: 'x', current_password: 'ownerpass1' })).status, 400)
  const r = await call('PUT', '/owner/settings', {
    current_password: 'ownerpass1', require_open_till: '0', refund_card_sales: 'original', max_discount_cashier_bps: '500',
  })
  assert.equal(r.status, 200)
  assert.equal(r.body.jwt_secret, undefined)
  const s = (await call('GET', '/settings', null, 'admin2')).body
  assert.deepEqual([s.require_open_till, s.refund_card_sales, s.max_discount_cashier_bps], ['0', 'original', '500'])

  const log = (await call('GET', '/owner/audit')).body
  const entry = log.find((e) => e.action === 'settings.update')
  assert.deepEqual(entry.detail.require_open_till, { from: '1', to: '0' })
  assert.equal(entry.user_name, 'Owner')
  assert.equal((await call('GET', '/owner/audit', null, 'admin2')).status, 403)
})

test('only the owner manages admins; the owner cannot be removed', async () => {
  assert.equal((await call('POST', '/users', { username: 'a3', full_name: 'A3', role: 'admin', password: 'password1' }, 'admin2')).status, 403)
  const cashier = await call('POST', '/users', { username: 'cash1', full_name: 'Cash One', role: 'cashier', password: 'password1' }, 'admin2')
  assert.equal(cashier.status, 201)
  ids.cashier = cashier.body.id
  assert.equal((await call('PATCH', `/users/${ids.cashier}`, { role: 'admin' }, 'admin2')).status, 403)
  const owner = (await call('GET', '/users')).body.find((u) => u.is_owner)
  assert.equal((await call('PATCH', `/users/${owner.id}`, { active: false }, 'admin2')).status, 400)
  assert.equal((await call('PATCH', `/users/${owner.id}`, { full_name: 'Hacked' }, 'admin2')).status, 403)
  // An admin can still edit their own name.
  assert.equal((await call('PATCH', `/users/${ids.admin2}`, { full_name: 'Admin 2' }, 'admin2')).status, 200)
  assert.ok((await call('GET', '/owner/audit')).body.some((e) => e.action === 'user.create' && e.detail.username === 'cash1'))
})

test('discount caps follow the owner setting', async () => {
  await db.col('products').insertOne({ _id: 900, id: 900, name: 'Cap Test', name_lc: 'cap test', pack_size: 1, pack_price: 1000, sale_price: 1000,
    schedule: 'otc', gst_rate_bps: 0, allow_loose: 1, active: 1 })
  await put(db, 'batches', { product_id: 900, batch_no: 'CT1', expiry_date: '2099-01-01', cost_price: 500, sale_price: 1000, pack_price: 1000, pack_size: 1, qty_on_hand: 100 })
  tokens.cashier = await login('cash1', 'password1')
  const over = await call('POST', '/sales', { items: [{ product_id: 900, qty: 1, discount_bps: 600 }] }, 'cashier')
  assert.equal(over.status, 403)
  const ok = await call('POST', '/sales', { items: [{ product_id: 900, qty: 1, discount_bps: 500 }] }, 'cashier')
  assert.equal(ok.status, 201)
})

test('card sales are refunded to the card when the owner allows it', async () => {
  await call('PUT', '/owner/settings', { require_open_till: '1', current_password: 'ownerpass1' })
  await call('POST', '/tills/open', { opening_cash: 10000 })
  const card = (await call('POST', '/sales', { items: [{ product_id: 900, qty: 2 }], payment_method: 'card' })).body
  const cash = (await call('POST', '/sales', { items: [{ product_id: 900, qty: 1 }], payment_method: 'cash', amount_paid: 1000 })).body
  const r1 = await call('POST', `/sales/${card.id}/returns`, { items: [{ sale_item_id: card.items[0].id, qty: 1 }], reason: 'unopened' })
  assert.equal(r1.body.returns[0].refund_method, 'card')
  const r2 = await call('POST', `/sales/${cash.id}/returns`, { items: [{ sale_item_id: cash.items[0].id, qty: 1 }], reason: 'unopened' })
  assert.equal(r2.body.returns[0].refund_method, 'cash')
  const t = (await call('GET', '/tills/current')).body.totals
  assert.equal(t.refunds, 1000, 'only the cash refund leaves the drawer')
  assert.equal(t.expected_cash, 10000 + 1000 - 1000)

  // Default policy: everything is refunded in cash.
  await call('PUT', '/owner/settings', { refund_card_sales: 'drawer', current_password: 'ownerpass1' })
  const card2 = (await call('POST', '/sales', { items: [{ product_id: 900, qty: 1 }], payment_method: 'card' })).body
  const r3 = await call('POST', `/sales/${card2.id}/returns`, { items: [{ sale_item_id: card2.items[0].id, qty: 1 }], reason: 'x' })
  assert.equal(r3.body.returns[0].refund_method, 'cash')
})

test('ownership can be transferred to an active admin', async () => {
  assert.equal((await call('POST', '/owner/transfer', { user_id: ids.cashier, current_password: 'ownerpass1' })).status, 400)
  assert.equal((await call('POST', '/owner/transfer', { user_id: ids.admin2, current_password: 'wrong' })).status, 403)
  const r = await call('POST', '/owner/transfer', { user_id: ids.admin2, current_password: 'ownerpass1' })
  assert.equal(r.status, 200)
  assert.equal((await call('GET', '/auth/me', null, 'admin2')).body.user.is_owner, 1)
  assert.equal((await call('GET', '/auth/me')).body.user.is_owner, 0)
  assert.equal((await call('GET', '/owner/audit')).status, 403)
  assert.equal(await db.col('users').countDocuments({ is_owner: 1 }), 1)
})
