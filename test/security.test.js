import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.js'
import { createApp } from '../src/app.js'

let server, base

before(async () => {
  process.env.SETUP_TOKEN = 'let-me-in'
  server = createApp(openDb(':memory:')).listen(0)
  await new Promise((r) => server.once('listening', r))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => {
  delete process.env.SETUP_TOKEN
  server.close()
})

const post = async (path, body) => {
  const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: res.status, body: await res.json() }
}
const owner = { username: 'owner', full_name: 'Owner', password: 'secret123' }

test('health check responds', async () => {
  assert.deepEqual(await (await fetch(`${base}/healthz`)).json(), { ok: true })
})

test('setup requires the setup token when one is configured', async () => {
  assert.equal((await (await fetch(`${base}/api/auth/status`)).json()).setupTokenRequired, true)
  assert.equal((await post('/api/auth/setup', owner)).status, 403)
  assert.equal((await post('/api/auth/setup', { ...owner, setup_token: 'wrong' })).status, 403)
  assert.equal((await post('/api/auth/setup', { ...owner, setup_token: 'let-me-in' })).status, 201)
})

test('repeated failed logins are rate limited', async () => {
  // The two failed setup attempts above count too; the limit is 10 failures per window.
  const statuses = []
  for (let i = 0; i < 9; i++) statuses.push((await post('/api/auth/login', { username: 'owner', password: 'nope' })).status)
  assert.equal(statuses.filter((s) => s === 401).length, 8)
  assert.equal(statuses.at(-1), 429)
  assert.equal((await post('/api/auth/login', { username: 'owner', password: 'secret123' })).status, 429)
})
