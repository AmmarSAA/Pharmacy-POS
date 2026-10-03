import { HttpError } from './http.js'

// Shared by sales, returns, supplier payments and the till routes.

export async function openTillFor(db, userId) {
  return (await db.col('till_sessions').findOne({ user_id: userId, status: 'open' }, { sort: { id: -1 } })) || null
}

// The user's open till, or a 409 when the pharmacy requires one (setting require_open_till = '1').
export async function tillForCash(db, userId, settings, action = 'take cash') {
  const till = await openTillFor(db, userId)
  if (!till && settings.require_open_till === '1') {
    throw new HttpError(409, `Open your till before you ${action}`)
  }
  return till
}

// Cash the drawer should hold for a session, with the figures behind it.
export async function tillTotals(db, sessionId) {
  const s = await db.get('till_sessions', sessionId)
  if (!s) return null
  const byMethod = await db.col('sales').aggregate([
    { $match: { till_session_id: s.id } },
    { $group: { _id: '$payment_method', total: { $sum: '$total' }, n: { $sum: 1 } } },
  ]).toArray()
  const m = Object.fromEntries(byMethod.map((r) => [r._id, r]))
  const moves = await db.col('cash_movements').aggregate([
    { $match: { till_session_id: s.id } }, { $group: { _id: '$direction', v: { $sum: '$amount' } } },
  ]).toArray()
  const mv = Object.fromEntries(moves.map((r) => [r._id, r.v]))
  const totals = {
    opening_cash: s.opening_cash,
    cash_sales: m.cash?.total || 0,
    card_sales: m.card?.total || 0,
    wallet_sales: m.wallet?.total || 0,
    invoices: byMethod.reduce((n, r) => n + r.n, 0),
    // Only cash refunds leave the drawer; card/wallet refunds go back to the card/wallet.
    refunds: await db.sum('returns', { till_session_id: s.id, refund_method: 'cash' }, 'refund_total'),
    cash_in: mv.in || 0,
    cash_out: mv.out || 0,
  }
  totals.expected_cash = totals.opening_cash + totals.cash_sales - totals.refunds + totals.cash_in - totals.cash_out
  return totals
}

// Records cash leaving/entering the drawer of the user's open till.
export async function recordCashMovement(db, { tillSessionId, direction, amount, reason, notes = null, supplierPaymentId = null, userId }) {
  return db.insert('cash_movements', {
    till_session_id: tillSessionId, direction, amount, reason, notes, supplier_payment_id: supplierPaymentId, user_id: userId,
  })
}
