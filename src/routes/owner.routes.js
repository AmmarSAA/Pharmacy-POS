import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { getSettings, transaction, PROTECTED_SETTINGS } from '../db.js'
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
}

export const requireOwner = (req, res, next) => {
  if (!req.user?.is_owner) return next(new HttpError(403, 'Only the owner can do this'))
  next()
}

// Re-check the owner's password before sensitive changes, so an unattended signed-in screen isn't enough.
function confirmPassword(db, userId, password) {
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId)
  if (!password || !bcrypt.compareSync(String(password), row.password_hash)) {
    throw new HttpError(403, 'Password is incorrect')
  }
}

export default function ownerRoutes(db) {
  const r = Router()
  r.use(requireOwner)

  // Body: { current_password, ...protected settings }
  r.put('/settings', (req, res) => {
    confirmPassword(db, req.user.id, req.body.current_password)
    const before = getSettings(db)
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
    transaction(db, () => {
      const update = db.prepare('UPDATE settings SET value = ? WHERE key = ?')
      for (const [key, { to }] of Object.entries(changes)) update.run(to, key)
      if (Object.keys(changes).length) audit(db, req.user.id, 'settings.update', changes)
    })
    const s = getSettings(db)
    delete s.jwt_secret
    res.json(s)
  })

  r.get('/audit', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 200, 1000)
    const rows = db.prepare(
      `SELECT a.id, a.created_at, a.action, a.detail, u.full_name AS user_name
       FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT ${limit}`,
    ).all()
    res.json(rows.map((row) => ({ ...row, detail: row.detail ? JSON.parse(row.detail) : null })))
  })

  // Body: { user_id, current_password }. The new owner must be an active admin.
  r.post('/transfer', (req, res) => {
    confirmPassword(db, req.user.id, req.body.current_password)
    const userId = reqInt(req.body, 'user_id', { min: 1, label: 'User' })
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(userId)
    if (!target || !target.active || target.role !== 'admin') throw badRequest('Ownership can only go to an active admin')
    if (target.id === req.user.id) throw badRequest('You are already the owner')
    transaction(db, () => {
      db.prepare('UPDATE users SET is_owner = 0 WHERE id = ?').run(req.user.id)
      db.prepare('UPDATE users SET is_owner = 1 WHERE id = ?').run(target.id)
      audit(db, req.user.id, 'owner.transfer', { to: target.username })
    })
    res.json({ owner: { id: target.id, username: target.username, full_name: target.full_name } })
  })

  return r
}

