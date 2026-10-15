import { Router } from '../lib/router.js'
import { requirePermission } from '../auth.js'
import { today, nowStamp } from '../db.js'
import { HttpError, badRequest, notFound, reqInt, reqString, optString } from '../lib/http.js'
import { allocateFefo, moveStock } from '../lib/stock.js'

// Stock sent from this pharmacy to another site (a branch, a warehouse). Scope, by design: this
// tracks what left the main location's sellable stock, at cost, with a correction path — it does
// not give the destination its own live, sellable inventory (a second full location is a much
// larger change; see docs/PLAN.md Round 8).

async function loadTransfer(db, id) {
  const t = await db.get('stock_transfers', id)
  if (!t) return null
  await db.join([t], [
    { key: 'to_location_id', from: 'locations', fields: { location_name: 'name' } },
    { key: 'user_id', from: 'users', fields: { sent_by: 'full_name' } },
    { key: 'received_by', from: 'users', fields: { received_by_name: 'full_name' } },
  ])
  t.items = await db.all('stock_transfer_items', { transfer_id: t.id }, { sort: { id: 1 } })
  await db.join(t.items, [
    { key: 'product_id', from: 'products', fields: { product_name: 'name', strength: 'strength', form: 'form' } },
    { key: 'batch_id', from: 'batches', fields: { batch_no: 'batch_no', expiry_date: 'expiry_date' } },
  ])
  return t
}

export default function transferRoutes(db) {
  const r = Router()
  r.use(requirePermission('transfers.manage'))

  // ---- locations ----
  r.get('/locations', async (req, res) => {
    let rows = await db.all('locations', {}, { sort: { name: 1 } })
    if (req.query.active === '1') rows = rows.filter((l) => l.active)
    res.json(rows)
  })
  r.post('/locations', async (req, res) => {
    const name = reqString(req.body, 'name', 'Name')
    if (await db.col('locations').findOne({ name })) throw new HttpError(409, 'A location with that name already exists')
    const id = await db.insert('locations', { name, address: optString(req.body, 'address'), active: 1 })
    res.status(201).json(await db.get('locations', id))
  })
  r.put('/locations/:id', async (req, res) => {
    const id = Number(req.params.id)
    const loc = await db.get('locations', id)
    if (!loc) throw notFound('Location')
    const name = req.body.name !== undefined ? reqString(req.body, 'name', 'Name') : loc.name
    const active = req.body.active !== undefined ? (req.body.active ? 1 : 0) : loc.active
    await db.col('locations').updateOne({ _id: id }, { $set: { name, address: optString(req.body, 'address') ?? loc.address, active } })
    res.json(await db.get('locations', id))
  })

  // ---- transfers ----
  // ?status= ?to_location_id=
  r.get('/', async (req, res) => {
    const filter = {}
    if (req.query.status) filter.status = req.query.status
    if (req.query.to_location_id) filter.to_location_id = Number(req.query.to_location_id)
    const rows = await db.all('stock_transfers', filter, { sort: { id: -1 } })
    res.json(await db.join(rows, [{ key: 'to_location_id', from: 'locations', fields: { location_name: 'name' } }]))
  })

  r.get('/:id', async (req, res) => {
    const t = await loadTransfer(db, Number(req.params.id))
    if (!t) throw notFound('Transfer')
    res.json(t)
  })

  // Body: { to_location_id, notes?, items: [{ product_id, qty }] }. Stock leaves this location
  // immediately (FEFO), the same way an issue to a department does.
  r.post('/', async (req, res) => {
    const toLocationId = reqInt(req.body, 'to_location_id', { min: 1, label: 'Destination' })
    const location = await db.get('locations', toLocationId)
    if (!location || !location.active) throw badRequest('Destination location not found')
    const items = req.body.items
    if (!Array.isArray(items) || items.length === 0) throw badRequest('Add at least one item')
    const onDate = today()

    const id = await db.tx(async () => {
      const lines = []
      for (const [i, it] of items.entries()) {
        const label = `Item ${i + 1}`
        const productId = reqInt(it, 'product_id', { min: 1, label: `${label}: product` })
        const qty = reqInt(it, 'qty', { min: 1, label: `${label}: quantity` })
        const product = await db.get('products', productId)
        if (!product) throw badRequest(`${label}: product not found`)
        const { picks, available, short } = await allocateFefo(db, productId, qty, onDate)
        if (short > 0) throw new HttpError(409, `Not enough stock for ${product.name}: ${available} available`)
        for (const { batch, qty: pickQty } of picks) {
          lines.push({ product_id: productId, batch_id: batch.id, qty: pickQty, cost_price: batch.cost_price, line_total: batch.cost_price * pickQty })
        }
      }
      const transferId = await db.nextId('stock_transfers')
      await db.col('stock_transfers').insertOne({
        _id: transferId, id: transferId, transfer_no: `TR${String(transferId).padStart(6, '0')}`,
        to_location_id: toLocationId, status: 'sent', notes: optString(req.body, 'notes'),
        total_cost: lines.reduce((s, l) => s + l.line_total, 0), user_id: req.user.id, created_at: nowStamp(),
        received_at: null, received_by: null,
      })
      let itemId = await db.reserveIds('stock_transfer_items', lines.length)
      await db.col('stock_transfer_items').insertMany(lines.map((l) => {
        const lineId = itemId++
        return { _id: lineId, id: lineId, transfer_id: transferId, ...l }
      }))
      for (const l of lines) {
        await moveStock(db, { batchId: l.batch_id, change: -l.qty, reason: 'transfer', refId: transferId, userId: req.user.id })
      }
      return transferId
    })
    res.status(201).json(await loadTransfer(db, id))
  })

  // Acknowledges the destination got it. No stock movement (see module note above).
  r.post('/:id/receive', async (req, res) => {
    const id = Number(req.params.id)
    const t = await db.get('stock_transfers', id)
    if (!t) throw notFound('Transfer')
    if (t.status !== 'sent') throw new HttpError(409, `This transfer is ${t.status}`)
    await db.col('stock_transfers').updateOne({ _id: id }, { $set: { status: 'received', received_at: nowStamp(), received_by: req.user.id } })
    res.json(await loadTransfer(db, id))
  })

  // Corrects a mistaken transfer: puts the stock back (unexpired batches only), before it's
  // been acknowledged received at the other end.
  r.post('/:id/cancel', async (req, res) => {
    const id = Number(req.params.id)
    const t = await db.get('stock_transfers', id)
    if (!t) throw notFound('Transfer')
    if (t.status !== 'sent') throw new HttpError(409, `A ${t.status} transfer cannot be cancelled`)
    await db.tx(async () => {
      const items = await db.all('stock_transfer_items', { transfer_id: id })
      for (const it of items) {
        const batch = await db.get('batches', it.batch_id)
        if (batch && batch.expiry_date >= today()) {
          await moveStock(db, { batchId: it.batch_id, change: it.qty, reason: 'transfer_return', refId: id, userId: req.user.id })
        }
      }
      await db.col('stock_transfers').updateOne({ _id: id }, { $set: { status: 'cancelled' } })
    })
    res.json(await loadTransfer(db, id))
  })

  return r
}
