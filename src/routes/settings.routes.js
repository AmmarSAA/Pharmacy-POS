import { Router } from 'express'
import { requireRole, PRIVATE_SETTINGS } from '../auth.js'
import { getSettings } from '../db.js'
import { badRequest } from '../lib/http.js'

const INT_KEYS = ['default_gst_rate_bps', 'near_expiry_days']

export default function settingsRoutes(db) {
  const r = Router()

  const publicSettings = () => {
    const s = getSettings(db)
    for (const k of PRIVATE_SETTINGS) delete s[k]
    return s
  }

  r.get('/', (req, res) => res.json(publicSettings()))

  r.put('/', requireRole('admin'), (req, res) => {
    const current = publicSettings()
    const update = db.prepare('UPDATE settings SET value = ? WHERE key = ?')
    for (const [key, value] of Object.entries(req.body || {})) {
      if (!(key in current)) continue
      const v = String(value ?? '').trim()
      if (INT_KEYS.includes(key) && !/^\d+$/.test(v)) throw badRequest(`${key} must be a whole number`)
      update.run(v, key)
    }
    res.json(publicSettings())
  })

  return r
}
