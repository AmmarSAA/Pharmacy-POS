// Cloudflare Workers entry point. The whole app runs inside one Durable Object, whose
// built-in SQLite storage is the pharmacy database (one object = one pharmacy, one writer).
import { DurableObject } from 'cloudflare:workers'
import { httpServerHandler } from 'cloudflare:node'
import { createApp } from '../src/app.js'
import { initDb, configureClock } from '../src/db.js'
import { SqlStorageDb } from './sql-storage-db.js'
import staticFiles from './static-files.gen.js'

const PORT = 8080

export class PharmacyStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env)
    configureClock(env.UTC_OFFSET_MINUTES ?? 300)
    const db = initDb(new SqlStorageDb(ctx.storage))
    createApp(db, { staticFiles }).listen(PORT)
    this.handler = httpServerHandler({ port: PORT })
  }

  fetch(request) {
    return this.handler.fetch(request, this.env, this.ctx)
  }
}

export default {
  fetch(request, env) {
    // Pass the real visitor IP in a header the visitor can't set, for login rate limiting.
    const headers = new Headers(request.headers)
    headers.set('x-client-ip', request.headers.get('cf-connecting-ip') || '')
    const store = env.STORE.get(env.STORE.idFromName(env.STORE_NAME || 'main'))
    return store.fetch(new Request(request, { headers }))
  },
}
