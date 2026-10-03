// Cloudflare Workers entry point. The whole app runs inside one Durable Object, which holds the
// MongoDB Atlas connection (MONGODB_URI secret) for all requests. The object's own SQLite storage
// held the database before the move to MongoDB; it is left untouched.
import { DurableObject } from 'cloudflare:workers'
import { httpServerHandler } from 'cloudflare:node'
import { createServer } from 'node:http'
import { createApp } from '../src/app.js'
import { MongoClient } from 'mongodb'
import { initDb, configureClock } from '../src/db.js'
import { Store } from '../src/store.js'
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
  }

  // Connects on the first request (sockets can't be opened at startup) and reuses the client.
  ready() {
    if (!this.starting) {
      this.starting = (async () => {
        if (!this.env.MONGODB_URI) throw new Error('MONGODB_URI is not set')
        const client = await MongoClient.connect(this.env.MONGODB_URI, {
          appName: 'pharmacy-pos', maxPoolSize: 10, serverSelectionTimeoutMS: 10000,
        })
        const db = await initDb(new Store(client, client.db(this.env.MONGODB_DB || 'pharmacy')))
        apps.set(this.instanceId, createApp(db, { staticFiles }))
      })().catch((err) => {
        this.starting = null
        throw err
      })
    }
    return this.starting
  }

  async fetch(request) {
    try {
      await this.ready()
    } catch (err) {
      console.error('database connection failed:', err.message)
      return Response.json({ message: 'The database is not reachable. Try again in a minute.' }, { status: 503 })
    }
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
