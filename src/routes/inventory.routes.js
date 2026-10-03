import { Router } from '../lib/router.js'
import { requireRole } from '../auth.js'
import { today, getSettings } from '../db.js'
import { reqInt, reqString, optString, oneOf, badRequest } from '../lib/http.js'
import { moveStock } from '../lib/stock.js'
import { addDays, daysBetween } from '../lib/supplier-ledger.js'

const ADJUST_REASONS = ['adjustment', 'expired', 'damaged']

export default function inventoryRoutes(db) {
  const r = Router()

  // ?status=expired|near|low ; ?product_id=
  r.get('/batches', async (req, res) => {
    const t = today()
    const nearDays = Number((await getSettings(db)).near_expiry_days) || 90
    const nearLimit = addDays(t, nearDays)
    const filter = { qty_on_hand: { $gt: 0 } }
    if (req.query.product_id) filter.product_id = Number(req.query.product_id)
    if (req.query.status === 'expired') filter.expiry_date = { $lt: t }
    if (req.query.status === 'near') filter.expiry_date = { $gte: t, $lte: nearLimit }
    const rows = await db.all('batches', filter, { sort: { expiry_date: 1 } })
    await db.join(rows, [{ key: 'product_id', from: 'products', fields: { product_name: 'name', generic_name: 'generic_name', schedule: 'schedule' } }])
    for (const b of rows) {
      b.expiry_status = b.expiry_date < t ? 'expired' : b.expiry_date <= nearLimit ? 'near' : 'ok'
      b.days_to_expiry = daysBetween(t, b.expiry_date)
    }
    rows.sort((a, b) => (a.expiry_date < b.expiry_date ? -1 : a.expiry_date > b.expiry_date ? 1 : String(a.product_name).localeCompare(String(b.product_name))))
    res.json(rows)
  })

  r.get('/movements', requireRole('admin', 'pharmacist'), async (req, res) => {
    const filter = req.query.product_id ? { product_id: Number(req.query.product_id) } : {}
    const rows = await db.all('stock_movements', filter, { sort: { id: -1 }, limit: 500 })
    res.json(await db.join(rows, [
      { key: 'product_id', from: 'products', fields: { product_name: 'name' } },
      { key: 'batch_id', from: 'batches', fields: { batch_no: 'batch_no' } },
      { key: 'user_id', from: 'users', fields: { user_name: 'full_name' } },
    ]))
  })

  // Manual correction: stock count, expired write-off, breakage.
  r.post('/adjustments', requireRole('admin', 'pharmacist'), async (req, res) => {
    const batchId = reqInt(req.body, 'batch_id', { min: 1, label: 'Batch' })
    const change = reqInt(req.body, 'change', { label: 'Quantity change' })
    if (change === 0) throw badRequest('Quantity change cannot be zero')
    const reason = oneOf(req.body.reason || 'adjustment', ADJUST_REASONS, 'Reason')
    if (reason !== 'adjustment' && change > 0) throw badRequest('Write-offs must reduce stock')
    const note = reason === 'adjustment' ? reqString(req.body, 'note', 'Note') : optString(req.body, 'note')
    const balance = await db.tx(() => moveStock(db, { batchId, change, reason, userId: req.user.id, note }))
    res.status(201).json({ batch_id: batchId, balance })
  })

  return r
}
