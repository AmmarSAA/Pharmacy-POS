import { Router } from '../lib/router.js'
import { requireRole, PRIVATE_SETTINGS } from '../auth.js'
import { getSettings, setSetting, PROTECTED_SETTINGS } from '../db.js'
import { HttpError } from '../lib/http.js'
import { badRequest } from '../lib/http.js'

const INT_KEYS = ['default_gst_rate_bps', 'near_expiry_days', 'default_margin_bps']
const CHOICES = { round_to_rupee: ['0', '1'], default_sale_unit: ['pack', 'unit'] }

export default function settingsRoutes(db) {
  const r = Router()

  const publicSettings = async () => {
    const s = await getSettings(db)
    for (const k of PRIVATE_SETTINGS) delete s[k]
    return s
  }

  r.get('/', async (req, res) => res.json(await publicSettings()))

  r.put('/', requireRole('admin'), async (req, res) => {
    const current = await publicSettings()
    const updates = []
    for (const key of Object.keys(req.body || {})) {
      // Policy settings belong to the owner (PUT /api/owner/settings with password).
      if (PROTECTED_SETTINGS.includes(key) && String(req.body[key]) !== current[key]) {
        throw new HttpError(403, `Only the owner can change ${key}`)
      }
    }
    for (const [key, value] of Object.entries(req.body || {})) {
      if (!(key in current) || PROTECTED_SETTINGS.includes(key)) continue
      const v = String(value ?? '').trim()
      if (INT_KEYS.includes(key) && !/^\d+$/.test(v)) throw badRequest(`${key} must be a whole number`)
      if (CHOICES[key] && !CHOICES[key].includes(v)) throw badRequest(`${key} must be one of ${CHOICES[key].join(', ')}`)
      if (key === 'cash_denominations' && !/^\d+(,\d+)*$/.test(v)) throw badRequest('Denominations must be numbers separated by commas')
      updates.push([key, v])
    }
    for (const [key, v] of updates) await setSetting(db, key, v)
    res.json(await publicSettings())
  })

  return r
}
