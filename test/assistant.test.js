import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { testStore, stopTestStore, put } from './helpers/mongo.js'
import { createApp } from '../src/app.js'
import { PROVIDERS, keyCheck } from '../src/assistant/providers.js'

// A scripted stand-in for the model: each step returns the next scripted reply.
process.env.AGENT_PROVIDER = 'fake'
let script = []
const seen = []
PROVIDERS.fake.step = async ({ tools, history }) => {
  seen.push({ tools: tools.map((t) => t.name), last: history.at(-1) })
  const next = script.shift() || { text: 'Done.' }
  const toolCalls = (next.calls || []).map((c, i) => ({ id: `call_${Date.now()}_${i}`, name: c.name, input: c.input }))
  const msg = { role: 'assistant', content: next.text || '' }
  if (toolCalls.length) msg.tool_calls = toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input) } }))
  return { append: [msg], text: next.text || '', toolCalls, done: !toolCalls.length }
}

let server, base, db
const tokens = {}
before(async () => {
  db = await testStore()
  server = createApp(db).listen(0)
  await new Promise((r) => server.once('listening', r))
  base = `http://127.0.0.1:${server.address().port}/api`
})
after(async () => {
  server.close()
  await stopTestStore()
  delete process.env.AGENT_PROVIDER
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
// Runs a turn to completion (like the browser does with /step).
async function converse(path, body, as = 'owner') {
  let r = await call('POST', path, body, as)
  while (r.status < 400 && r.body.status === 'running') r = await call('POST', `/assistant/conversations/${r.body.id}/step`, null, as)
  return r
}
const ids = {}

test('setup', async () => {
  await call('POST', '/auth/setup', { username: 'owner', full_name: 'Owner', password: 'ownerpass1' })
  tokens.owner = await login('owner', 'ownerpass1')
  await call('POST', '/users', { username: 'cash1', full_name: 'Cash One', role: 'cashier', password: 'cashpass1' })
  tokens.cashier = await login('cash1', 'cashpass1')
  await call('POST', '/products/import', { rows: [{ barcode: 'ph101', name: 'ABAKTAL 400MG TAB', pack_size: 10, pack_price: 5000 }] })
  ids.product = (await call('GET', '/products/pick')).body[0].id
  ids.supplier = (await call('POST', '/suppliers', { name: 'Premier' })).body.id
})

test('status, and the owner switch turns it off', async () => {
  const s = (await call('GET', '/assistant/status')).body
  assert.equal(s.enabled, true)
  assert.equal(s.provider, 'fake')
  assert.equal(s.saved, null)
  assert.equal((await call('GET', '/assistant/status', null, 'cashier')).body.saved, undefined)
  await call('PUT', '/owner/settings', { assistant_enabled: '0', current_password: 'ownerpass1' })
  assert.equal((await call('POST', '/assistant/conversations', { text: 'hi' })).status, 503)
  await call('PUT', '/owner/settings', { assistant_enabled: '1', current_password: 'ownerpass1' })
})

test('owner saves a key: verified, sealed, only a hint comes back', async () => {
  const real = keyCheck.verify
  keyCheck.verify = async () => {}
  try {
    const key = 'gsk_' + 'x'.repeat(40) + 'WXYZ'
    assert.equal((await call('PUT', '/assistant/key', { apiKey: key, current_password: 'wrong' })).status, 403)
    assert.equal((await call('PUT', '/assistant/key', { apiKey: key, current_password: 'cashpass1' }, 'cashier')).status, 403)
    assert.equal((await call('PUT', '/assistant/key', { apiKey: 'sk-nope-' + 'x'.repeat(30), current_password: 'ownerpass1' })).status, 400)
    const r = await call('PUT', '/assistant/key', { apiKey: key, current_password: 'ownerpass1' })
    assert.equal(r.status, 200)
    assert.equal(r.body.saved.keyHint, '…WXYZ')
    const stored = (await db.col('settings').raw.findOne({ _id: 'assistant_api_key' })).value
    assert.ok(!stored.includes(key), 'key is not stored in plain text')
    assert.equal((await call('GET', '/settings')).body.assistant_api_key, undefined)
    assert.equal((await call('GET', '/assistant/status')).body.saved.keyHint, '…WXYZ')
    assert.ok((await call('GET', '/owner/audit')).body.some((e) => e.action === 'assistant.key'))
    assert.equal((await call('DELETE', '/assistant/key', { current_password: 'ownerpass1' })).status, 200)
  } finally {
    keyCheck.verify = real
  }
})

test('a read tool runs and its result goes back to the model', async () => {
  script = [{ calls: [{ name: 'search_products', input: { query: 'ph101' } }] }, { text: 'You have ABAKTAL.' }]
  const r = await converse('/assistant/conversations', { text: 'Do we have Abaktal?' })
  assert.equal(r.status, 201)
  assert.equal(r.body.status, 'idle')
  assert.ok(r.body.transcript.some((e) => e.type === 'tool' && e.name === 'search_products'))
  assert.equal(r.body.transcript.at(-1).text, 'You have ABAKTAL.')
  const toolMsg = seen.at(-1).last
  assert.equal(toolMsg.role, 'tool')
  assert.match(toolMsg.content, /ABAKTAL/)
  assert.equal(r.body.messages, undefined, 'raw history is never sent to the browser')
})

test('a write tool waits for approval and runs exactly once', async () => {
  script = [{ calls: [{ name: 'set_product_price', input: { product: 'ph101', pack_price_rs: 62.5 } }] }, { text: 'Price updated.' }]
  const r = await converse('/assistant/conversations', { text: 'Set Abaktal to Rs 62.50 a pack' })
  assert.equal(r.body.status, 'awaiting_approval')
  assert.equal(r.body.pending.length, 1)
  assert.ok(r.body.pending[0].details.length > 0)
  assert.equal((await call('GET', `/products/${ids.product}`)).body.pack_price, 5000, 'nothing changed before approval')
  await assert.equal((await call('POST', `/assistant/conversations/${r.body.id}/messages`, { text: 'hello?' })).status, 409)
  const done = await converse(`/assistant/conversations/${r.body.id}/approve`, { decisions: { [r.body.pending[0].id]: true } })
  assert.equal(done.status, 200)
  assert.equal((await call('GET', `/products/${ids.product}`)).body.pack_price, 6250)
  assert.equal((await call('POST', `/assistant/conversations/${r.body.id}/approve`, { decisions: { [r.body.pending[0].id]: true } })).status, 409)
  assert.ok((await call('GET', '/owner/audit')).body.some((e) => e.action === 'assistant.action'))
})

test('a declined action does not run', async () => {
  script = [{ calls: [{ name: 'set_product_schedule', input: { products: ['ph101'], schedule: 'controlled' } }] }, { text: 'OK, left it.' }]
  const r = await converse('/assistant/conversations', { text: 'Make Abaktal controlled' })
  assert.equal(r.body.status, 'awaiting_approval')
  await converse(`/assistant/conversations/${r.body.id}/approve`, { decisions: { [r.body.pending[0].id]: false } })
  assert.equal((await call('GET', `/products/${ids.product}`)).body.schedule, 'otc')
})

test('cashiers are not offered staff tools and cannot use them', async () => {
  script = [{ calls: [{ name: 'record_supplier_payment', input: { supplier: 'Premier', amount: 1000, method: 'cash' } }] }, { text: 'I cannot do that.' }]
  const r = await converse('/assistant/conversations', { text: 'Pay Premier Rs 1000' }, 'cashier')
  assert.equal(r.body.status, 'idle')
  assert.ok(!seen.at(-2).tools.includes('record_supplier_payment'))
  assert.ok(seen.at(-2).tools.includes('search_products'))
  assert.match(seen.at(-1).last.content, /not available/i)
  assert.equal(await db.col('supplier_payments').countDocuments(), 0)
})

test('conversations belong to their user', async () => {
  const mine = (await call('GET', '/assistant/conversations')).body
  const theirs = (await call('GET', '/assistant/conversations', null, 'cashier')).body
  assert.ok(mine.length >= 3)
  assert.equal(theirs.length, 1)
  assert.equal((await call('GET', `/assistant/conversations/${mine[0].id}`, null, 'cashier')).status, 404)
  assert.equal((await call('DELETE', `/assistant/conversations/${theirs[0].id}`, null, 'cashier')).status, 200)
})

test('voice notes are checked before anything is sent anywhere', async () => {
  assert.equal((await call('POST', '/assistant/voice', { audio: 'AAAA', mime: 'video/mp4' })).status, 400)
  assert.equal((await call('POST', '/assistant/voice', { audio: 'AAAA', mime: 'audio/webm' })).status, 400)
  const audio = Buffer.alloc(4000, 1).toString('base64')
  const r = await call('POST', '/assistant/voice', { audio, mime: 'audio/webm;codecs=opus', lang: 'ur' })
  assert.equal(r.status, 200)
  assert.ok(r.body.text.length > 0)
})
