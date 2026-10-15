import { Router } from '../lib/router.js'
import { requirePermission, ROLES, PERMISSIONS, PERMISSION_KEYS } from '../auth.js'
import { HttpError, badRequest, notFound, reqString, oneOf } from '../lib/http.js'
import { audit } from '../lib/audit.js'

const slugify = (name) => name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'role'

function readPermissions(body) {
  const perms = body.permissions
  if (!Array.isArray(perms)) throw badRequest('Permissions must be a list')
  const bad = perms.filter((p) => !PERMISSION_KEYS.includes(p))
  if (bad.length) throw badRequest(`Unknown permission: ${bad.join(', ')}`)
  return [...new Set(perms)]
}

export default function roleRoutes(db) {
  const r = Router()
  r.use(requirePermission('users.manage'))
  const roles = db.col('roles')

  r.get('/permissions', (req, res) => res.json(PERMISSIONS))

  r.get('/', async (req, res) => {
    const rows = await db.all('roles', {}, { sort: { is_system: -1, name: 1 } })
    const counts = await db.col('users').aggregate([{ $group: { _id: '$role_id', n: { $sum: 1 } } }]).toArray()
    const byRoleId = new Map(counts.map((c) => [c._id, c.n]))
    res.json(rows.map((role) => ({ ...role, user_count: byRoleId.get(role.id) || 0 })))
  })

  r.post('/', async (req, res) => {
    const name = reqString(req.body, 'name', 'Name')
    const baseRole = oneOf(req.body.base_role, ROLES, 'Base role')
    const permissions = readPermissions(req.body)
    let key = slugify(name)
    if (await roles.findOne({ key })) key = `${key}_${Date.now().toString(36)}`
    const id = await db.insert('roles', { key, name, base_role: baseRole, is_system: 0, permissions })
    await audit(db, req.user.id, 'role.create', { name, base_role: baseRole, permissions })
    res.status(201).json(await db.get('roles', id))
  })

  r.put('/:id', async (req, res) => {
    const id = Number(req.params.id)
    const role = await db.get('roles', id)
    if (!role) throw notFound('Role')
    const name = req.body.name !== undefined ? reqString(req.body, 'name', 'Name') : role.name
    const baseRole = req.body.base_role !== undefined ? oneOf(req.body.base_role, ROLES, 'Base role') : role.base_role
    const permissions = req.body.permissions !== undefined ? readPermissions(req.body) : role.permissions
    await roles.updateOne({ _id: id }, { $set: { name, base_role: baseRole, permissions } })
    await audit(db, req.user.id, 'role.update', { name, base_role: baseRole, permissions })
    res.json(await db.get('roles', id))
  })

  r.delete('/:id', async (req, res) => {
    const id = Number(req.params.id)
    const role = await db.get('roles', id)
    if (!role) throw notFound('Role')
    if (role.is_system) throw new HttpError(400, 'Built-in roles cannot be deleted')
    const inUse = await db.col('users').countDocuments({ role_id: id })
    if (inUse) throw new HttpError(409, `${inUse} user${inUse === 1 ? '' : 's'} still ${inUse === 1 ? 'has' : 'have'} this role`)
    await roles.deleteOne({ _id: id })
    await audit(db, req.user.id, 'role.delete', { name: role.name })
    res.json({ ok: true })
  })

  return r
}
