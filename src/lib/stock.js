import { HttpError } from './http.js'

// The only place batch quantities change. Records a movement with the resulting balance.
// The decrement is conditional, so two tills selling the last units cannot go below zero.
export async function moveStock(db, { batchId, change, reason, refId = null, userId, note = null }) {
  const batches = db.col('batches')
  const filter = change < 0 ? { _id: batchId, qty_on_hand: { $gte: -change } } : { _id: batchId }
  const batch = await batches.findOneAndUpdate(filter, { $inc: { qty_on_hand: change } })
  if (!batch) {
    const b = await batches.findOne({ _id: batchId })
    if (!b) throw new HttpError(404, 'Batch not found')
    throw new HttpError(409, `Batch only has ${b.qty_on_hand} in stock`)
  }
  await db.insert('stock_movements', {
    batch_id: batchId, product_id: batch.product_id, change, balance: batch.qty_on_hand, reason,
    ref_id: refId, user_id: userId, note,
  })
  return batch.qty_on_hand
}

// First-expiry-first-out: split a requested quantity across sellable (unexpired) batches.
export async function allocateFefo(db, productId, qty, onDate) {
  const batches = await db.col('batches')
    .find({ product_id: productId, qty_on_hand: { $gt: 0 }, expiry_date: { $gte: onDate } }, { sort: { expiry_date: 1, id: 1 } })
    .toArray()
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
