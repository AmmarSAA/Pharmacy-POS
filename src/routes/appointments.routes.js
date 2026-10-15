import { Router } from '../lib/router.js'
import { HttpError, badRequest, notFound, reqString, optString, reqInt, optInt } from '../lib/http.js'

const STAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/
const reqStamp = (b, f, label) => {
  const v = reqString(b, f, label)
  if (!STAMP.test(v)) throw badRequest(`${label} must be YYYY-MM-DD HH:MM:SS`)
  return v
}
const KINDS = ['consultation', 'shift', 'other']

// Anyone signed in can see and manage their own appointments; calendar.manage_all additionally
// lets staff see and manage everyone's (e.g. to build the week's shift roster).
const canManageAll = (req) => (req.user.permissions || []).includes('calendar.manage_all')
const owns = (req, a) => a.with_user_id === req.user.id || a.created_by === req.user.id

async function loadOne(db, id) {
  const a = await db.get('appointments', id)
  if (!a) return null
  return (await db.join([a], [
    { key: 'with_user_id', from: 'users', fields: { with_name: 'full_name' } },
    { key: 'customer_id', from: 'customers', fields: { customer_name: 'name' } },
  ]))[0]
}

export default function appointmentRoutes(db) {
  const r = Router()

  // ?from=&to= (YYYY-MM-DD HH:MM:SS, both ends inclusive) ?user_id= (calendar.manage_all only)
  r.get('/', async (req, res) => {
    const filter = { status: { $ne: 'cancelled' } }
    if (req.query.from || req.query.to) {
      filter.starts_at = {}
      if (req.query.from) filter.starts_at.$gte = req.query.from
      if (req.query.to) filter.starts_at.$lte = req.query.to
    }
    if (canManageAll(req)) {
      if (req.query.user_id) filter.with_user_id = Number(req.query.user_id)
    } else {
      filter.with_user_id = req.user.id
    }
    const rows = await db.all('appointments', filter, { sort: { starts_at: 1 } })
    res.json(await db.join(rows, [
      { key: 'with_user_id', from: 'users', fields: { with_name: 'full_name' } },
      { key: 'customer_id', from: 'customers', fields: { customer_name: 'name' } },
    ]))
  })

  // Body: { title, kind, starts_at, ends_at, with_user_id?, customer_id?, notes? }
  r.post('/', async (req, res) => {
    const withUserId = optInt(req.body, 'with_user_id', req.user.id, { min: 1, label: 'Staff' })
    if (withUserId !== req.user.id && !canManageAll(req)) throw new HttpError(403, "You can only book your own appointments")
    if (!(await db.get('users', withUserId))) throw badRequest('Staff member not found')
    const startsAt = reqStamp(req.body, 'starts_at', 'Start time')
    const endsAt = reqStamp(req.body, 'ends_at', 'End time')
    if (endsAt <= startsAt) throw badRequest('End time must be after the start time')
    const customerId = optInt(req.body, 'customer_id', null, { min: 1, label: 'Customer' })
    if (customerId && !(await db.get('customers', customerId))) throw badRequest('Customer not found')
    const id = await db.insert('appointments', {
      title: reqString(req.body, 'title', 'Title'), kind: KINDS.includes(req.body.kind) ? req.body.kind : 'other',
      starts_at: startsAt, ends_at: endsAt, with_user_id: withUserId, customer_id: customerId,
      notes: optString(req.body, 'notes'), status: 'scheduled', created_by: req.user.id,
    })
    res.status(201).json(await loadOne(db, id))
  })

  r.put('/:id', async (req, res) => {
    const id = Number(req.params.id)
    const a = await db.get('appointments', id)
    if (!a) throw notFound('Appointment')
    if (!canManageAll(req) && !owns(req, a)) throw new HttpError(403, 'You can only change your own appointments')
    const startsAt = req.body.starts_at !== undefined ? reqStamp(req.body, 'starts_at', 'Start time') : a.starts_at
    const endsAt = req.body.ends_at !== undefined ? reqStamp(req.body, 'ends_at', 'End time') : a.ends_at
    if (endsAt <= startsAt) throw badRequest('End time must be after the start time')
    await db.col('appointments').updateOne({ _id: id }, { $set: {
      title: req.body.title !== undefined ? reqString(req.body, 'title', 'Title') : a.title,
      starts_at: startsAt, ends_at: endsAt, notes: req.body.notes !== undefined ? optString(req.body, 'notes') : a.notes,
    } })
    res.json(await loadOne(db, id))
  })

  r.post('/:id/cancel', async (req, res) => {
    const id = Number(req.params.id)
    const a = await db.get('appointments', id)
    if (!a) throw notFound('Appointment')
    if (!canManageAll(req) && !owns(req, a)) throw new HttpError(403, 'You can only cancel your own appointments')
    await db.col('appointments').updateOne({ _id: id }, { $set: { status: 'cancelled' } })
    res.json(await loadOne(db, id))
  })

  return r
}
