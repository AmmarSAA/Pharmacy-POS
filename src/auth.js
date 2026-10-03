import jwt from 'jsonwebtoken'
import { randomBytes } from 'node:crypto'
import { HttpError } from './lib/http.js'

export const ROLES = ['admin', 'pharmacist', 'cashier']
export const COOKIE = 'pos_token'

// Use JWT_SECRET if given, otherwise generate one per database so a till works with zero config.
// Cached per store after the first read (it never changes once created).
const secrets = new WeakMap()
export async function jwtSecret(db) {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET
  if (secrets.has(db)) return secrets.get(db)
  const col = db.col('settings').raw
  await col.updateOne({ _id: 'jwt_secret' }, { $setOnInsert: { value: randomBytes(48).toString('hex') } }, { upsert: true })
  const secret = (await col.findOne({ _id: 'jwt_secret' })).value
  secrets.set(db, secret)
  return secret
}

export async function signToken(db, user) {
  return jwt.sign({ sub: user.id, role: user.role }, await jwtSecret(db), { expiresIn: '12h' })
}

export function authenticate(db) {
  return async (req, res, next) => {
    const header = req.get('authorization')
    const token = req.cookies?.[COOKIE] || (header?.startsWith('Bearer ') ? header.slice(7) : null)
    if (!token) return next(new HttpError(401, 'Please sign in'))
    let payload
    try {
      payload = jwt.verify(token, await jwtSecret(db))
    } catch {
      return next(new HttpError(401, 'Session expired, please sign in again'))
    }
    // Re-read the user so deactivation and role changes take effect immediately.
    let user
    try {
      user = await db.col('users').findOne(
        { _id: Number(payload.sub) }, { projection: { id: 1, username: 1, full_name: 1, role: 1, active: 1, is_owner: 1 } },
      )
    } catch (err) {
      return next(err)
    }
    if (user) user.is_owner = user.is_owner || 0
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
