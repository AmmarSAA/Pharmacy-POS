import express from 'express'
import { fileURLToPath } from 'node:url'
import helmet from 'helmet'
import cookieParser from 'cookie-parser'
import { authenticate } from './auth.js'
import { Router } from './lib/router.js'
import authRoutes from './routes/auth.routes.js'
import userRoutes from './routes/users.routes.js'
import settingsRoutes from './routes/settings.routes.js'
import productRoutes from './routes/products.routes.js'
import supplierRoutes from './routes/suppliers.routes.js'
import purchaseRoutes from './routes/purchases.routes.js'
import inventoryRoutes from './routes/inventory.routes.js'
import saleRoutes from './routes/sales.routes.js'
import reportRoutes from './routes/reports.routes.js'
import tillRoutes from './routes/tills.routes.js'
import issueRoutes, { departmentRoutes, issueRequestRoutes } from './routes/issues.routes.js'
import ownerRoutes from './routes/owner.routes.js'
import dashboardRoutes from './routes/dashboard.routes.js'
import assistantRoutes from './routes/assistant.routes.js'

// publicDir: folder with the browser app on disk (Node).
// staticFiles: { '/path': { type, body } } used instead when there is no file system (Cloudflare).
export function createApp(db, { publicDir, staticFiles } = {}) {
  if (publicDir === undefined && !staticFiles) publicDir = fileURLToPath(new URL('../public', import.meta.url))
  const app = express()
  app.disable('x-powered-by')
  // Behind a reverse proxy / load balancer, set TRUST_PROXY to the number of proxy hops
  // so client IPs (used for login rate limiting) are read correctly.
  if (process.env.TRUST_PROXY) {
    const v = process.env.TRUST_PROXY
    app.set('trust proxy', /^\d+$/.test(v) ? Number(v) : v === 'true' ? true : v)
  }
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          'script-src': ["'self'"],
          // Tills usually reach the server over plain http on the shop LAN.
          'upgrade-insecure-requests': null,
        },
      },
      strictTransportSecurity: false,
    }),
  )
  // 3 MB: voice notes for the assistant arrive base64-encoded in JSON.
  app.use(express.json({ limit: '3mb' }))
  app.use(cookieParser())

  app.get('/healthz', async (req, res, next) => {
    try {
      await db.ping()
      res.json({ ok: true })
    } catch (err) {
      next(err)
    }
  })

  const api = Router()
  api.use('/auth', authRoutes(db))
  api.use(authenticate(db))
  api.use('/users', userRoutes(db))
  api.use('/settings', settingsRoutes(db))
  api.use('/products', productRoutes(db))
  api.use('/suppliers', supplierRoutes(db))
  api.use('/purchases', purchaseRoutes(db))
  api.use('/inventory', inventoryRoutes(db))
  api.use('/sales', saleRoutes(db))
  api.use('/reports', reportRoutes(db))
  api.use('/tills', tillRoutes(db))
  api.use('/departments', departmentRoutes(db))
  api.use('/issue-requests', issueRequestRoutes(db))
  api.use('/issues', issueRoutes(db))
  api.use('/owner', ownerRoutes(db))
  api.use('/dashboard', dashboardRoutes(db))
  api.use('/assistant', assistantRoutes(db))
  api.use((req, res) => res.status(404).json({ message: 'Not found' }))
  app.use('/api', api)

  if (publicDir) app.use(express.static(publicDir))
  if (staticFiles) {
    app.get('*', (req, res, next) => {
      const file = staticFiles[req.path === '/' ? '/index.html' : req.path]
      if (!file) return next()
      res.type(file.type).set('cache-control', 'no-cache').send(file.body)
    })
  }

  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ message: 'Invalid JSON' })
    // Unique index hit (two requests creating the same thing at once).
    if (err.code === 11000) return res.status(409).json({ message: 'That already exists' })
    const status = err.status || 500
    if (status >= 500) console.error(err)
    res.status(status).json({ message: status >= 500 ? 'Something went wrong' : err.message })
  })

  return app
}
