import { Router } from '../lib/router.js'
import bcrypt from 'bcryptjs'
import { requireRole, ROLES } from '../auth.js'
import { HttpError, notFound, reqString, oneOf } from '../lib/http.js'
import { audit } from '../lib/audit.js'

const PUBLIC = { projection: { id: 1, username: 1, full_name: 1, role: 1, active: 1, is_owner: 1, created_at: 1 } }
const present = (u) => u && { ...u, is_owner: u.is_owner || 0 }

// Admins can run the pharmacy; only the owner can make, change or remove admins.
const ownerOnly = (req, what) => {
  if (!req.user.is_owner) throw new HttpError(403, `Only the owner can ${what}`)
}

export default function userRoutes(db) {
  const r = Router()
  r.use(requireRole('admin'))
  const users = db.col('users')

  r.get('/', async (req, res) => {
    res.json((await users.find({}, { ...PUBLIC, sort: { active: -1, full_name: 1 } }).toArray()).map(present))
  })

  r.post('/', async (req, res) => {
    const username = reqString(req.body, 'username', 'Username')
    const fullName = reqString(req.body, 'full_name', 'Full name')
    const role = oneOf(req.body.role, ROLES, 'Role')
    const password = reqString(req.body, 'password', 'Password')
    if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters')
    if (await users.findOne({ username_lc: username.toLowerCase() })) {
      throw new HttpError(409, 'That username is taken')
    }
    if (role === 'admin') ownerOnly(req, 'add an admin')
    const id = await db.insert('users', {
      username, username_lc: username.toLowerCase(), full_name: fullName, password_hash: bcrypt.hashSync(password, 10),
      role, active: 1, is_owner: 0,
    })
    await audit(db, req.user.id, 'user.create', { username, role })
    res.status(201).json(present(await users.findOne({ _id: id }, PUBLIC)))
  })

  r.patch('/:id', async (req, res) => {
    const id = Number(req.params.id)
    const user = await db.get('users', id)
    if (!user) throw notFound('User')
    const fullName = req.body.full_name?.trim() || user.full_name
    const role = req.body.role !== undefined ? oneOf(req.body.role, ROLES, 'Role') : user.role
    const active = req.body.active !== undefined ? (req.body.active ? 1 : 0) : user.active
    if (id === req.user.id && (role !== 'admin' || !active)) {
      throw new HttpError(400, 'You cannot remove your own admin access')
    }
    if (user.is_owner && (role !== 'admin' || !active)) {
      throw new HttpError(400, 'The owner stays an active admin; transfer ownership first')
    }
    if ((user.role === 'admin' || role === 'admin') && id !== req.user.id) ownerOnly(req, 'change an admin account')
    let hash = user.password_hash
    if (req.body.password) {
      if (String(req.body.password).length < 8) throw new HttpError(400, 'Password must be at least 8 characters')
      hash = bcrypt.hashSync(String(req.body.password), 10)
    }
    await users.updateOne({ _id: id }, { $set: { full_name: fullName, role, active, password_hash: hash } })
    const changed = {}
    if (fullName !== user.full_name) changed.full_name = fullName
    if (role !== user.role) changed.role = { from: user.role, to: role }
    if (active !== user.active) changed.active = active
    if (hash !== user.password_hash) changed.password = 'reset'
    if (Object.keys(changed).length) await audit(db, req.user.id, 'user.update', { username: user.username, ...changed })
    res.json(present(await users.findOne({ _id: id }, PUBLIC)))
  })

  return r
}
