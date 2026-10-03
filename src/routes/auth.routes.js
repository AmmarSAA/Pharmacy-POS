import { Router } from '../lib/router.js'
import bcrypt from 'bcryptjs'
import rateLimit from 'express-rate-limit'
import { createHash, timingSafeEqual } from 'node:crypto'
import { authenticate, signToken, COOKIE } from '../auth.js'
import { HttpError, reqString } from '../lib/http.js'
import { setSetting } from '../db.js'

const cookieOptions = () => ({
  httpOnly: true,
  sameSite: 'strict',
  secure: process.env.COOKIE_SECURE === '1',
  maxAge: 12 * 3600 * 1000,
})

// Slows password guessing: failed attempts per IP in a 15 minute window.
const makeCredentialLimiter = () =>
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    skipSuccessfulRequests: true,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // On Cloudflare the Worker passes the visitor's IP in a header it controls (CLIENT_IP_HEADER).
    keyGenerator: (req) => (process.env.CLIENT_IP_HEADER && req.get(process.env.CLIENT_IP_HEADER)) || req.ip || 'unknown',
    validate: { ip: false },
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
  // Created per app (not at import time): its store starts a timer, which Cloudflare forbids at startup.
  const credentialLimiter = makeCredentialLimiter()
  const userCount = () => db.col('users').countDocuments({})

  r.get('/status', async (req, res) => {
    res.json({ needsSetup: (await userCount()) === 0, setupTokenRequired: Boolean(process.env.SETUP_TOKEN) })
  })

  // First run only: creates the owner/admin account.
  r.post('/setup', credentialLimiter, async (req, res) => {
    if ((await userCount()) > 0) throw new HttpError(409, 'Setup has already been completed')
    checkSetupToken(req.body.setup_token)
    const username = reqString(req.body, 'username', 'Username')
    const fullName = reqString(req.body, 'full_name', 'Full name')
    const password = reqString(req.body, 'password', 'Password')
    if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters')
    const pharmacyName = req.body.pharmacy_name?.trim()
    if (pharmacyName) await setSetting(db, 'pharmacy_name', pharmacyName)
    // The unique username index makes a second, simultaneous setup fail instead of creating two owners.
    const id = await db.insert('users', {
      username, username_lc: username.toLowerCase(), full_name: fullName, password_hash: bcrypt.hashSync(password, 10),
      role: 'admin', active: 1, is_owner: 1,
    })
    if ((await userCount()) > 1) {
      await db.col('users').deleteOne({ _id: id })
      throw new HttpError(409, 'Setup has already been completed')
    }
    const user = { id, username, full_name: fullName, role: 'admin', is_owner: 1 }
    res.cookie(COOKIE, await signToken(db, user), cookieOptions()).status(201).json({ user })
  })

  r.post('/login', credentialLimiter, async (req, res) => {
    const username = reqString(req.body, 'username', 'Username')
    const password = reqString(req.body, 'password', 'Password')
    const user = await db.col('users').findOne({ username_lc: username.toLowerCase() })
    if (!user || !user.active || !bcrypt.compareSync(password, user.password_hash)) {
      throw new HttpError(401, 'Incorrect username or password')
    }
    const { password_hash, username_lc, ...safe } = user
    safe.is_owner = safe.is_owner || 0
    const token = await signToken(db, user)
    res.cookie(COOKIE, token, cookieOptions()).json({ user: safe, token })
  })

  r.post('/logout', (req, res) => {
    res.clearCookie(COOKIE, { ...cookieOptions(), maxAge: undefined }).json({ ok: true })
  })

  r.get('/me', authenticate(db), (req, res) => res.json({ user: req.user }))

  r.post('/change-password', credentialLimiter, authenticate(db), async (req, res) => {
    const current = reqString(req.body, 'current_password', 'Current password')
    const next = reqString(req.body, 'new_password', 'New password')
    if (next.length < 8) throw new HttpError(400, 'New password must be at least 8 characters')
    const { password_hash } = await db.get('users', req.user.id)
    if (!bcrypt.compareSync(current, password_hash)) throw new HttpError(400, 'Current password is incorrect')
    await db.col('users').updateOne({ _id: req.user.id }, { $set: { password_hash: bcrypt.hashSync(next, 10) } })
    res.json({ ok: true })
  })

  return r
}
