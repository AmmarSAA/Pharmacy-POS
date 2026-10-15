import { Router } from '../lib/router.js'
import { badRequest, notFound, reqString, reqInt } from '../lib/http.js'

// Simple internal staff messaging. Anyone signed in may send and read their own messages — there
// is no broadcast/channel concept, just direct messages, closer to Odoo's Discuss DMs than its
// channels.

async function loadOne(db, id) {
  const m = await db.get('messages', id)
  if (!m) return null
  return (await db.join([m], [
    { key: 'from_user_id', from: 'users', fields: { from_name: 'full_name' } },
    { key: 'to_user_id', from: 'users', fields: { to_name: 'full_name' } },
  ]))[0]
}

export default function messageRoutes(db) {
  const r = Router()

  // Everyone the signed-in user has exchanged a message with (for picking who to message / a contact list).
  r.get('/contacts', async (req, res) => {
    res.json((await db.col('users').find({ _id: { $ne: req.user.id }, active: 1 }, {
      projection: { id: 1, full_name: 1, role: 1 }, sort: { full_name: 1 },
    }).toArray()))
  })

  // Inbox: everyone who has messaged the signed-in user or been messaged by them, most recent message each.
  r.get('/threads', async (req, res) => {
    const rows = await db.col('messages').aggregate([
      { $match: { $or: [{ from_user_id: req.user.id }, { to_user_id: req.user.id }] } },
      { $addFields: { other: { $cond: [{ $eq: ['$from_user_id', req.user.id] }, '$to_user_id', '$from_user_id'] } } },
      { $sort: { created_at: -1, id: -1 } },
      { $group: { _id: '$other', last_body: { $first: '$body' }, last_at: { $first: '$created_at' },
        unread: { $sum: { $cond: [{ $and: [{ $eq: ['$to_user_id', req.user.id] }, { $eq: ['$read', 0] }] }, 1, 0] } } } },
      { $sort: { last_at: -1 } },
    ]).toArray()
    const users = new Map((await db.col('users').find({ _id: { $in: rows.map((r) => r._id) } }, { projection: { id: 1, full_name: 1 } }).toArray()).map((u) => [u.id, u.full_name]))
    res.json(rows.map((r) => ({ user_id: r._id, user_name: users.get(r._id) || '(removed user)', last_body: r.last_body, last_at: r.last_at, unread: r.unread })))
  })

  // Every message exchanged with one other user, oldest first. Marks their messages to us as read.
  r.get('/with/:userId', async (req, res) => {
    const otherId = Number(req.params.userId)
    const rows = await db.all('messages', {
      $or: [{ from_user_id: req.user.id, to_user_id: otherId }, { from_user_id: otherId, to_user_id: req.user.id }],
    }, { sort: { created_at: 1 } })
    await db.col('messages').updateMany({ from_user_id: otherId, to_user_id: req.user.id, read: 0 }, { $set: { read: 1 } })
    res.json(rows)
  })

  r.post('/', async (req, res) => {
    const toUserId = reqInt(req.body, 'to_user_id', { min: 1, label: 'Recipient' })
    if (toUserId === req.user.id) throw badRequest("You can't message yourself")
    const to = await db.get('users', toUserId)
    if (!to || !to.active) throw notFound('Recipient')
    const body = reqString(req.body, 'body', 'Message')
    const id = await db.insert('messages', { from_user_id: req.user.id, to_user_id: toUserId, body, read: 0 })
    res.status(201).json(await loadOne(db, id))
  })

  r.get('/unread-count', async (req, res) => {
    res.json({ count: await db.col('messages').countDocuments({ to_user_id: req.user.id, read: 0 }) })
  })

  return r
}
