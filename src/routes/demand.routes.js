import { Router } from '../lib/router.js'
import { requireRole } from '../auth.js'
import { today, nowStamp } from '../db.js'
import { HttpError, badRequest, notFound, reqInt, optInt, optString, oneOf } from '../lib/http.js'
import { addDays } from '../lib/supplier-ledger.js'

// Demand lists: what to order from a supplier. Suggestions come from real use (sales and ward
// issues), not only reorder levels, so items nobody buys any more are not ordered again. Items can
// be marked "not needed" (never suggested) or skipped for a while; both also leave low-stock alerts.

const STATUSES = ['draft', 'sent', 'received', 'cancelled']
const OPEN = ['draft', 'sent']
const USE_REASONS = ['sale', 'issue', 'return', 'issue_return']

// Products that may be suggested / count as low stock today.
export const reorderable = (t) => ({
  no_reorder: { $ne: 1 },
  $or: [{ reorder_snooze_until: null }, { reorder_snooze_until: { $exists: false } }, { reorder_snooze_until: { $lt: t } }],
})

const ceilDiv = (a, b) => Math.ceil(a / b)

export async function demandSuggestions(db, { days = 30, coverDays = 21, leadDays = 7, supplierId = null } = {}) {
  const t = today()
  const since = addDays(t, -days)
  const since90 = addDays(t, -90)
  const products = db.col('products')

  // Net use per product: sales and issues out, returns back in.
  const useRows = (from) => db.col('stock_movements').aggregate([
    { $match: { created_at: { $gte: from }, reason: { $in: USE_REASONS } } },
    { $group: { _id: '$product_id', used: { $sum: { $multiply: ['$change', -1] } } } },
  ]).toArray()
  const [used30, used90, withLevel] = await Promise.all([
    useRows(since), useRows(since90),
    products.distinct('id', { active: 1, reorder_level: { $gt: 0 } }),
  ])
  const usedIn = new Map(used30.map((r) => [r._id, Math.max(0, r.used)]))
  const usedIn90 = new Map(used90.map((r) => [r._id, Math.max(0, r.used)]))
  const ids = [...new Set([...withLevel, ...used30.filter((r) => r.used > 0).map((r) => r._id)])]
  if (!ids.length) return { as_of: t, days, cover_days: coverDays, suggestions: [], idle: [] }

  const [items, stockRows, openLists, batchRows] = await Promise.all([
    db.all('products', { _id: { $in: ids }, active: 1, ...reorderable(t) }, {
      projection: { id: 1, name: 1, strength: 1, form: 1, barcode: 1, pack_size: 1, packing: 1, reorder_level: 1, schedule: 1 },
    }),
    db.col('batches').aggregate([
      { $match: { product_id: { $in: ids }, expiry_date: { $gte: t }, qty_on_hand: { $gt: 0 } } },
      { $group: { _id: '$product_id', q: { $sum: '$qty_on_hand' } } },
    ]).toArray(),
    db.all('demand_lists', { status: { $in: OPEN } }, { projection: { items: 1 } }),
    db.all('batches', { product_id: { $in: ids } }, { projection: { id: 1, product_id: 1 } }),
  ])
  const stock = new Map(stockRows.map((r) => [r._id, r.q]))
  const onOrder = new Map()
  for (const l of openLists) for (const it of l.items || []) onOrder.set(it.product_id, (onOrder.get(it.product_id) || 0) + it.units)

  // Last purchase of each product: supplier and pack cost.
  const batchProduct = new Map(batchRows.map((b) => [b.id, b.product_id]))
  const lastLine = new Map()
  if (batchRows.length) {
    const lines = await db.all('purchase_items', { batch_id: { $in: batchRows.map((b) => b.id) } }, {
      sort: { id: -1 }, projection: { batch_id: 1, purchase_id: 1, pack_cost: 1, cost_price: 1 },
    })
    for (const l of lines) {
      const pid = batchProduct.get(l.batch_id)
      if (!lastLine.has(pid)) lastLine.set(pid, l)
    }
  }
  const lastRows = [...lastLine.entries()].map(([product_id, l]) => ({ product_id, purchase_id: l.purchase_id, pack_cost: l.pack_cost, cost_price: l.cost_price }))
  await db.join(lastRows, [{ key: 'purchase_id', from: 'purchases', fields: { supplier_id: 'supplier_id' } }])
  await db.join(lastRows, [{ key: 'supplier_id', from: 'suppliers', fields: { supplier_name: 'name' } }])
  const last = new Map(lastRows.map((r) => [r.product_id, r]))

  const suggestions = []
  const idle = []
  for (const p of items) {
    const ps = p.pack_size || 1
    const have = stock.get(p.id) || 0
    const ordered = onOrder.get(p.id) || 0
    const used = usedIn.get(p.id) || 0
    const daily = used / days
    const level = p.reorder_level || 0
    const available = have + ordered
    const trigger = Math.max(level, Math.ceil(daily * leadDays))
    if (available > trigger || trigger === 0) continue
    const lp = last.get(p.id)
    const row = {
      product_id: p.id, code: p.barcode, name: p.name, strength: p.strength, form: p.form, schedule: p.schedule,
      pack_size: ps, packing: p.packing, stock: have, on_order: ordered, reorder_level: level,
      used, days, daily: Math.round(daily * 100) / 100, days_left: daily > 0 ? Math.floor(have / daily) : null,
      supplier_id: lp?.supplier_id ?? null, supplier_name: lp?.supplier_name ?? null,
      last_pack_cost: lp ? (lp.pack_cost ?? lp.cost_price * ps) : null,
    }
    // Not sold or issued for 90 days: probably not needed again, so it is listed, not ordered.
    if (!(usedIn90.get(p.id) > 0)) {
      idle.push({ ...row, reason: 'No sales or ward issues in 90 days' })
      continue
    }
    const target = Math.max(Math.ceil(daily * coverDays), level * 2, level + 1)
    const packs = Math.max(1, ceilDiv(target - available, ps))
    row.suggested_packs = packs
    row.suggested_units = packs * ps
    row.est_cost = row.last_pack_cost != null ? row.last_pack_cost * packs : null
    row.reason = level > 0 && available <= level
      ? `At or below reorder level (${available} ≤ ${level})`
      : `Runs out in about ${row.days_left ?? 0} days at current use`
    suggestions.push(row)
  }
  const bySupplier = (a, b) => String(a.supplier_name || '~').localeCompare(String(b.supplier_name || '~')) || a.name.localeCompare(b.name)
  const filter = (r) => supplierId === null || (supplierId === 0 ? r.supplier_id === null : r.supplier_id === supplierId)
  return {
    as_of: t, days, cover_days: coverDays,
    suggestions: suggestions.filter(filter).sort(bySupplier),
    idle: idle.filter(filter).sort(bySupplier),
  }
}

async function readItems(db, items) {
  if (!Array.isArray(items) || !items.length) throw badRequest('Add at least one item')
  if (items.length > 300) throw badRequest('At most 300 items in one demand list')
  const out = new Map()
  for (const [i, it] of items.entries()) {
    const label = `Item ${i + 1}`
    const productId = reqInt(it, 'product_id', { min: 1, label: `${label}: product` })
    const p = await db.get('products', productId)
    if (!p) throw badRequest(`${label}: product not found`)
    const ps = p.pack_size || 1
    const packs = optInt(it, 'packs', 0, { min: 0, max: 100000, label: `${label}: packs` })
    const loose = optInt(it, 'loose', 0, { min: 0, max: 100000, label: `${label}: loose units` })
    const units = packs * ps + loose
    if (units < 1) throw badRequest(`${p.name}: give a quantity`)
    const prev = out.get(p.id)
    const total = (prev?.units || 0) + units
    out.set(p.id, {
      product_id: p.id, code: p.barcode || null, name: p.name, strength: p.strength || null, form: p.form || null,
      pack_size: ps, packing: p.packing || null, units: total, packs: Math.floor(total / ps), loose: total % ps,
      last_pack_cost: it.last_pack_cost === undefined || it.last_pack_cost === null || it.last_pack_cost === '' ? (prev?.last_pack_cost ?? null)
        : reqInt(it, 'last_pack_cost', { min: 0, label: `${label}: last cost` }),
      note: optString(it, 'note') ?? prev?.note ?? null,
    })
  }
  return [...out.values()]
}

const estTotal = (items) => items.reduce((s, it) => s + (it.last_pack_cost != null ? Math.round((it.last_pack_cost * it.units) / it.pack_size) : 0), 0)

async function loadList(db, id) {
  const l = await db.get('demand_lists', id)
  if (!l) return null
  await db.join([l], [
    { key: 'supplier_id', from: 'suppliers', fields: { supplier_name: 'name', supplier_phone: 'phone', supplier_contact: 'contact_person' } },
    { key: 'user_id', from: 'users', fields: { user_name: 'full_name' } },
  ])
  return l
}

export default function demandRoutes(db) {
  const r = Router()
  r.use(requireRole('admin', 'pharmacist'))

  // ?days=30 (use window) &cover_days=21 (how long the order should last) &supplier_id= (0 = no supplier yet)
  r.get('/suggestions', async (req, res) => {
    const days = optInt(req.query, 'days', 30, { min: 7, max: 365, label: 'Days' })
    const coverDays = optInt(req.query, 'cover_days', 21, { min: 3, max: 180, label: 'Cover days' })
    const supplierId = req.query.supplier_id === undefined || req.query.supplier_id === '' ? null : Number(req.query.supplier_id)
    res.json(await demandSuggestions(db, { days, coverDays, supplierId }))
  })

  // Items marked not needed, or skipped until a date.
  r.get('/not-needed', async (req, res) => {
    const t = today()
    res.json(await db.all('products', { $or: [{ no_reorder: 1 }, { reorder_snooze_until: { $gte: t } }] }, {
      projection: { id: 1, barcode: 1, name: 1, strength: 1, form: 1, no_reorder: 1, reorder_snooze_until: 1 }, sort: { name: 1 }, limit: 2000,
    }))
  })

  // Body: { product_id, mode: 'never' | 'snooze' | 'restore', days? (snooze, default 30) }
  r.post('/skip', async (req, res) => {
    const id = reqInt(req.body, 'product_id', { min: 1, label: 'Product' })
    const mode = oneOf(req.body.mode, ['never', 'snooze', 'restore'], 'Mode')
    const p = await db.get('products', id)
    if (!p) throw notFound('Product')
    const set = mode === 'never' ? { no_reorder: 1, reorder_snooze_until: null }
      : mode === 'snooze' ? { no_reorder: 0, reorder_snooze_until: addDays(today(), optInt(req.body, 'days', 30, { min: 1, max: 365, label: 'Days' })) }
        : { no_reorder: 0, reorder_snooze_until: null }
    await db.col('products').updateOne({ _id: id }, { $set: set })
    res.json({ product_id: id, name: p.name, ...set })
  })

  r.get('/lists', async (req, res) => {
    const filter = {}
    if (req.query.status) filter.status = oneOf(String(req.query.status), STATUSES, 'Status')
    if (req.query.supplier_id) filter.supplier_id = Number(req.query.supplier_id)
    const rows = await db.all('demand_lists', filter, { sort: { id: -1 }, limit: 300, projection: { items: 0 } })
    await db.join(rows, [{ key: 'supplier_id', from: 'suppliers', fields: { supplier_name: 'name' } }])
    res.json(rows)
  })

  r.get('/lists/:id', async (req, res) => {
    const l = await loadList(db, Number(req.params.id))
    if (!l) throw notFound('Demand list')
    res.json(l)
  })

  const readSupplier = async (body) => {
    const sid = optInt(body, 'supplier_id', null, { min: 1, label: 'Supplier' })
    if (sid && !(await db.get('suppliers', sid))) throw badRequest('Supplier not found')
    return sid
  }

  // Body: { supplier_id?, note?, items: [{ product_id, packs?, loose?, last_pack_cost?, note? }] }
  r.post('/lists', async (req, res) => {
    const supplierId = await readSupplier(req.body)
    const items = await readItems(db, req.body.items)
    const id = await db.nextId('demand_lists')
    const stamp = nowStamp()
    await db.col('demand_lists').insertOne({
      _id: id, id, demand_no: `DL-${String(id).padStart(5, '0')}`, supplier_id: supplierId, status: 'draft',
      note: optString(req.body, 'note'), items, item_count: items.length, est_total: estTotal(items), user_id: req.user.id,
      created_at: stamp, updated_at: stamp, sent_at: null, received_at: null,
    })
    res.status(201).json(await loadList(db, id))
  })

  // Drafts can be edited: supplier, note, items.
  r.put('/lists/:id', async (req, res) => {
    const id = Number(req.params.id)
    const cur = await db.get('demand_lists', id)
    if (!cur) throw notFound('Demand list')
    if (cur.status !== 'draft') throw new HttpError(409, `This list was ${cur.status}; only drafts can be changed`)
    const set = { updated_at: nowStamp() }
    if (req.body.supplier_id !== undefined) set.supplier_id = await readSupplier(req.body)
    if (req.body.note !== undefined) set.note = optString(req.body, 'note')
    if (req.body.items !== undefined) {
      set.items = await readItems(db, req.body.items)
      set.item_count = set.items.length
      set.est_total = estTotal(set.items)
    }
    await db.col('demand_lists').updateOne({ _id: id, status: 'draft' }, { $set: set })
    res.json(await loadList(db, id))
  })

  // Body: { status: 'sent' | 'received' | 'cancelled' }
  r.post('/lists/:id/status', async (req, res) => {
    const id = Number(req.params.id)
    const status = oneOf(req.body.status, ['sent', 'received', 'cancelled', 'draft'], 'Status')
    const cur = await db.get('demand_lists', id)
    if (!cur) throw notFound('Demand list')
    const allowed = { draft: ['sent', 'cancelled'], sent: ['received', 'cancelled', 'draft'], received: [], cancelled: ['draft'] }
    if (!allowed[cur.status].includes(status)) throw new HttpError(409, `A ${cur.status} list cannot be marked ${status}`)
    const set = { status, updated_at: nowStamp() }
    if (status === 'sent') set.sent_at = nowStamp()
    if (status === 'received') set.received_at = nowStamp()
    await db.col('demand_lists').updateOne({ _id: id, status: cur.status }, { $set: set })
    res.json(await loadList(db, id))
  })

  return r
}
