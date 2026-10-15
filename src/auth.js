import jwt from 'jsonwebtoken'
import { randomBytes } from 'node:crypto'
import { HttpError } from './lib/http.js'
export { requirePermission, PERMISSIONS, PERMISSION_KEYS, SYSTEM_ROLES } from './lib/permissions.js'

// The 3 fixed base roles. A handful of business rules key off req.user.role directly (discount
// caps by role, cashiers barred from controlled drugs, cashiers seeing only their own sales/tills)
// — every custom role declares one of these as its base_role so those rules keep working for it.
// Everything else (which screens/API routes a user may use) is gated by permissions; see lib/permissions.js.
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

// Adds `permissions` (from the user's role document) to a user object. Used by authenticate() on
// every request and by auth.routes.js so login/setup responses carry permissions from the start,
// without a second round trip to /auth/me.
export async function withPermissions(db, user) {
  if (!user) return user
  const role = user.role_id
    ? await db.cached('roles', `id:${user.role_id}`, 30000, () => db.col('roles').findOne({ _id: user.role_id }))
    : null
  return { ...user, permissions: role?.permissions || [], role_name: role?.name || null, is_owner: user.is_owner || 0 }
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
      // Cached briefly; any change to a user (role, deactivation, password) clears it at once.
      const found = await db.cached('users', `auth:${Number(payload.sub)}`, 30000, () => db.col('users').findOne(
        { _id: Number(payload.sub) }, { projection: { id: 1, username: 1, full_name: 1, role: 1, role_id: 1, active: 1, is_owner: 1 } },
      ))
      user = found && (await withPermissions(db, { ...found }))
    } catch (err) {
      return next(err)
    }
    if (!user || !user.active) return next(new HttpError(401, 'Account is disabled'))
    req.user = user
    next()
  }
}

// Settings keys that must never be exposed or edited through the API.
// assistant_api_key: a Groq key saved by the owner (the GROQ_API_KEY secret takes precedence).
export const PRIVATE_SETTINGS = ['jwt_secret', 'assistant_api_key']
