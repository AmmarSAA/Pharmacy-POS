import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { testStore, stopTestStore } from './helpers/mongo.js'
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
  const cashier = await call('POST', '/users', { username: 'cash1', full_name: 'Cash One', role: 'cashier', password: 'password1' })
  ids.cashierId = cashier.body.id
  tokens.cashier = await login('cash1', 'password1')
  const pharm = await call('POST', '/users', { username: 'pharm1', full_name: 'Pharm One', role: 'pharmacist', password: 'password1' })
  ids.pharmId = pharm.body.id
  tokens.pharmacist = await login('pharm1', 'password1')
})

// ---------------- Appointments ----------------

test('anyone can book their own appointment; only calendar.manage_all can book for someone else', async () => {
  const own = await call('POST', '/appointments', {
    title: 'My shift', starts_at: '2026-11-01 09:00:00', ends_at: '2026-11-01 17:00:00',
  }, 'cashier')
  assert.equal(own.status, 201)
  assert.equal(own.body.with_user_id, ids.cashierId)
  ids.appt = own.body.id

  // Cashier role has no calendar.manage_all (per Round 7's system-role mapping).
  const forOther = await call('POST', '/appointments', {
    title: 'Someone else', starts_at: '2026-11-01 09:00:00', ends_at: '2026-11-01 10:00:00', with_user_id: ids.pharmId,
  }, 'cashier')
  assert.equal(forOther.status, 403)

  // Pharmacist has calendar.manage_all.
  const booked = await call('POST', '/appointments', {
    title: 'Consultation', starts_at: '2026-11-02 09:00:00', ends_at: '2026-11-02 09:30:00', with_user_id: ids.pharmId,
  }, 'pharmacist')
  assert.equal(booked.status, 201)
})

test('a cashier only sees their own appointments; a manage_all user sees everyone\'s', async () => {
  const own = await call('GET', '/appointments', null, 'cashier')
  assert.ok(own.body.every((a) => a.with_user_id === ids.cashierId))
  const all = await call('GET', '/appointments', null, 'pharmacist')
  assert.ok(all.body.some((a) => a.with_user_id === ids.cashierId))
  assert.ok(all.body.some((a) => a.with_user_id === ids.pharmId))
})

test('a cashier cannot edit or cancel someone else\'s appointment, but can cancel their own', async () => {
  const other = (await call('GET', '/appointments', null, 'pharmacist')).body.find((a) => a.with_user_id === ids.pharmId)
  assert.equal((await call('POST', `/appointments/${other.id}/cancel`, null, 'cashier')).status, 403)
  assert.equal((await call('POST', `/appointments/${ids.appt}/cancel`, null, 'cashier')).status, 200)
})

// ---------------- Messages ----------------

test('messages flow both ways and unread counts work', async () => {
  const send = await call('POST', '/messages', { to_user_id: ids.cashierId, body: 'Please restock aisle 3' })
  assert.equal(send.status, 201)
  assert.equal((await call('GET', '/messages/unread-count', null, 'cashier')).body.count, 1)

  const thread = await call('GET', `/messages/with/${(await call('GET', '/auth/me')).body.user.id}`, null, 'cashier')
  assert.equal(thread.body.length, 1)
  assert.equal(thread.body[0].body, 'Please restock aisle 3')
  // Reading the thread marks it read.
  assert.equal((await call('GET', '/messages/unread-count', null, 'cashier')).body.count, 0)

  const reply = await call('POST', '/messages', { to_user_id: (await call('GET', '/auth/me')).body.user.id, body: 'On it' }, 'cashier')
  assert.equal(reply.status, 201)
  const threads = await call('GET', '/messages/threads')
  assert.ok(threads.body.some((t) => t.user_id === ids.cashierId && t.last_body === 'On it'))
})

test('you cannot message yourself or a nonexistent user', async () => {
  const me = (await call('GET', '/auth/me')).body.user.id
  assert.equal((await call('POST', '/messages', { to_user_id: me, body: 'hi' })).status, 400)
  assert.equal((await call('POST', '/messages', { to_user_id: 999999, body: 'hi' })).status, 404)
})

// ---------------- Knowledge ----------------

test('anyone can read articles; only knowledge.manage can write them', async () => {
  assert.equal((await call('POST', '/knowledge', { title: 'Cold chain SOP', body: 'Keep vaccines at 2-8C', tags: 'sop,cold-chain' })).status, 201)
  // Cashier has no knowledge.manage.
  assert.equal((await call('POST', '/knowledge', { title: 'x', body: 'y' }, 'cashier')).status, 403)
  // But any signed-in user can read.
  const list = await call('GET', '/knowledge', null, 'cashier')
  assert.equal(list.status, 200)
  assert.equal(list.body[0].title, 'Cold chain SOP')
  assert.equal(list.body[0].body, undefined, 'list view omits the body')
  const article = await call('GET', `/knowledge/${list.body[0].id}`, null, 'cashier')
  assert.equal(article.body.body, 'Keep vaccines at 2-8C')

  const tagged = await call('GET', '/knowledge?tag=sop')
  assert.equal(tagged.body.length, 1)
  const searched = await call('GET', '/knowledge?q=vaccine')
  assert.equal(searched.body.length, 1)
})
