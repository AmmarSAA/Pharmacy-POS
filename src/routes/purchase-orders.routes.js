import { Router } from '../lib/router.js'
import { requirePermission } from '../auth.js'
import { today } from '../db.js'
import { HttpError, badRequest, notFound, reqInt, optInt, reqString, optString, optDate } from '../lib/http.js'
import { packAmount } from '../lib/money.js'

const STATUSES = ['draft', 'sent', 'received', 'cancelled']
// Same shape as demand_lists' transition table: a sent order can still be pulled back to draft,
// a cancelled one can be reopened. Only purchases.routes.js (on actual receipt) marks one received.
const ALLOWED = { draft: ['sent', 'cancelled'], sent: ['draft', 'cancelled'], received: [], cancelled: ['draft'] }

function readLine(it, i) {
  const label = `Item ${i + 1}`
  const productId = reqInt(it, 'product_id', { min: 1, label: `${label}: product` })
  const packSize = optInt(it, 'pack_size', 1, { min: 1, label: `${label}: pack size` })
  const packs = optInt(it, 'packs', 0, { min: 0, max: 100000, label: `${label}: packs` })
  const loose = optInt(it, 'loose_qty', 0, { min: 0, max: 100000, label: `${label}: loose units` })
  const qty = packs * packSize + loose
  if (qty < 1) throw badRequest(`${label}: quantity must be at least 1`)
  const packCost = reqInt(it, 'pack_cost', { min: 0, label: `${label}: pack cost` })
  return { product_id: productId, packs, loose_qty: loose, pack_size: packSize, pack_cost: packCost, qty, line_total: packAmount(qty, packCost, packSize) }
}

async function loadOrder(db, id) {
  const po = await db.get('purchase_orders', id)
  if (!po) return null
  await db.join([po], [
    { key: 'supplier_id', from: 'suppliers', fields: { supplier_name: 'name' } },
    { key: 'user_id', from: 'users', fields: { user_name: 'full_name' } },
    { key: 'received_purchase_id', from: 'purchases', fields: { received_invoice_no: 'invoice_no' } },
  ])
  po.items = await db.all('purchase_order_items', { purchase_order_id: po.id }, { sort: { id: 1 } })
  await db.join(po.items, [{ key: 'product_id', from: 'products', fields: { product_name: 'name', strength: 'strength', form: 'form' } }])
  return po
}

export default function purchaseOrderRoutes(db) {
  const r = Router()
  r.use(requirePermission('purchase_orders.manage'))

  // ?status= ?supplier_id=
  r.get('/', async (req, res) => {
    const filter = {}
    if (req.query.status) filter.status = req.query.status
    if (req.query.supplier_id) filter.supplier_id = Number(req.query.supplier_id)
    const rows = await db.all('purchase_orders', filter, { sort: { id: -1 } })
    res.json(await db.join(rows, [{ key: 'supplier_id', from: 'suppliers', fields: { supplier_name: 'name' } }]))
  })

  r.get('/:id', async (req, res) => {
    const po = await loadOrder(db, Number(req.params.id))
    if (!po) throw notFound('Purchase order')
    res.json(po)
  })

  // Body: { supplier_id, expected_date?, notes?, items: [{ product_id, packs, loose_qty, pack_size, pack_cost }] }
  r.post('/', async (req, res) => {
    const supplierId = reqInt(req.body, 'supplier_id', { min: 1, label: 'Supplier' })
    if (!(await db.get('suppliers', supplierId))) throw badRequest('Supplier not found')
    const items = req.body.items
    if (!Array.isArray(items) || items.length === 0) throw badRequest('Add at least one item')
    const lines = items.map(readLine)
    const id = await db.tx(async () => {
      const poId = await db.insert('purchase_orders', {
        supplier_id: supplierId, status: 'draft', order_date: today(),
        expected_date: optDate(req.body, 'expected_date', 'Expected date'), notes: optString(req.body, 'notes'),
        total: lines.reduce((s, l) => s + l.line_total, 0), received_purchase_id: null, user_id: req.user.id,
      })
      let itemId = await db.reserveIds('purchase_order_items', lines.length)
      await db.col('purchase_order_items').insertMany(lines.map((l) => {
        const id = itemId++
        return { _id: id, id, purchase_order_id: poId, ...l }
      }))
      return poId
    })
    res.status(201).json(await loadOrder(db, id))
  })

  // Only while draft. Replaces every line.
  r.put('/:id', async (req, res) => {
    const id = Number(req.params.id)
    const po = await db.get('purchase_orders', id)
    if (!po) throw notFound('Purchase order')
    if (po.status !== 'draft') throw new HttpError(409, 'Only a draft order can be edited')
    const items = req.body.items
    if (!Array.isArray(items) || items.length === 0) throw badRequest('Add at least one item')
    const lines = items.map(readLine)
    await db.tx(async () => {
      await db.col('purchase_order_items').deleteMany({ purchase_order_id: id })
      let itemId = await db.reserveIds('purchase_order_items', lines.length)
      await db.col('purchase_order_items').insertMany(lines.map((l) => {
        const lineId = itemId++
        return { _id: lineId, id: lineId, purchase_order_id: id, ...l }
      }))
      await db.col('purchase_orders').updateOne({ _id: id }, { $set: {
        expected_date: optDate(req.body, 'expected_date', 'Expected date'), notes: optString(req.body, 'notes'),
        total: lines.reduce((s, l) => s + l.line_total, 0),
      } })
    })
    res.json(await loadOrder(db, id))
  })

  // Body: { status: 'sent' | 'draft' | 'cancelled' } ('received' is only ever set by receiving a purchase against this order)
  r.post('/:id/status', async (req, res) => {
    const id = Number(req.params.id)
    const po = await db.get('purchase_orders', id)
    if (!po) throw notFound('Purchase order')
    const status = reqString(req.body, 'status', 'Status')
    if (status === 'received') throw badRequest('Receive stock against this order from Purchases instead')
    if (!STATUSES.includes(status)) throw badRequest(`Status must be one of: ${STATUSES.join(', ')}`)
    if (!ALLOWED[po.status].includes(status)) throw new HttpError(409, `A ${po.status} order cannot be marked ${status}`)
    await db.col('purchase_orders').updateOne({ _id: id }, { $set: { status } })
    res.json(await loadOrder(db, id))
  })

  return r
}
