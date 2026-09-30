import { Router } from 'express'
import bcrypt from 'bcryptjs'
import rateLimit from 'express-rate-limit'
import { createHash, timingSafeEqual } from 'node:crypto'
import { authenticate, signToken, COOKIE } from '../auth.js'
import { HttpError, reqString } from '../lib/http.js'

const cookieOpts = { httpOnly: true, sameSite: 'strict', secure: process.env.COOKIE_SECURE === '1', maxAge: 12 * 3600 * 1000 }

// Slows password guessing: failed attempts per IP in a 15 minute window.
const credentialLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { message: 'Too many attempts. Try again in 15 minutes.' },
})

const digest = (v) => createHash('sha256').update(String(v)).digest()

// When SETUP_TOKEN is set (required on a public server), first-run setup must present it,
// so a stranger cannot claim the admin account before the owner does.
function checkSetupToken(given) {
  const expected = process.env.SETUP_TOKEN
  if (!expected) return
  if (!given || !timingSafeEqual(digest(given), digest(expected))) {
    throw new HttpError(403, 'Setup token is incorrect')
  }
}

export default function authRoutes(db) {
  const r = Router()
  const userCount = () => db.prepare('SELECT COUNT(*) AS n FROM users').get().n

  r.get('/status', (req, res) => {
    res.json({ needsSetup: userCount() === 0, setupTokenRequired: Boolean(process.env.SETUP_TOKEN) })
  })

  // First run only: creates the owner/admin account.
  r.post('/setup', credentialLimiter, (req, res) => {
    if (userCount() > 0) throw new HttpError(409, 'Setup has already been completed')
    checkSetupToken(req.body.setup_token)
    const username = reqString(req.body, 'username', 'Username')
    const fullName = reqString(req.body, 'full_name', 'Full name')
    const password = reqString(req.body, 'password', 'Password')
    if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters')
    const pharmacyName = req.body.pharmacy_name?.trim()
    if (pharmacyName) db.prepare("UPDATE settings SET value = ? WHERE key = 'pharmacy_name'").run(pharmacyName)
    const { lastInsertRowid } = db
      .prepare("INSERT INTO users (username, full_name, password_hash, role) VALUES (?, ?, ?, 'admin')")
      .run(username, fullName, bcrypt.hashSync(password, 10))
    const user = { id: Number(lastInsertRowid), username, full_name: fullName, role: 'admin' }
    res.cookie(COOKIE, signToken(db, user), cookieOpts).status(201).json({ user })
  })

  r.post('/login', credentialLimiter, (req, res) => {
    const username = reqString(req.body, 'username', 'Username')
    const password = reqString(req.body, 'password', 'Password')
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username)
    if (!user || !user.active || !bcrypt.compareSync(password, user.password_hash)) {
      throw new HttpError(401, 'Incorrect username or password')
    }
    const { password_hash, ...safe } = user
    res.cookie(COOKIE, signToken(db, user), cookieOpts).json({ user: safe, token: signToken(db, user) })
  })

  r.post('/logout', (req, res) => {
    res.clearCookie(COOKIE, { ...cookieOpts, maxAge: undefined }).json({ ok: true })
  })

  r.get('/me', authenticate(db), (req, res) => res.json({ user: req.user }))

  r.post('/change-password', credentialLimiter, authenticate(db), (req, res) => {
    const current = reqString(req.body, 'current_password', 'Current password')
    const next = reqString(req.body, 'new_password', 'New password')
    if (next.length < 8) throw new HttpError(400, 'New password must be at least 8 characters')
    const { password_hash } = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id)
    if (!bcrypt.compareSync(current, password_hash)) throw new HttpError(400, 'Current password is incorrect')
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(next, 10), req.user.id)
    res.json({ ok: true })
  })

  return r
}
