import { Router } from '../lib/router.js'
import bcrypt from 'bcryptjs'
import { requirePermission, ROLES } from '../auth.js'
import { HttpError, notFound, reqString, reqInt, oneOf } from '../lib/http.js'
import { audit } from '../lib/audit.js'

const PUBLIC = { projection: { id: 1, username: 1, full_name: 1, role: 1, role_id: 1, active: 1, is_owner: 1, created_at: 1 } }
const present = (u) => u && { ...u, is_owner: u.is_owner || 0 }

// Admins can run the pharmacy; only the owner can make, change or remove admins.
const ownerOnly = (req, what) => {
  if (!req.user.is_owner) throw new HttpError(403, `Only the owner can ${what}`)
}

// A user's role is assigned by role_id (any role, built-in or custom); `role` may still be sent
// as a shorthand for "the built-in role with this key" and is kept, resolved to that role's
// base_role, as a legacy field a few business rules read directly (see auth.js).
async function resolveRole(db, body) {
  if (body.role_id !== undefined) {
    const id = reqInt(body, 'role_id', { min: 1, label: 'Role' })
    const role = await db.get('roles', id)
    if (!role) throw new HttpError(400, 'Role not found')
    return role
  }
  if (body.role !== undefined) {
    const key = oneOf(body.role, ROLES, 'Role')
    const role = await db.col('roles').findOne({ key, is_system: 1 })
    if (!role) throw new HttpError(400, 'Role not found')
    return role
  }
  return null
}

export default function userRoutes(db) {
  const r = Router()
  r.use(requirePermission('users.manage'))
  const users = db.col('users')

  r.get('/', async (req, res) => {
    res.json((await users.find({}, { ...PUBLIC, sort: { active: -1, full_name: 1 } }).toArray()).map(present))
  })

  r.post('/', async (req, res) => {
    const username = reqString(req.body, 'username', 'Username')
    const fullName = reqString(req.body, 'full_name', 'Full name')
    const role = await resolveRole(db, req.body)
    if (!role) throw new HttpError(400, 'Role is required')
    const password = reqString(req.body, 'password', 'Password')
    if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters')
    if (await users.findOne({ username_lc: username.toLowerCase() })) {
      throw new HttpError(409, 'That username is taken')
    }
    if (role.base_role === 'admin') ownerOnly(req, 'add an admin')
    const id = await db.insert('users', {
      username, username_lc: username.toLowerCase(), full_name: fullName, password_hash: bcrypt.hashSync(password, 10),
      role: role.base_role, role_id: role.id, active: 1, is_owner: 0,
    })
    await audit(db, req.user.id, 'user.create', { username, role: role.name })
    res.status(201).json(present(await users.findOne({ _id: id }, PUBLIC)))
  })

  r.patch('/:id', async (req, res) => {
    const id = Number(req.params.id)
    const user = await db.get('users', id)
    if (!user) throw notFound('User')
    const fullName = req.body.full_name?.trim() || user.full_name
    const role = (req.body.role !== undefined || req.body.role_id !== undefined) ? await resolveRole(db, req.body) : null
    const roleId = role ? role.id : user.role_id
    const baseRole = role ? role.base_role : user.role
    const active = req.body.active !== undefined ? (req.body.active ? 1 : 0) : user.active
    if (id === req.user.id && (baseRole !== 'admin' || !active)) {
      throw new HttpError(400, 'You cannot remove your own admin access')
    }
    if (user.is_owner && (baseRole !== 'admin' || !active)) {
      throw new HttpError(400, 'The owner stays an active admin; transfer ownership first')
    }
    if ((user.role === 'admin' || baseRole === 'admin') && id !== req.user.id) ownerOnly(req, 'change an admin account')
    let hash = user.password_hash
    if (req.body.password) {
      if (String(req.body.password).length < 8) throw new HttpError(400, 'Password must be at least 8 characters')
      hash = bcrypt.hashSync(String(req.body.password), 10)
    }
    await users.updateOne({ _id: id }, { $set: { full_name: fullName, role: baseRole, role_id: roleId, active, password_hash: hash } })
    const changed = {}
    if (fullName !== user.full_name) changed.full_name = fullName
    if (roleId !== user.role_id) changed.role = { from: user.role, to: baseRole }
    if (active !== user.active) changed.active = active
    if (hash !== user.password_hash) changed.password = 'reset'
    if (Object.keys(changed).length) await audit(db, req.user.id, 'user.update', { username: user.username, ...changed })
    res.json(present(await users.findOne({ _id: id }, PUBLIC)))
  })

  return r
}
