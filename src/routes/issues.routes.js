import { Router } from '../lib/router.js'
import { requireRole } from '../auth.js'
import { today, nowStamp } from '../db.js'
import { HttpError, badRequest, notFound, reqInt, optInt, reqString, optString } from '../lib/http.js'
import { allocateFefo, moveStock } from '../lib/stock.js'

const staff = requireRole('admin', 'pharmacist')
const flag = (v, def) => (v === undefined || v === null || v === '' ? def : v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0)

// Units for a line: qty if given, else packs * pack_size + loose (loose needs allow_loose).
function lineUnits(it, p, label) {
  const packSize = p.pack_size || 1
  let qty
  if (it.qty !== undefined && it.qty !== null && it.qty !== '') {
    qty = reqInt(it, 'qty', { min: 1, max: 100000, label: `${label}: quantity` })
  } else {
    const packs = optInt(it, 'packs', 0, { min: 0, max: 100000, label: `${label}: packs` })
    const loose = optInt(it, 'loose', 0, { min: 0, max: 100000, label: `${label}: loose units` })
    qty = packs * packSize + loose
    if (qty < 1) throw badRequest(`${label}: quantity must be at least 1`)
    if (qty > 100000) throw badRequest(`${label}: quantity must be between 1 and 100000`)
  }
  if (!p.allow_loose && qty % packSize !== 0) throw badRequest(`${p.name} is issued in full packs of ${packSize} only`)
  return qty
}

// Read items into merged { product, qty, requestItemId } lines, one per product.
async function readLines(db, items) {
  if (!Array.isArray(items) || items.length === 0) throw badRequest('Add at least one item')
  const lines = new Map()
  for (const [i, it] of items.entries()) {
    const label = `Item ${i + 1}`
    const productId = reqInt(it, 'product_id', { min: 1, label: `${label}: product` })
    const product = await db.get('products', productId)
    if (!product || !product.active) throw badRequest(`Product ${productId} is not available`)
    const qty = lineUnits(it, product, label)
    const prev = lines.get(productId)
    const rid = it.request_item_id === undefined || it.request_item_id === null || it.request_item_id === ''
      ? null : reqInt(it, 'request_item_id', { min: 1, label: `${label}: request item` })
    lines.set(productId, { product, qty: (prev?.qty || 0) + qty, requestItemId: prev?.requestItemId ?? rid })
  }
  return [...lines.values()]
}

async function stockByProduct(db, productIds) {
  const rows = await db.col('batches').aggregate([
    { $match: { product_id: { $in: productIds }, expiry_date: { $gte: today() } } },
    { $group: { _id: '$product_id', q: { $sum: '$qty_on_hand' } } },
  ]).toArray()
  return new Map(rows.map((r) => [r._id, r.q]))
}

async function loadRequest(db, id) {
  const req = await db.get('issue_requests', id)
  if (!req) return null
  await db.join([req], [
    { key: 'department_id', from: 'departments', fields: { department_name: 'name' } },
    { key: 'user_id', from: 'users', fields: { user_name: 'full_name' } },
  ])
  req.items = await db.all('issue_request_items', { request_id: req.id }, { sort: { id: 1 } })
  await db.join(req.items, [{ key: 'product_id', from: 'products', fields: {
    product_name: 'name', strength: 'strength', form: 'form', pack_size: 'pack_size',
  } }])
  const stock = await stockByProduct(db, req.items.map((i) => i.product_id))
  for (const it of req.items) it.stock = stock.get(it.product_id) || 0
  return req
}

async function returnedCostByIssue(db, issueIds) {
  const rows = await db.col('issue_returns').aggregate([
    { $match: { issue_id: { $in: issueIds } } }, { $group: { _id: '$issue_id', v: { $sum: '$total_cost' } } },
  ]).toArray()
  return new Map(rows.map((r) => [r._id, r.v]))
}

async function loadIssue(db, id) {
  const issue = await db.get('issues', id)
  if (!issue) return null
  await db.join([issue], [
    { key: 'department_id', from: 'departments', fields: { department_name: 'name' } },
    { key: 'user_id', from: 'users', fields: { user_name: 'full_name' } },
  ])
  issue.returned_cost = (await returnedCostByIssue(db, [issue.id])).get(issue.id) || 0
  issue.items = await db.all('issue_items', { issue_id: issue.id }, { sort: { id: 1 } })
  await db.join(issue.items, [
    { key: 'product_id', from: 'products', fields: { product_name: 'name', strength: 'strength', form: 'form', schedule: 'schedule' } },
    { key: 'batch_id', from: 'batches', fields: { batch_no: 'batch_no', expiry_date: 'expiry_date' } },
  ])
  issue.returns = await db.all('issue_returns', { issue_id: issue.id }, { sort: { id: 1 } })
  await db.join(issue.returns, [{ key: 'user_id', from: 'users', fields: { user_name: 'full_name' } }])
  const names = new Map(issue.items.map((ii) => [ii.id, ii.product_name]))
  for (const r of issue.returns) {
    r.items = (await db.all('issue_return_items', { issue_return_id: r.id }, { sort: { id: 1 } }))
      .map((ri) => ({ ...ri, product_name: names.get(ri.issue_item_id) ?? null }))
  }
  return issue
}

async function activeDepartment(db, id) {
  const dept = await db.get('departments', id)
  if (!dept) throw badRequest('Department not found')
  if (!dept.active) throw badRequest(`${dept.name} is not active`)
  return dept
}

const NO_LC = { projection: { name_lc: 0 } }

export function departmentRoutes(db) {
  const r = Router()
  const departments = db.col('departments')

  r.get('/', async (req, res) => {
    res.json(await departments.find(req.query.all === '1' ? {} : { active: 1 }, { ...NO_LC, sort: { name: 1 } }).toArray())
  })

  const dupCheck = async (name, exceptId = 0) => {
    if (await departments.findOne({ name_lc: name.toLowerCase(), _id: { $ne: exceptId } })) {
      throw new HttpError(409, `Department "${name}" already exists`)
    }
  }

  r.post('/', staff, async (req, res) => {
    const name = reqString(req.body, 'name', 'Name')
    await dupCheck(name)
    const id = await db.insert('departments', {
      name, name_lc: name.toLowerCase(), incharge: optString(req.body, 'incharge'), active: flag(req.body.active, 1),
    })
    res.status(201).json(await departments.findOne({ _id: id }, NO_LC))
  })

  r.put('/:id', staff, async (req, res) => {
    const id = Number(req.params.id)
    const cur = await db.get('departments', id)
    if (!cur) throw notFound('Department')
    const name = req.body.name === undefined ? cur.name : reqString(req.body, 'name', 'Name')
    await dupCheck(name, id)
    const incharge = req.body.incharge === undefined ? cur.incharge : optString(req.body, 'incharge')
    await departments.updateOne({ _id: id }, { $set: { name, name_lc: name.toLowerCase(), incharge, active: flag(req.body.active, cur.active) } })
    res.json(await departments.findOne({ _id: id }, NO_LC))
  })

  return r
}

export function issueRequestRoutes(db) {
  const r = Router()
  r.use(staff)

  r.get('/', async (req, res) => {
    const filter = {}
    if (req.query.status) filter.status = String(req.query.status)
    if (req.query.department_id) filter.department_id = Number(req.query.department_id)
    const rows = await db.all('issue_requests', filter, { sort: { id: -1 } })
    await db.join(rows, [{ key: 'department_id', from: 'departments', fields: { department_name: 'name' } }])
    const counts = await db.col('issue_request_items').aggregate([
      { $match: { request_id: { $in: rows.map((x) => x.id) } } }, { $group: { _id: '$request_id', n: { $sum: 1 } } },
    ]).toArray()
    const byId = new Map(counts.map((c) => [c._id, c.n]))
    for (const row of rows) row.item_count = byId.get(row.id) || 0
    res.json(rows)
  })

  r.get('/:id', async (req, res) => {
    const found = await loadRequest(db, Number(req.params.id))
    if (!found) throw notFound('Request')
    res.json(found)
  })

  r.post('/', async (req, res) => {
    const dept = await activeDepartment(db, reqInt(req.body, 'department_id', { min: 1, label: 'Department' }))
    const lines = await readLines(db, req.body.items)
    const id = await db.tx(async () => {
      const rid = await db.insert('issue_requests', {
        department_id: dept.id, requested_by: optString(req.body, 'requested_by'), ref_no: optString(req.body, 'ref_no'),
        status: 'open', note: optString(req.body, 'note'), user_id: req.user.id,
      })
      for (const l of lines) {
        await db.insert('issue_request_items', { request_id: rid, product_id: l.product.id, qty_requested: l.qty, qty_issued: 0 })
      }
      return rid
    })
    res.status(201).json(await loadRequest(db, id))
  })

  r.post('/:id/cancel', async (req, res) => {
    const id = Number(req.params.id)
    const cur = await db.get('issue_requests', id)
    if (!cur) throw notFound('Request')
    if (cur.status === 'closed' || cur.status === 'cancelled') throw new HttpError(409, `Request is already ${cur.status}`)
    await db.col('issue_requests').updateOne({ _id: id }, { $set: { status: 'cancelled' } })
    res.json(await loadRequest(db, id))
  })

  return r
}

export default function issueRoutes(db) {
  const r = Router()
  r.use(staff)

  r.get('/', async (req, res) => {
    const from = req.query.from || today()
    const to = req.query.to || from
    const filter = { created_at: { $gte: from, $lt: `${to}~` } }
    if (req.query.department_id) filter.department_id = Number(req.query.department_id)
    const rows = await db.all('issues', filter, { sort: { id: -1 } })
    await db.join(rows, [{ key: 'department_id', from: 'departments', fields: { department_name: 'name' } }])
    const ids = rows.map((x) => x.id)
    const counts = await db.col('issue_items').aggregate([
      { $match: { issue_id: { $in: ids } } }, { $group: { _id: '$issue_id', n: { $sum: 1 } } },
    ]).toArray()
    const byId = new Map(counts.map((c) => [c._id, c.n]))
    const returned = await returnedCostByIssue(db, ids)
    for (const row of rows) {
      row.item_count = byId.get(row.id) || 0
      row.returned_cost = returned.get(row.id) || 0
    }
    res.json(rows)
  })

  r.get('/:id', async (req, res) => {
    const found = await loadIssue(db, Number(req.params.id))
    if (!found) throw notFound('Issue')
    res.json(found)
  })

  r.post('/', async (req, res) => {
    const dept = await activeDepartment(db, reqInt(req.body, 'department_id', { min: 1, label: 'Department' }))
    const lines = await readLines(db, req.body.items)
    const receivedBy = optString(req.body, 'received_by')
    if (!receivedBy && lines.some((l) => l.product.schedule === 'controlled')) {
      throw badRequest('Received by is required when issuing controlled drugs')
    }

    let request = null
    if (req.body.request_id !== undefined && req.body.request_id !== null && req.body.request_id !== '') {
      const rid = reqInt(req.body, 'request_id', { min: 1, label: 'Request' })
      request = await db.get('issue_requests', rid)
      if (!request) throw badRequest('Request not found')
      if (request.department_id !== dept.id) throw badRequest('Request belongs to a different department')
      if (request.status === 'cancelled' || request.status === 'closed') {
        throw new HttpError(409, `Request is ${request.status}`)
      }
    }
    // Resolve each line's request item; an explicit one must belong to the request.
    for (const l of lines) {
      if (l.requestItemId !== null) {
        const qi = request && (await db.col('issue_request_items').findOne({ _id: l.requestItemId, request_id: request.id }))
        if (!qi) throw badRequest(`Request item ${l.requestItemId} does not belong to this request`)
      } else if (request) {
        l.requestItemId = (await db.col('issue_request_items').findOne({ request_id: request.id, product_id: l.product.id }))?.id ?? null
      }
    }

    const id = await db.tx(async () => {
      const picked = []
      for (const l of lines) {
        const { picks, available, short } = await allocateFefo(db, l.product.id, l.qty, today())
        if (short > 0) throw new HttpError(409, `Not enough stock for ${l.product.name}: ${available} available`)
        for (const { batch, qty } of picks) picked.push({ l, batch, qty })
      }
      const total = picked.reduce((s, p) => s + p.batch.cost_price * p.qty, 0)
      const issueId = await db.nextId('issues')
      const stamp = nowStamp()
      await db.col('issues').insertOne({
        _id: issueId, id: issueId, issue_no: `ISS-${String(issueId).padStart(6, '0')}`, department_id: dept.id,
        request_id: request?.id ?? null, received_by: receivedBy, patient_name: optString(req.body, 'patient_name'),
        note: optString(req.body, 'note'), total_cost: total, user_id: req.user.id, created_at: stamp,
      })
      for (const { l, batch, qty } of picked) {
        await db.insert('issue_items', {
          issue_id: issueId, product_id: l.product.id, batch_id: batch.id, request_item_id: l.requestItemId, qty,
          unit_cost: batch.cost_price, line_cost: batch.cost_price * qty, pack_size: l.product.pack_size || 1, returned_qty: 0,
          department_id: dept.id, created_at: stamp,
        })
        await moveStock(db, { batchId: batch.id, change: -qty, reason: 'issue', refId: issueId, userId: req.user.id, note: dept.name })
      }
      if (request) {
        for (const l of lines) {
          if (l.requestItemId !== null) {
            await db.col('issue_request_items').updateOne({ _id: l.requestItemId }, { $inc: { qty_issued: l.qty } })
          }
        }
        const items = await db.all('issue_request_items', { request_id: request.id })
        const status = items.every((q) => q.qty_issued >= q.qty_requested) ? 'closed' : items.some((q) => q.qty_issued > 0) ? 'partial' : 'open'
        await db.col('issue_requests').updateOne({ _id: request.id }, { $set: { status } })
      }
      return issueId
    })
    res.status(201).json(await loadIssue(db, id))
  })

  // Body: { items: [{ issue_item_id, qty, restock? }], reason }
  r.post('/:id/returns', async (req, res) => {
    const issueId = Number(req.params.id)
    const issue = await db.get('issues', issueId)
    if (!issue) throw notFound('Issue')
    const items = req.body.items
    if (!Array.isArray(items) || items.length === 0) throw badRequest('Choose at least one item to return')
    const reason = optString(req.body, 'reason')
    const dept = await db.get('departments', issue.department_id)

    await db.tx(async () => {
      const taken = new Map() // issue_item_id -> qty already claimed in this request
      const lines = []
      for (const [i, it] of items.entries()) {
        const ii = await db.col('issue_items').findOne({ _id: Number(it.issue_item_id), issue_id: issueId })
        if (!ii) throw badRequest(`Item ${i + 1} is not on this issue`)
        const already = taken.get(ii.id) || 0
        const qty = reqInt(it, 'qty', { min: 1, max: ii.qty - ii.returned_qty - already, label: `Item ${i + 1}: return quantity` })
        taken.set(ii.id, already + qty)
        const batch = await db.get('batches', ii.batch_id)
        lines.push({ ii, qty, restock: it.restock !== false && batch.expiry_date >= today() })
      }
      const total = lines.reduce((s, l) => s + l.ii.unit_cost * l.qty, 0)
      const returnId = await db.insert('issue_returns', {
        issue_id: issueId, reason, total_cost: total, user_id: req.user.id, department_id: issue.department_id,
      })
      for (const l of lines) {
        await db.insert('issue_return_items', { issue_return_id: returnId, issue_item_id: l.ii.id, qty: l.qty, restocked: l.restock ? 1 : 0 })
        const upd = await db.col('issue_items').updateOne(
          { _id: l.ii.id, returned_qty: { $lte: l.ii.qty - l.qty } }, { $inc: { returned_qty: l.qty } },
        )
        if (!upd.modifiedCount) throw new HttpError(409, 'This item was returned already')
        if (l.restock) {
          await moveStock(db, { batchId: l.ii.batch_id, change: l.qty, reason: 'issue_return', refId: returnId, userId: req.user.id, note: dept.name })
        }
      }
    })
    res.status(201).json(await loadIssue(db, issueId))
  })

  return r
}
