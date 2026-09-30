import express from 'express'
import helmet from 'helmet'
import cookieParser from 'cookie-parser'
import { fileURLToPath } from 'node:url'
import { authenticate } from './auth.js'
import authRoutes from './routes/auth.routes.js'
import userRoutes from './routes/users.routes.js'
import settingsRoutes from './routes/settings.routes.js'
import productRoutes from './routes/products.routes.js'
import supplierRoutes from './routes/suppliers.routes.js'
import purchaseRoutes from './routes/purchases.routes.js'
import inventoryRoutes from './routes/inventory.routes.js'
import saleRoutes from './routes/sales.routes.js'
import reportRoutes from './routes/reports.routes.js'

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url))

export function createApp(db) {
  const app = express()
  app.disable('x-powered-by')
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
  app.use(express.json({ limit: '1mb' }))
  app.use(cookieParser())

  const api = express.Router()
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
  api.use((req, res) => res.status(404).json({ message: 'Not found' }))
  app.use('/api', api)

  app.use(express.static(PUBLIC_DIR))

  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ message: 'Invalid JSON' })
    const status = err.status || 500
    if (status >= 500) console.error(err)
    res.status(status).json({ message: status >= 500 ? 'Something went wrong' : err.message })
  })

  return app
}
