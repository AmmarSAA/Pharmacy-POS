import { Router } from '../lib/router.js'
import bcrypt from 'bcryptjs'
import { getSettings, setSetting, PROTECTED_SETTINGS } from '../db.js'
import { PRIVATE_SETTINGS } from '../auth.js'
import { HttpError, badRequest, reqInt } from '../lib/http.js'
import { audit } from '../lib/audit.js'

// Values each protected setting may take.
const PROTECTED_RULES = {
  require_open_till: ['0', '1'],
  refund_card_sales: ['drawer', 'original'],
  opening_balance_due: ['terms', 'immediate'],
  max_discount_cashier_bps: 'bps',
  max_discount_pharmacist_bps: 'bps',
  max_discount_admin_bps: 'bps',
  assistant_enabled: ['0', '1'],
}

export const requireOwner = (req, res, next) => {
  if (!req.user?.is_owner) return next(new HttpError(403, 'Only the owner can do this'))
  next()
}

// Re-check the owner's password before sensitive changes, so an unattended signed-in screen isn't enough.
export async function confirmPassword(db, userId, password) {
  const row = await db.get('users', userId)
  if (!password || !bcrypt.compareSync(String(password), row.password_hash)) {
    throw new HttpError(403, 'Password is incorrect')
  }
}

export default function ownerRoutes(db) {
  const r = Router()
  r.use(requireOwner)

  // Body: { current_password, ...protected settings }
  r.put('/settings', async (req, res) => {
    await confirmPassword(db, req.user.id, req.body.current_password)
    const before = await getSettings(db)
    const changes = {}
    for (const [key, value] of Object.entries(req.body || {})) {
      if (key === 'current_password') continue
      if (!PROTECTED_SETTINGS.includes(key)) throw badRequest(`${key} is not an owner setting`)
      const v = String(value ?? '').trim()
      const rule = PROTECTED_RULES[key]
      if (rule === 'bps' && !(/^\d+$/.test(v) && Number(v) <= 10000)) throw badRequest(`${key} must be 0 to 10000`)
      if (Array.isArray(rule) && !rule.includes(v)) throw badRequest(`${key} must be one of ${rule.join(', ')}`)
      if (before[key] !== v) changes[key] = { from: before[key], to: v }
    }
    await db.tx(async () => {
      for (const [key, { to }] of Object.entries(changes)) await setSetting(db, key, to)
      if (Object.keys(changes).length) await audit(db, req.user.id, 'settings.update', changes)
    })
    const s = await getSettings(db)
    for (const k of PRIVATE_SETTINGS) delete s[k]
    res.json(s)
  })

  r.get('/audit', async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 200, 1000)
    const rows = await db.all('audit_log', {}, { sort: { id: -1 }, limit })
    await db.join(rows, [{ key: 'user_id', from: 'users', fields: { user_name: 'full_name' } }])
    res.json(rows.map((row) => ({
      id: row.id, created_at: row.created_at, action: row.action, detail: row.detail ? JSON.parse(row.detail) : null, user_name: row.user_name,
    })))
  })

  // Body: { user_id, current_password }. The new owner must be an active admin.
  r.post('/transfer', async (req, res) => {
    await confirmPassword(db, req.user.id, req.body.current_password)
    const userId = reqInt(req.body, 'user_id', { min: 1, label: 'User' })
    const target = await db.get('users', userId)
    if (!target || !target.active || target.role !== 'admin') throw badRequest('Ownership can only go to an active admin')
    if (target.id === req.user.id) throw badRequest('You are already the owner')
    await db.tx(async () => {
      await db.col('users').updateOne({ _id: req.user.id }, { $set: { is_owner: 0 } })
      await db.col('users').updateOne({ _id: target.id }, { $set: { is_owner: 1 } })
      await audit(db, req.user.id, 'owner.transfer', { to: target.username })
    })
    res.json({ owner: { id: target.id, username: target.username, full_name: target.full_name } })
  })

  return r
}

