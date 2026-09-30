import { HttpError } from './http.js'

// The only place batch quantities change. Records a movement row with the resulting balance.
export function moveStock(db, { batchId, change, reason, refId = null, userId, note = null }) {
  const batch = db.prepare('SELECT id, product_id, qty_on_hand FROM batches WHERE id = ?').get(batchId)
  if (!batch) throw new HttpError(404, 'Batch not found')
  const balance = batch.qty_on_hand + change
  if (balance < 0) throw new HttpError(409, `Batch only has ${batch.qty_on_hand} in stock`)
  db.prepare('UPDATE batches SET qty_on_hand = ? WHERE id = ?').run(balance, batchId)
  db.prepare(
    `INSERT INTO stock_movements (batch_id, product_id, change, balance, reason, ref_id, user_id, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(batchId, batch.product_id, change, balance, reason, refId, userId, note)
  return balance
}

// First-expiry-first-out: split a requested quantity across sellable (unexpired) batches.
export function allocateFefo(db, productId, qty, onDate) {
  const batches = db
    .prepare(
      `SELECT id, batch_no, expiry_date, qty_on_hand, sale_price, cost_price, pack_price, pack_size
       FROM batches
       WHERE product_id = ? AND qty_on_hand > 0 AND expiry_date >= ?
       ORDER BY expiry_date, id`,
    )
    .all(productId, onDate)
  const picks = []
  let remaining = qty
  for (const b of batches) {
    if (remaining === 0) break
    const take = Math.min(remaining, b.qty_on_hand)
    picks.push({ batch: b, qty: take })
    remaining -= take
  }
  const available = batches.reduce((sum, b) => sum + b.qty_on_hand, 0)
  return { picks, available, short: remaining }
}
