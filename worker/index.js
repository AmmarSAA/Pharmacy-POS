// Cloudflare Workers entry point. The whole app runs inside one Durable Object, whose
// built-in SQLite storage is the pharmacy database (one object = one pharmacy, one writer).
import { DurableObject } from 'cloudflare:workers'
import { httpServerHandler } from 'cloudflare:node'
import { createServer } from 'node:http'
import { createApp } from '../src/app.js'
import { initDb, configureClock } from '../src/db.js'
import { SqlStorageDb } from './sql-storage-db.js'
import staticFiles from './static-files.gen.js'

const PORT = 8080
const INSTANCE_HEADER = 'x-pharmacy-store'

// One HTTP server per isolate, started once at load. A Durable Object can be re-created in an
// isolate that already bound the port (after eviction or a restart), so objects must not listen
// themselves. Each object registers its Express app here and tags its requests with its id.
const apps = new Map()
createServer((req, res) => {
  const app = apps.get(req.headers[INSTANCE_HEADER])
  if (!app) {
    res.statusCode = 503
    res.end('Store not ready')
    return
  }
  app(req, res)
}).listen(PORT)
const handler = httpServerHandler({ port: PORT })

export class PharmacyStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env)
    configureClock(env.UTC_OFFSET_MINUTES ?? 300)
    this.instanceId = ctx.id.toString()
    const db = initDb(new SqlStorageDb(ctx.storage))
    apps.set(this.instanceId, createApp(db, { staticFiles }))
  }

  fetch(request) {
    const headers = new Headers(request.headers)
    headers.set(INSTANCE_HEADER, this.instanceId)
    return handler.fetch(new Request(request, { headers }), this.env, this.ctx)
  }
}

export default {
  fetch(request, env) {
    // Pass the real visitor IP in a header the visitor can't set, for login rate limiting.
    const headers = new Headers(request.headers)
    headers.set('x-client-ip', request.headers.get('cf-connecting-ip') || '')
    headers.delete(INSTANCE_HEADER)
    const store = env.STORE.get(env.STORE.idFromName(env.STORE_NAME || 'main'))
    return store.fetch(new Request(request, { headers }))
  },
}
