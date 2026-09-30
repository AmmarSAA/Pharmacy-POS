import { Router } from 'express'
import { requireRole, PRIVATE_SETTINGS } from '../auth.js'
import { getSettings } from '../db.js'
import { badRequest } from '../lib/http.js'

const INT_KEYS = ['default_gst_rate_bps', 'near_expiry_days', 'default_margin_bps']
const CHOICES = { require_open_till: ['0', '1'], round_to_rupee: ['0', '1'], default_sale_unit: ['pack', 'unit'] }

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
      if (CHOICES[key] && !CHOICES[key].includes(v)) throw badRequest(`${key} must be one of ${CHOICES[key].join(', ')}`)
      if (key === 'cash_denominations' && !/^\d+(,\d+)*$/.test(v)) throw badRequest('Denominations must be numbers separated by commas')
      update.run(v, key)
    }
    res.json(publicSettings())
  })

  return r
}
