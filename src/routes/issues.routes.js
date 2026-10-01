import { Router } from 'express'
import { requireRole } from '../auth.js'
import { transaction, today } from '../db.js'
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
function readLines(db, items) {
  if (!Array.isArray(items) || items.length === 0) throw badRequest('Add at least one item')
  const lines = new Map()
  for (const [i, it] of items.entries()) {
    const label = `Item ${i + 1}`
    const productId = reqInt(it, 'product_id', { min: 1, label: `${label}: product` })
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId)
    if (!product || !product.active) throw badRequest(`Product ${productId} is not available`)
    const qty = lineUnits(it, product, label)
    const prev = lines.get(productId)
    const rid = it.request_item_id === undefined || it.request_item_id === null || it.request_item_id === ''
      ? null : reqInt(it, 'request_item_id', { min: 1, label: `${label}: request item` })
    lines.set(productId, { product, qty: (prev?.qty || 0) + qty, requestItemId: prev?.requestItemId ?? rid })
  }
  return [...lines.values()]
}

function loadRequest(db, id) {
  const req = db
    .prepare(
      `SELECT q.*, d.name AS department_name, u.full_name AS user_name
       FROM issue_requests q JOIN departments d ON d.id = q.department_id JOIN users u ON u.id = q.user_id WHERE q.id = ?`,
    )
    .get(id)
  if (!req) return null
  req.items = db
    .prepare(
      `SELECT qi.*, p.name AS product_name, p.strength, p.form, p.pack_size,
         COALESCE((SELECT SUM(b.qty_on_hand) FROM batches b WHERE b.product_id = qi.product_id AND b.expiry_date >= :today), 0) AS stock
       FROM issue_request_items qi JOIN products p ON p.id = qi.product_id WHERE qi.request_id = :id ORDER BY qi.id`,
    )
    .all({ today: today(), id })
  return req
}

function loadIssue(db, id) {
  const issue = db
    .prepare(
      `SELECT i.*, d.name AS department_name, u.full_name AS user_name,
         COALESCE((SELECT SUM(r.total_cost) FROM issue_returns r WHERE r.issue_id = i.id), 0) AS returned_cost
       FROM issues i JOIN departments d ON d.id = i.department_id JOIN users u ON u.id = i.user_id WHERE i.id = ?`,
    )
    .get(id)
  if (!issue) return null
  issue.items = db
    .prepare(
      `SELECT ii.*, p.name AS product_name, p.strength, p.form, p.schedule, b.batch_no, b.expiry_date
       FROM issue_items ii JOIN products p ON p.id = ii.product_id JOIN batches b ON b.id = ii.batch_id
       WHERE ii.issue_id = ? ORDER BY ii.id`,
    )
    .all(id)
  issue.returns = db
    .prepare('SELECT r.*, u.full_name AS user_name FROM issue_returns r JOIN users u ON u.id = r.user_id WHERE r.issue_id = ? ORDER BY r.id')
    .all(id)
  for (const r of issue.returns) {
    r.items = db
      .prepare(
        `SELECT ri.*, p.name AS product_name FROM issue_return_items ri
         JOIN issue_items ii ON ii.id = ri.issue_item_id JOIN products p ON p.id = ii.product_id
         WHERE ri.issue_return_id = ? ORDER BY ri.id`,
      )
      .all(r.id)
  }
  return issue
}

function activeDepartment(db, id) {
  const dept = db.prepare('SELECT * FROM departments WHERE id = ?').get(id)
  if (!dept) throw badRequest('Department not found')
  if (!dept.active) throw badRequest(`${dept.name} is not active`)
  return dept
}

export function departmentRoutes(db) {
  const r = Router()

  r.get('/', (req, res) => {
    const where = req.query.all === '1' ? '' : 'WHERE active = 1'
    res.json(db.prepare(`SELECT * FROM departments ${where} ORDER BY name`).all())
  })

  const dupCheck = (name, exceptId = 0) => {
    if (db.prepare('SELECT 1 FROM departments WHERE name = ? AND id != ?').get(name, exceptId)) {
      throw new HttpError(409, `Department "${name}" already exists`)
    }
  }

  r.post('/', staff, (req, res) => {
    const name = reqString(req.body, 'name', 'Name')
    dupCheck(name)
    const id = Number(
      db.prepare('INSERT INTO departments (name, incharge, active) VALUES (?, ?, ?)')
        .run(name, optString(req.body, 'incharge'), flag(req.body.active, 1)).lastInsertRowid,
    )
    res.status(201).json(db.prepare('SELECT * FROM departments WHERE id = ?').get(id))
  })

  r.put('/:id', staff, (req, res) => {
    const id = Number(req.params.id)
    const cur = db.prepare('SELECT * FROM departments WHERE id = ?').get(id)
    if (!cur) throw notFound('Department')
    const name = req.body.name === undefined ? cur.name : reqString(req.body, 'name', 'Name')
    dupCheck(name, id)
    const incharge = req.body.incharge === undefined ? cur.incharge : optString(req.body, 'incharge')
    db.prepare('UPDATE departments SET name = ?, incharge = ?, active = ? WHERE id = ?')
      .run(name, incharge, flag(req.body.active, cur.active), id)
    res.json(db.prepare('SELECT * FROM departments WHERE id = ?').get(id))
  })

  return r
}

export function issueRequestRoutes(db) {
  const r = Router()
  r.use(staff)

  r.get('/', (req, res) => {
    const where = []
    const params = {}
    if (req.query.status) { where.push('q.status = :status'); params.status = String(req.query.status) }
    if (req.query.department_id) { where.push('q.department_id = :dept'); params.dept = Number(req.query.department_id) }
    res.json(
      db.prepare(
        `SELECT q.*, d.name AS department_name,
           (SELECT COUNT(*) FROM issue_request_items WHERE request_id = q.id) AS item_count
         FROM issue_requests q JOIN departments d ON d.id = q.department_id
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY q.id DESC`,
      ).all(params),
    )
  })

  r.get('/:id', (req, res) => {
    const found = loadRequest(db, Number(req.params.id))
    if (!found) throw notFound('Request')
    res.json(found)
  })

  r.post('/', (req, res) => {
    const dept = activeDepartment(db, reqInt(req.body, 'department_id', { min: 1, label: 'Department' }))
    const lines = readLines(db, req.body.items)
    const id = transaction(db, () => {
      const rid = Number(
        db.prepare('INSERT INTO issue_requests (department_id, requested_by, ref_no, note, user_id) VALUES (?, ?, ?, ?, ?)')
          .run(dept.id, optString(req.body, 'requested_by'), optString(req.body, 'ref_no'), optString(req.body, 'note'), req.user.id)
          .lastInsertRowid,
      )
      for (const l of lines) {
        db.prepare('INSERT INTO issue_request_items (request_id, product_id, qty_requested) VALUES (?, ?, ?)')
          .run(rid, l.product.id, l.qty)
      }
      return rid
    })
    res.status(201).json(loadRequest(db, id))
  })

  r.post('/:id/cancel', (req, res) => {
    const id = Number(req.params.id)
    const cur = db.prepare('SELECT status FROM issue_requests WHERE id = ?').get(id)
    if (!cur) throw notFound('Request')
    if (cur.status === 'closed' || cur.status === 'cancelled') throw new HttpError(409, `Request is already ${cur.status}`)
    db.prepare("UPDATE issue_requests SET status = 'cancelled' WHERE id = ?").run(id)
    res.json(loadRequest(db, id))
  })

  return r
}

export default function issueRoutes(db) {
  const r = Router()
  r.use(staff)

  r.get('/', (req, res) => {
    const from = req.query.from || today()
    const to = req.query.to || from
    const params = { from, to }
    let extra = ''
    if (req.query.department_id) { extra = 'AND i.department_id = :dept'; params.dept = Number(req.query.department_id) }
    res.json(
      db.prepare(
        `SELECT i.*, d.name AS department_name,
           (SELECT COUNT(*) FROM issue_items WHERE issue_id = i.id) AS item_count,
           COALESCE((SELECT SUM(total_cost) FROM issue_returns WHERE issue_id = i.id), 0) AS returned_cost
         FROM issues i JOIN departments d ON d.id = i.department_id
         WHERE date(i.created_at) BETWEEN :from AND :to ${extra} ORDER BY i.id DESC`,
      ).all(params),
    )
  })

  r.get('/:id', (req, res) => {
    const found = loadIssue(db, Number(req.params.id))
    if (!found) throw notFound('Issue')
    res.json(found)
  })

  r.post('/', (req, res) => {
    const dept = activeDepartment(db, reqInt(req.body, 'department_id', { min: 1, label: 'Department' }))
    const lines = readLines(db, req.body.items)
    const receivedBy = optString(req.body, 'received_by')
    if (!receivedBy && lines.some((l) => l.product.schedule === 'controlled')) {
      throw badRequest('Received by is required when issuing controlled drugs')
    }

    let request = null
    if (req.body.request_id !== undefined && req.body.request_id !== null && req.body.request_id !== '') {
      const rid = reqInt(req.body, 'request_id', { min: 1, label: 'Request' })
      request = db.prepare('SELECT * FROM issue_requests WHERE id = ?').get(rid)
      if (!request) throw badRequest('Request not found')
      if (request.department_id !== dept.id) throw badRequest('Request belongs to a different department')
      if (request.status === 'cancelled' || request.status === 'closed') {
        throw new HttpError(409, `Request is ${request.status}`)
      }
    }
    // Resolve each line's request item; an explicit one must belong to the request.
    for (const l of lines) {
      if (l.requestItemId !== null) {
        const qi = request && db.prepare('SELECT * FROM issue_request_items WHERE id = ? AND request_id = ?').get(l.requestItemId, request.id)
        if (!qi) throw badRequest(`Request item ${l.requestItemId} does not belong to this request`)
      } else if (request) {
        l.requestItemId = db.prepare('SELECT id FROM issue_request_items WHERE request_id = ? AND product_id = ?').get(request.id, l.product.id)?.id ?? null
      }
    }

    const id = transaction(db, () => {
      const picked = []
      for (const l of lines) {
        const { picks, available, short } = allocateFefo(db, l.product.id, l.qty, today())
        if (short > 0) throw new HttpError(409, `Not enough stock for ${l.product.name}: ${available} available`)
        for (const { batch, qty } of picks) picked.push({ l, batch, qty })
      }
      const total = picked.reduce((s, p) => s + p.batch.cost_price * p.qty, 0)
      const issueId = Number(
        db.prepare(
          `INSERT INTO issues (issue_no, department_id, request_id, received_by, patient_name, note, total_cost, user_id)
           VALUES (:no, :dept, :request, :recv, :patient, :note, :total, :user)`,
        ).run({
          no: `TMP-${Date.now()}-${Math.random()}`, dept: dept.id, request: request?.id ?? null, recv: receivedBy,
          patient: optString(req.body, 'patient_name'), note: optString(req.body, 'note'), total, user: req.user.id,
        }).lastInsertRowid,
      )
      db.prepare('UPDATE issues SET issue_no = ? WHERE id = ?').run(`ISS-${String(issueId).padStart(6, '0')}`, issueId)
      for (const { l, batch, qty } of picked) {
        db.prepare(
          `INSERT INTO issue_items (issue_id, product_id, batch_id, request_item_id, qty, unit_cost, line_cost, pack_size)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(issueId, l.product.id, batch.id, l.requestItemId, qty, batch.cost_price, batch.cost_price * qty, l.product.pack_size || 1)
        moveStock(db, { batchId: batch.id, change: -qty, reason: 'issue', refId: issueId, userId: req.user.id, note: dept.name })
      }
      if (request) {
        for (const l of lines) {
          if (l.requestItemId !== null) {
            db.prepare('UPDATE issue_request_items SET qty_issued = qty_issued + ? WHERE id = ?').run(l.qty, l.requestItemId)
          }
        }
        const items = db.prepare('SELECT qty_requested, qty_issued FROM issue_request_items WHERE request_id = ?').all(request.id)
        const status = items.every((q) => q.qty_issued >= q.qty_requested) ? 'closed' : items.some((q) => q.qty_issued > 0) ? 'partial' : 'open'
        db.prepare('UPDATE issue_requests SET status = ? WHERE id = ?').run(status, request.id)
      }
      return issueId
    })
    res.status(201).json(loadIssue(db, id))
  })

  // Body: { items: [{ issue_item_id, qty, restock? }], reason }
  r.post('/:id/returns', (req, res) => {
    const issueId = Number(req.params.id)
    const issue = db.prepare('SELECT * FROM issues WHERE id = ?').get(issueId)
    if (!issue) throw notFound('Issue')
    const items = req.body.items
    if (!Array.isArray(items) || items.length === 0) throw badRequest('Choose at least one item to return')
    const reason = optString(req.body, 'reason')
    const dept = db.prepare('SELECT name FROM departments WHERE id = ?').get(issue.department_id)

    transaction(db, () => {
      const taken = new Map() // issue_item_id -> qty already claimed in this request
      const lines = items.map((it, i) => {
        const ii = db.prepare('SELECT * FROM issue_items WHERE id = ? AND issue_id = ?').get(Number(it.issue_item_id), issueId)
        if (!ii) throw badRequest(`Item ${i + 1} is not on this issue`)
        const already = taken.get(ii.id) || 0
        const qty = reqInt(it, 'qty', { min: 1, max: ii.qty - ii.returned_qty - already, label: `Item ${i + 1}: return quantity` })
        taken.set(ii.id, already + qty)
        const batch = db.prepare('SELECT expiry_date FROM batches WHERE id = ?').get(ii.batch_id)
        return { ii, qty, restock: it.restock !== false && batch.expiry_date >= today() }
      })
      const total = lines.reduce((s, l) => s + l.ii.unit_cost * l.qty, 0)
      const returnId = Number(
        db.prepare('INSERT INTO issue_returns (issue_id, reason, total_cost, user_id) VALUES (?, ?, ?, ?)')
          .run(issueId, reason, total, req.user.id).lastInsertRowid,
      )
      for (const l of lines) {
        db.prepare('INSERT INTO issue_return_items (issue_return_id, issue_item_id, qty, restocked) VALUES (?, ?, ?, ?)')
          .run(returnId, l.ii.id, l.qty, l.restock ? 1 : 0)
        db.prepare('UPDATE issue_items SET returned_qty = returned_qty + ? WHERE id = ?').run(l.qty, l.ii.id)
        if (l.restock) {
          moveStock(db, { batchId: l.ii.batch_id, change: l.qty, reason: 'issue_return', refId: returnId, userId: req.user.id, note: dept.name })
        }
      }
    })
    res.status(201).json(loadIssue(db, issueId))
  })

  return r
}
