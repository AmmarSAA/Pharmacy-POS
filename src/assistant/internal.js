// Runs a request through this same Express app in-process (no socket, no network), so assistant
// tools reuse each route's validation and role checks. Works the same under Node and inside the
// Cloudflare Durable Object: req/res are plain objects that Express adopts as its own.
import { signToken } from '../auth.js'

const noop = function () { return this }

export function inject(app, { method = 'GET', url, body, token }) {
  return new Promise((resolve) => {
    const headers = { host: 'assistant.internal', authorization: `Bearer ${token}` }
    if (body !== undefined) headers['content-type'] = 'application/json'
    const socket = { remoteAddress: '127.0.0.1', encrypted: false, destroy() {} }
    const req = {
      method, url, headers, socket, connection: socket,
      // Already "parsed": express.json() and cookie-parser skip their work.
      body: body ?? {}, _body: true, cookies: {}, signedCookies: {},
      httpVersion: '1.1', httpVersionMajor: 1, httpVersionMinor: 1, complete: true,
      on: noop, once: noop, off: noop, removeListener: noop, emit: () => false, resume: noop, pause: noop, unpipe: noop,
    }
    const out = {}
    let done = false
    const finish = (chunk) => {
      if (done) return
      done = true
      res.headersSent = true
      res.finished = true
      const text = chunk == null ? '' : typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
      let data = text
      try { data = text ? JSON.parse(text) : null } catch { /* not JSON */ }
      resolve({ status: res.statusCode, body: data })
    }
    const res = {
      statusCode: 200, statusMessage: '', headersSent: false, finished: false, writableEnded: false,
      setHeader(n, v) { out[String(n).toLowerCase()] = v; return this },
      getHeader: (n) => out[String(n).toLowerCase()],
      getHeaders: () => ({ ...out }),
      getHeaderNames: () => Object.keys(out),
      hasHeader: (n) => String(n).toLowerCase() in out,
      removeHeader(n) { delete out[String(n).toLowerCase()] },
      writeHead(code) { this.statusCode = code; return this },
      write: () => true,
      end(chunk) { finish(chunk); return this },
      on: noop, once: noop, off: noop, removeListener: noop, emit: () => false,
    }
    // The final callback only runs if no route answered (the API has its own 404 handler).
    app.handle(req, res, (err) => {
      if (done) return
      res.statusCode = err?.status || (err ? 500 : 404)
      finish(JSON.stringify({ message: err?.message || 'Not found' }))
    })
  })
}

// A caller bound to one signed-in user: call('GET', '/products?q=x') -> body, or throws { status, message }.
export function apiAs(app, db, user) {
  const token = signToken(db, user)
  return async (method, path, body) => {
    const r = await inject(app, { method, url: '/api' + path, body, token })
    if (r.status >= 400) {
      throw Object.assign(new Error(r.body?.message || `Request failed (${r.status})`), { status: r.status })
    }
    return r.body
  }
}
