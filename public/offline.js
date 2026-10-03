// Offline selling: keeps the last signed-in session, the item catalogue and unsynced sales on this
// device (IndexedDB), and sends the sales to the server when the connection is back.
// A queued sale is { offline_id, offline_at, user_id, user_name, body, preview } where body is the
// normal POST /api/sales body. Problems are sales the server refused; a person reviews them.

const DB_NAME = 'pharmacy-pos-offline'
let dbp = null

function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => {
        const d = req.result
        d.createObjectStore('kv')
        d.createObjectStore('queue', { keyPath: 'offline_id' })
        d.createObjectStore('problems', { keyPath: 'offline_id' })
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }
  return dbp
}

async function run(store, mode, fn) {
  const d = await db()
  return new Promise((resolve, reject) => {
    const tx = d.transaction(store, mode)
    const out = fn(tx.objectStore(store))
    tx.oncomplete = () => resolve(out?.result ?? out)
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}
const all = (store) => run(store, 'readonly', (s) => s.getAll())
const kvGet = (key) => run('kv', 'readonly', (s) => s.get(key))
const kvSet = (key, value) => run('kv', 'readwrite', (s) => s.put(value, key))

const pad = (n) => String(n).padStart(2, '0')
// Device-local time, the same 'YYYY-MM-DD HH:MM:SS' shape the server uses.
export function localStamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`)

export const offline = {
  supported: typeof indexedDB !== 'undefined',

  saveSession: (user, settings) => kvSet('session', { user, settings, at: Date.now() }),
  loadSession: () => kvGet('session'),
  clearSession: () => kvSet('session', null),

  saveCatalog: (products, at) => kvSet('catalog', { products, at, savedAt: Date.now() }),
  loadCatalog: () => kvGet('catalog'),

  // Keeps local stock in step with sales made offline (the next download replaces it).
  async takeStock(lines) {
    const cat = await kvGet('catalog')
    if (!cat) return
    const byId = new Map(cat.products.map((p) => [p.id, p]))
    for (const { product_id, units } of lines) {
      const p = byId.get(product_id)
      if (p) p.stock = Math.max(0, (p.stock || 0) - units)
    }
    await kvSet('catalog', cat)
  },

  async queueSale({ user, body, preview }) {
    const sale = { offline_id: newId(), offline_at: localStamp(), user_id: user.id, user_name: user.full_name, body, preview }
    await run('queue', 'readwrite', (s) => s.put(sale))
    return sale
  },
  pending: () => all('queue'),
  problems: () => all('problems'),
  async toProblem(sale, message) {
    await run('problems', 'readwrite', (s) => s.put({ ...sale, error: message, failed_at: localStamp() }))
    await run('queue', 'readwrite', (s) => s.delete(sale.offline_id))
  },
  async retry(id) {
    const p = await run('problems', 'readonly', (s) => s.get(id))
    if (!p) return
    const { error, failed_at, ...sale } = p
    await run('queue', 'readwrite', (s) => s.put(sale))
    await run('problems', 'readwrite', (s) => s.delete(id))
  },
  discard: (id) => run('problems', 'readwrite', (s) => s.delete(id)),
  synced: (id) => run('queue', 'readwrite', (s) => s.delete(id)),

  async counts(userId) {
    const [q, p] = await Promise.all([all('queue'), all('problems')])
    return { mine: q.filter((s) => s.user_id === userId).length, others: q.filter((s) => s.user_id !== userId).length, problems: p.length }
  },
}

// Sends this user's queued sales, oldest first. Stops at the first network failure; a sale the
// server refuses (4xx) goes to problems so it never blocks the rest.
let syncing = false
export async function syncNow({ user, send, onChange }) {
  if (syncing || !user || !offline.supported) return
  syncing = true
  try {
    const queue = (await offline.pending()).filter((s) => s.user_id === user.id)
      .sort((a, b) => (a.offline_at < b.offline_at ? -1 : 1))
    for (const sale of queue) {
      try {
        await send({ ...sale.body, offline_id: sale.offline_id, offline_at: sale.offline_at })
        await offline.synced(sale.offline_id)
      } catch (err) {
        if (err.offline) break
        if (err.status >= 400 && err.status < 500 && err.status !== 401 && err.status !== 429) {
          await offline.toProblem(sale, err.message)
        } else {
          break // server trouble or signed out: try again later
        }
      } finally {
        onChange?.()
      }
    }
  } finally {
    syncing = false
  }
}
