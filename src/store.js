// MongoDB access for the whole app. Records keep the shape they had as SQL rows: an integer
// `id` (also used as _id), snake_case fields, money in paisa, local-time timestamp strings.
// Transactions: store.tx(fn) runs fn in a MongoDB transaction; every collection call made
// inside it (however deep) joins the transaction automatically.
import { AsyncLocalStorage } from 'node:async_hooks'

const als = new AsyncLocalStorage()

// Pharmacy-local clock. Pakistan is UTC+5 with no daylight saving, so a fixed offset is exact.
const clock = { offsetMinutes: null }
export function configureClock(utcOffsetMinutes) {
  const m = Number(utcOffsetMinutes)
  if (Number.isFinite(m)) clock.offsetMinutes = m
}
function localDate() {
  if (clock.offsetMinutes !== null) {
    const d = new Date(Date.now() + clock.offsetMinutes * 60000)
    return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds() }
  }
  const d = new Date()
  return { y: d.getFullYear(), mo: d.getMonth() + 1, d: d.getDate(), h: d.getHours(), mi: d.getMinutes(), s: d.getSeconds() }
}
const pad = (n) => String(n).padStart(2, '0')
// 'YYYY-MM-DD HH:MM:SS' local time
export function nowStamp() {
  const t = localDate()
  return `${t.y}-${pad(t.mo)}-${pad(t.d)} ${pad(t.h)}:${pad(t.mi)}:${pad(t.s)}`
}
// 'YYYY-MM-DD' local date
export const today = () => nowStamp().slice(0, 10)

const NO_ID = { _id: 0 }
export const withSession = (opts = {}) => {
  const session = als.getStore()
  return session ? { ...opts, session } : opts
}
const withProjection = (opts = {}) => ({ ...opts, projection: { ...NO_ID, ...(opts.projection || {}) } })

// A collection whose calls join the current transaction and hide _id. Writes call onWrite (cache upkeep).
function wrap(c, onWrite) {
  const w = (fn) => (...args) => {
    onWrite()
    return fn(...args)
  }
  return {
    raw: c,
    find: (filter = {}, opts) => c.find(filter, withSession(withProjection(opts))),
    findOne: (filter = {}, opts) => c.findOne(filter, withSession(withProjection(opts))),
    countDocuments: (filter = {}, opts) => c.countDocuments(filter, withSession(opts)),
    aggregate: (pipeline, opts) => c.aggregate(pipeline, withSession(opts)),
    distinct: (key, filter = {}, opts) => c.distinct(key, filter, withSession(opts)),
    insertOne: w((doc, opts) => c.insertOne(doc, withSession(opts))),
    insertMany: w((docs, opts) => c.insertMany(docs, withSession(opts))),
    updateOne: w((filter, update, opts) => c.updateOne(filter, update, withSession(opts))),
    updateMany: w((filter, update, opts) => c.updateMany(filter, update, withSession(opts))),
    replaceOne: w((filter, doc, opts) => c.replaceOne(filter, doc, withSession(opts))),
    deleteOne: w((filter, opts) => c.deleteOne(filter, withSession(opts))),
    deleteMany: w((filter, opts) => c.deleteMany(filter, withSession(opts))),
    bulkWrite: w((ops, opts) => c.bulkWrite(ops, withSession(opts))),
    findOneAndUpdate: w((filter, update, opts) => c.findOneAndUpdate(filter, update, withSession(withProjection({ returnDocument: 'after', ...opts })))),
  }
}

export class Store {
  constructor(client, db) {
    this.client = client
    this.db = db
    this.cache = new Map()
    this.memo = new Map() // name -> { value, until } (see cached)
  }

  col(name) {
    if (!this.cache.has(name)) {
      this.cache.set(name, wrap(this.db.collection(name), () => {
        this.invalidate(name)
        als.getStore()?.written?.add(name)
      }))
    }
    return this.cache.get(name)
  }

  // Short-lived in-memory copies of data read on almost every request (settings, the signed-in
  // user, the item pick list). One Durable Object serves every request, so clearing on write
  // keeps them correct; reads inside a transaction always go to the database.
  async cached(collection, key, ttlMs, load) {
    if (als.getStore()) return load()
    const k = `${collection}:${key}`
    const hit = this.memo.get(k)
    if (hit && hit.until > Date.now()) return hit.value
    const value = await load()
    this.memo.set(k, { value, until: Date.now() + ttlMs })
    return value
  }

  invalidate(collection) {
    for (const k of this.memo.keys()) if (k.startsWith(`${collection}:`)) this.memo.delete(k)
  }

  get inTx() {
    return Boolean(als.getStore())
  }

  // Next integer id for a collection (ids keep invoice numbers and links stable).
  async nextId(name) {
    const r = await this.col('counters').raw.findOneAndUpdate(
      { _id: name }, { $inc: { seq: 1 } }, withSession({ upsert: true, returnDocument: 'after' }),
    )
    return r.seq
  }

  // Reserves n consecutive ids; returns the first.
  async reserveIds(name, n) {
    const r = await this.col('counters').raw.findOneAndUpdate(
      { _id: name }, { $inc: { seq: n } }, withSession({ upsert: true, returnDocument: 'after' }),
    )
    return r.seq - n + 1
  }

  // Inserts a record with a fresh id and created_at (unless given); returns the id.
  async insert(name, doc) {
    const id = await this.nextId(name)
    await this.col(name).insertOne({ _id: id, id, created_at: nowStamp(), ...doc })
    return id
  }

  async get(name, id) {
    return this.col(name).findOne({ _id: Number(id) })
  }

  async all(name, filter = {}, opts = {}) {
    return this.col(name).find(filter, opts).toArray()
  }

  // Runs fn in a transaction (or inside the current one). Throwing rolls everything back.
  async tx(fn) {
    if (als.getStore()) return fn()
    const session = this.client.startSession()
    session.written = new Set()
    try {
      let result
      await session.withTransaction(async () => {
        result = await als.run(session, fn)
      })
      return result
    } finally {
      // Again after commit/abort, in case a read filled the cache while the transaction was open.
      for (const name of session.written) this.invalidate(name)
      await session.endSession()
    }
  }

  // Sum of a field over matching documents.
  async sum(name, filter, field) {
    const [r] = await this.col(name).aggregate([{ $match: filter }, { $group: { _id: null, v: { $sum: `$${field}` } } }]).toArray()
    return r?.v || 0
  }

  // Adds fields from referenced records, one query per spec (like SQL JOINs for display names).
  // spec: { key: 'supplier_id', from: 'suppliers', fields: { supplier_name: 'name' } }
  async join(rows, specs) {
    for (const { key, from, fields } of specs) {
      const ids = [...new Set(rows.map((r) => r[key]).filter((v) => v !== null && v !== undefined))]
      const proj = Object.fromEntries(Object.values(fields).map((f) => [f, 1]))
      const found = ids.length ? await this.col(from).find({ _id: { $in: ids } }, { projection: { id: 1, ...proj } }).toArray() : []
      const byId = new Map(found.map((d) => [d.id, d]))
      for (const r of rows) {
        const d = byId.get(r[key])
        for (const [as, f] of Object.entries(fields)) r[as] = d ? (d[f] ?? null) : null
      }
    }
    return rows
  }

  async ping() {
    await this.db.command({ ping: 1 })
  }
}
