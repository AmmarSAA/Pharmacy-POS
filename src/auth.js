import jwt from 'jsonwebtoken'
import { randomBytes } from 'node:crypto'
import { HttpError } from './lib/http.js'

export const ROLES = ['admin', 'pharmacist', 'cashier']
export const COOKIE = 'pos_token'

// Use JWT_SECRET if given, otherwise generate one per database so a till works with zero config.
export function jwtSecret(db) {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET
  const row = db.prepare("SELECT value FROM settings WHERE key = 'jwt_secret'").get()
  if (row) return row.value
  const secret = randomBytes(48).toString('hex')
  db.prepare("INSERT INTO settings (key, value) VALUES ('jwt_secret', ?)").run(secret)
  return secret
}

export function signToken(db, user) {
  return jwt.sign({ sub: user.id, role: user.role }, jwtSecret(db), { expiresIn: '12h' })
}

export function authenticate(db) {
  return (req, res, next) => {
    const header = req.get('authorization')
    const token = req.cookies?.[COOKIE] || (header?.startsWith('Bearer ') ? header.slice(7) : null)
    if (!token) return next(new HttpError(401, 'Please sign in'))
    let payload
    try {
      payload = jwt.verify(token, jwtSecret(db))
    } catch {
      return next(new HttpError(401, 'Session expired, please sign in again'))
    }
    // Re-read the user so deactivation and role changes take effect immediately.
    const user = db
      .prepare('SELECT id, username, full_name, role, active, is_owner FROM users WHERE id = ?')
      .get(payload.sub)
    if (!user || !user.active) return next(new HttpError(401, 'Account is disabled'))
    req.user = user
    next()
  }
}

export const requireRole = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user?.role)) {
    return next(new HttpError(403, 'You do not have permission to do this'))
  }
  next()
}

// Settings keys that must never be exposed or edited through the API.
// assistant_api_key: a Groq key saved by the owner (the GROQ_API_KEY secret takes precedence).
export const PRIVATE_SETTINGS = ['jwt_secret', 'assistant_api_key']
