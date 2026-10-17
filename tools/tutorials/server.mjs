// Demo server for recording tutorials: in-memory MongoDB + the real API + the real static app (../../public)
// on one port, no build step needed. Usage: node server.mjs [port]
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { MongoClient } from 'mongodb'
import { Store } from '../../src/store.js'
import { initDb } from '../../src/db.js'
import { createApp } from '../../src/app.js'
import { PROVIDERS } from '../../src/assistant/providers.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const port = Number(process.argv[2] || process.env.PORT || 9100)
const rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' }, instanceOpts: [{ launchTimeout: 60000 }] })
const client = await MongoClient.connect(rs.getUri())
process.env.JWT_SECRET ||= 'tutorial-secret'
const db = await initDb(new Store(client, client.db('pharmacy_tutorial')))

// This demo server never has a real Groq key; the 10-ai-assistant tutorial needs a working
// assistant to record, so AGENT_PROVIDER=fake routes it to the built-in fake provider (meant for
// tests and offline demos), and its step() is replaced below with a tiny scripted one that decides
// which real tool to call for the exact questions that video's narration asks. Every tool call it
// triggers (search_products, set_product_price, find_tutorial, …) runs for real against this demo's
// real seeded data — only the "what would an LLM say next" part is scripted, not the app behaviour.
process.env.AGENT_PROVIDER = 'fake'
const lastUser = (h) => [...h].reverse().find((m) => m.role === 'user')?.content || ''
const lastToolCallId = (h) => (h[h.length - 1]?.role === 'tool' ? h[h.length - 1].tool_call_id : null)
const SCRIPT = [
  { if: (h) => /panadol/i.test(lastUser(h)) && /stock/i.test(lastUser(h)) && !lastToolCallId(h),
    then: { toolCalls: [{ id: 'q1', name: 'search_products', input: { query: 'Panadol' } }] } },
  { if: (h) => lastToolCallId(h) === 'q1',
    then: { text: 'Panadol 500mg is in good stock across two batches, at Rs 25.00 a pack, and nothing is close to expiry.' } },
  { if: (h) => /price/i.test(lastUser(h)) && /panadol/i.test(lastUser(h)) && !lastToolCallId(h),
    then: { toolCalls: [{ id: 'q2', name: 'set_product_price', input: { product: 'Panadol', pack_price_rs: 30 } }] } },
  { if: (h) => lastToolCallId(h) === 'q2',
    then: { text: "Done — Panadol's pack price is now Rs 30.00 a pack, Rs 3.00 a tablet." } },
  { if: (h) => /department/i.test(lastUser(h)) && !lastToolCallId(h),
    then: (h) => ({ toolCalls: [{ id: 'q3', name: 'find_tutorial', input: { query: lastUser(h) } }] }) },
  { if: (h) => lastToolCallId(h) === 'q3',
    then: { text: "Open Issues → New request for the ward, then issue against it once you're ready to send the stock. Here's the tutorial: [Department requests & issues](#/help?v=06-departments-and-issues&lang=en)" } },
]
PROVIDERS.fake.step = async ({ history }) => {
  const rule = SCRIPT.find((r) => r.if(history))
  const out = rule ? (typeof rule.then === 'function' ? rule.then(history) : rule.then) : { text: "I'm not scripted for that question in this demo." }
  const toolCalls = out.toolCalls || []
  const stored = { role: 'assistant', content: out.text || '' }
  if (toolCalls.length) stored.tool_calls = toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input) } }))
  return { append: [stored], text: out.text || '', toolCalls, done: !toolCalls.length }
}

const app = createApp(db, { publicDir: path.join(root, 'public') })
app.listen(port, () => console.log(`demo on http://localhost:${port}`))
