import { Router } from '../lib/router.js'
import { requirePermission } from '../auth.js'
import { badRequest, notFound, reqString, optString, optInt, optDate } from '../lib/http.js'

const flag = (v) => (v === undefined || v === null || v === '' ? 1 : v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0)

function read(b) {
  const salary = optInt(b, 'salary', 0, { min: 0, label: 'Salary' })
  if (salary < 0) throw badRequest('Salary cannot be negative')
  return {
    full_name: reqString(b, 'full_name', 'Full name'),
    user_id: optInt(b, 'user_id', null, { min: 1, label: 'Linked user' }),
    job_title: optString(b, 'job_title'),
    phone: optString(b, 'phone'),
    address: optString(b, 'address'),
    cnic: optString(b, 'cnic'),
    hire_date: optDate(b, 'hire_date', 'Hire date'),
    salary,
    emergency_contact_name: optString(b, 'emergency_contact_name'),
    emergency_contact_phone: optString(b, 'emergency_contact_phone'),
    notes: optString(b, 'notes'),
    active: flag(b?.active),
  }
}

export default function employeeRoutes(db) {
  const r = Router()
  r.use(requirePermission('hr.manage'))

  const getEmployee = async (id) => {
    const e = await db.get('employees', Number(id))
    if (!e) throw notFound('Employee')
    return e
  }

  // ?active=1 hides inactive employees.
  r.get('/', async (req, res) => {
    let rows = await db.all('employees', {}, { sort: { full_name: 1 } })
    if (req.query.active === '1') rows = rows.filter((e) => e.active)
    res.json(await db.join(rows, [{ key: 'user_id', from: 'users', fields: { username: 'username', role: 'role' } }]))
  })

  r.post('/', async (req, res) => {
    const body = read(req.body)
    if (body.user_id) {
      if (!(await db.get('users', body.user_id))) throw badRequest('Linked user not found')
      if (await db.col('employees').findOne({ user_id: body.user_id })) throw badRequest('That user already has an employee record')
    }
    const id = await db.insert('employees', body)
    res.status(201).json(await getEmployee(id))
  })

  r.get('/:id', async (req, res) => {
    const e = await getEmployee(req.params.id)
    res.json((await db.join([e], [{ key: 'user_id', from: 'users', fields: { username: 'username', role: 'role' } }]))[0])
  })

  r.put('/:id', async (req, res) => {
    const existing = await getEmployee(req.params.id)
    const body = read({ ...existing, ...req.body })
    if (body.user_id && body.user_id !== existing.user_id) {
      if (!(await db.get('users', body.user_id))) throw badRequest('Linked user not found')
      if (await db.col('employees').findOne({ user_id: body.user_id, _id: { $ne: existing.id } })) throw badRequest('That user already has an employee record')
    }
    await db.col('employees').updateOne({ _id: existing.id }, { $set: body })
    res.json(await getEmployee(existing.id))
  })

  return r
}
