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

test('setup creates an admin whose permissions include users.manage', async () => {
  await call('POST', '/auth/setup', { username: 'admin', full_name: 'Admin', password: 'adminpass1' })
  tokens.admin = await login('admin', 'adminpass1')
  const me = (await call('GET', '/auth/me')).body.user
  assert.ok(me.permissions.includes('users.manage'))
  assert.ok(me.permissions.includes('settings.manage'))
})

test('the 3 built-in roles exist and reproduce the old fixed-role access', async () => {
  const roles = (await call('GET', '/roles')).body
  const byKey = Object.fromEntries(roles.map((r) => [r.key, r]))
  assert.equal(byKey.cashier.is_system, 1)
  assert.deepEqual(byKey.cashier.permissions, ['sales.use'])
  assert.ok(byKey.pharmacist.permissions.includes('purchases.manage'))
  assert.ok(!byKey.pharmacist.permissions.includes('users.manage'))
  assert.ok(byKey.admin.permissions.includes('users.manage'))
  // Only an admin (users.manage) may list roles.
  await call('POST', '/users', { username: 'cash1', full_name: 'Cash One', role: 'cashier', password: 'password1' })
  tokens.cashier = await login('cash1', 'password1')
  assert.equal((await call('GET', '/roles', null, 'cashier')).status, 403)
})

test('GET /roles/permissions returns the permission catalogue', async () => {
  const perms = (await call('GET', '/roles/permissions')).body
  assert.ok(perms.some((p) => p.key === 'hr.manage'))
  assert.ok(perms.every((p) => p.key && p.group && p.label))
})

test('a custom role can be created with a subset of permissions and assigned to a user', async () => {
  const create = await call('POST', '/roles', {
    name: 'Purchasing Clerk', base_role: 'cashier', permissions: ['sales.use', 'suppliers.manage', 'purchases.manage'],
  })
  assert.equal(create.status, 201)
  assert.equal(create.body.is_system, 0)
  ids.customRole = create.body.id

  const user = await call('POST', '/users', { username: 'clerk1', full_name: 'Clerk One', role_id: ids.customRole, password: 'password1' })
  assert.equal(user.status, 201)
  assert.equal(user.body.role, 'cashier') // base_role kept in sync for the legacy discount/controlled-drug rules
  tokens.clerk = await login('clerk1', 'password1')
  const me = (await call('GET', '/auth/me', null, 'clerk')).body.user
  assert.deepEqual(me.permissions.sort(), ['purchases.manage', 'sales.use', 'suppliers.manage'])

  // Has access to suppliers (granted) but not products (not granted).
  assert.equal((await call('GET', '/suppliers', null, 'clerk')).status, 200)
  assert.equal((await call('POST', '/products', { name: 'X', sale_price: 100 }, 'clerk')).status, 403)
})

test('editing a custom role\'s permissions takes effect immediately', async () => {
  await call('PUT', `/roles/${ids.customRole}`, { permissions: ['sales.use', 'suppliers.manage', 'purchases.manage', 'products.manage'] })
  assert.equal((await call('POST', '/products', { name: 'Y', sale_price: 100 }, 'clerk')).status, 201)
})

test('built-in roles cannot be deleted; a role in use cannot be deleted', async () => {
  const roles = (await call('GET', '/roles')).body
  const cashierRole = roles.find((r) => r.key === 'cashier')
  assert.equal((await call('DELETE', `/roles/${cashierRole.id}`)).status, 400)
  assert.equal((await call('DELETE', `/roles/${ids.customRole}`)).status, 409) // clerk1 still has it
})

test('a role with nobody on it can be deleted', async () => {
  const create = await call('POST', '/roles', { name: 'Temp Role', base_role: 'cashier', permissions: ['sales.use'] })
  const del = await call('DELETE', `/roles/${create.body.id}`)
  assert.equal(del.status, 200)
  assert.equal(await db.get('roles', create.body.id), null)
})

test('unknown permission keys are rejected', async () => {
  const r = await call('POST', '/roles', { name: 'Bad Role', base_role: 'cashier', permissions: ['not.a.real.permission'] })
  assert.equal(r.status, 400)
})
