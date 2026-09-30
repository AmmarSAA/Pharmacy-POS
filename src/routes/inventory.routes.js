import { Router } from 'express'
import { requireRole } from '../auth.js'
import { transaction, today, getSettings } from '../db.js'
import { reqInt, reqString, optString, oneOf, badRequest } from '../lib/http.js'
import { moveStock } from '../lib/stock.js'

const ADJUST_REASONS = ['adjustment', 'expired', 'damaged']

export default function inventoryRoutes(db) {
  const r = Router()

  // ?status=expired|near|low ; ?product_id=
  r.get('/batches', (req, res) => {
    const t = today()
    const nearDays = Number(getSettings(db).near_expiry_days) || 90
    const where = ['b.qty_on_hand > 0']
    const params = { today: t, near: `+${nearDays} days` }
    if (req.query.product_id) {
      where.push('b.product_id = :pid')
      params.pid = Number(req.query.product_id)
    }
    if (req.query.status === 'expired') where.push('b.expiry_date < :today')
    if (req.query.status === 'near') where.push("b.expiry_date >= :today AND b.expiry_date <= date(:today, :near)")
    res.json(
      db.prepare(
        `SELECT b.*, p.name AS product_name, p.generic_name, p.schedule,
           CASE WHEN b.expiry_date < :today THEN 'expired'
                WHEN b.expiry_date <= date(:today, :near) THEN 'near' ELSE 'ok' END AS expiry_status,
           CAST(julianday(b.expiry_date) - julianday(:today) AS INTEGER) AS days_to_expiry
         FROM batches b JOIN products p ON p.id = b.product_id
         WHERE ${where.join(' AND ')}
         ORDER BY b.expiry_date, p.name`,
      ).all(params),
    )
  })

  r.get('/movements', requireRole('admin', 'pharmacist'), (req, res) => {
    const params = []
    let where = ''
    if (req.query.product_id) {
      where = 'WHERE m.product_id = ?'
      params.push(Number(req.query.product_id))
    }
    res.json(
      db.prepare(
        `SELECT m.*, p.name AS product_name, b.batch_no, u.full_name AS user_name
         FROM stock_movements m JOIN products p ON p.id = m.product_id JOIN batches b ON b.id = m.batch_id
         JOIN users u ON u.id = m.user_id ${where} ORDER BY m.id DESC LIMIT 500`,
      ).all(...params),
    )
  })

  // Manual correction: stock count, expired write-off, breakage.
  r.post('/adjustments', requireRole('admin', 'pharmacist'), (req, res) => {
    const batchId = reqInt(req.body, 'batch_id', { min: 1, label: 'Batch' })
    const change = reqInt(req.body, 'change', { label: 'Quantity change' })
    if (change === 0) throw badRequest('Quantity change cannot be zero')
    const reason = oneOf(req.body.reason || 'adjustment', ADJUST_REASONS, 'Reason')
    if (reason !== 'adjustment' && change > 0) throw badRequest('Write-offs must reduce stock')
    const note = reason === 'adjustment' ? reqString(req.body, 'note', 'Note') : optString(req.body, 'note')
    const balance = transaction(db, () =>
      moveStock(db, { batchId, change, reason, userId: req.user.id, note }),
    )
    res.status(201).json({ batch_id: batchId, balance })
  })

  return r
}
