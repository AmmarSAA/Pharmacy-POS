import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { requireRole, ROLES } from '../auth.js'
import { HttpError, notFound, reqString, oneOf } from '../lib/http.js'

const COLS = 'id, username, full_name, role, active, created_at'

export default function userRoutes(db) {
  const r = Router()
  r.use(requireRole('admin'))

  r.get('/', (req, res) => {
    res.json(db.prepare(`SELECT ${COLS} FROM users ORDER BY active DESC, full_name`).all())
  })

  r.post('/', (req, res) => {
    const username = reqString(req.body, 'username', 'Username')
    const fullName = reqString(req.body, 'full_name', 'Full name')
    const role = oneOf(req.body.role, ROLES, 'Role')
    const password = reqString(req.body, 'password', 'Password')
    if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters')
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
      throw new HttpError(409, 'That username is taken')
    }
    const { lastInsertRowid } = db
      .prepare('INSERT INTO users (username, full_name, password_hash, role) VALUES (?, ?, ?, ?)')
      .run(username, fullName, bcrypt.hashSync(password, 10), role)
    res.status(201).json(db.prepare(`SELECT ${COLS} FROM users WHERE id = ?`).get(lastInsertRowid))
  })

  r.patch('/:id', (req, res) => {
    const id = Number(req.params.id)
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id)
    if (!user) throw notFound('User')
    const fullName = req.body.full_name?.trim() || user.full_name
    const role = req.body.role !== undefined ? oneOf(req.body.role, ROLES, 'Role') : user.role
    const active = req.body.active !== undefined ? (req.body.active ? 1 : 0) : user.active
    if (id === req.user.id && (role !== 'admin' || !active)) {
      throw new HttpError(400, 'You cannot remove your own admin access')
    }
    let hash = user.password_hash
    if (req.body.password) {
      if (String(req.body.password).length < 8) throw new HttpError(400, 'Password must be at least 8 characters')
      hash = bcrypt.hashSync(String(req.body.password), 10)
    }
    db.prepare('UPDATE users SET full_name = ?, role = ?, active = ?, password_hash = ? WHERE id = ?')
      .run(fullName, role, active, hash, id)
    res.json(db.prepare(`SELECT ${COLS} FROM users WHERE id = ?`).get(id))
  })

  return r
}
