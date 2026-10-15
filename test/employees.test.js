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
  ids.cashierUser = cashier.body.id
  tokens.cashier = await login('cash1', 'password1')
})

test('an employee record can stand alone or link to a user', async () => {
  const standalone = await call('POST', '/employees', { full_name: 'Delivery Boy', job_title: 'Rider', phone: '0300-0000000' })
  assert.equal(standalone.status, 201)
  assert.equal(standalone.body.user_id, null)

  const linked = await call('POST', '/employees', { full_name: 'Cash One', job_title: 'Cashier', user_id: ids.cashierUser, salary: 3000000 })
  assert.equal(linked.status, 201)
  ids.linked = linked.body.id
  const detail = await call('GET', `/employees/${ids.linked}`)
  assert.equal(detail.body.username, 'cash1')
  assert.equal(detail.body.role, 'cashier')
})

test('a user can only have one employee record', async () => {
  const dupe = await call('POST', '/employees', { full_name: 'Cash One Again', user_id: ids.cashierUser })
  assert.equal(dupe.status, 400)
})

test('a cashier cannot manage employee records', async () => {
  assert.equal((await call('GET', '/employees', null, 'cashier')).status, 403)
})

test('an employee record can be edited, including unlinking its user', async () => {
  const edit = await call('PUT', `/employees/${ids.linked}`, { salary: 3500000, user_id: null })
  assert.equal(edit.status, 200)
  assert.equal(edit.body.salary, 3500000)
  assert.equal(edit.body.user_id, null)
})
