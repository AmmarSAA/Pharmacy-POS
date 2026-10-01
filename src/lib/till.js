import { HttpError } from './http.js'

// Shared by sales, returns, supplier payments and the till routes.

export function openTillFor(db, userId) {
  return db.prepare("SELECT * FROM till_sessions WHERE user_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1").get(userId) || null
}

// The user's open till, or a 409 when the pharmacy requires one (setting require_open_till = '1').
export function tillForCash(db, userId, settings, action = 'take cash') {
  const till = openTillFor(db, userId)
  if (!till && settings.require_open_till === '1') {
    throw new HttpError(409, `Open your till before you ${action}`)
  }
  return till
}

// Cash the drawer should hold for a session, with the figures behind it.
export function tillTotals(db, sessionId) {
  const s = db.prepare('SELECT * FROM till_sessions WHERE id = ?').get(sessionId)
  if (!s) return null
  const one = (sql) => db.prepare(sql).get(sessionId).v || 0
  const byMethod = (m) => one(`SELECT COALESCE(SUM(total), 0) AS v FROM sales WHERE till_session_id = ? AND payment_method = '${m}'`)
  const totals = {
    opening_cash: s.opening_cash,
    cash_sales: byMethod('cash'),
    card_sales: byMethod('card'),
    wallet_sales: byMethod('wallet'),
    invoices: one('SELECT COUNT(*) AS v FROM sales WHERE till_session_id = ?'),
    // Only cash refunds leave the drawer; card/wallet refunds go back to the card/wallet.
    refunds: one("SELECT COALESCE(SUM(refund_total), 0) AS v FROM returns WHERE till_session_id = ? AND refund_method = 'cash'"),
    cash_in: one("SELECT COALESCE(SUM(amount), 0) AS v FROM cash_movements WHERE till_session_id = ? AND direction = 'in'"),
    cash_out: one("SELECT COALESCE(SUM(amount), 0) AS v FROM cash_movements WHERE till_session_id = ? AND direction = 'out'"),
  }
  totals.expected_cash = totals.opening_cash + totals.cash_sales - totals.refunds + totals.cash_in - totals.cash_out
  return totals
}

// Records cash leaving/entering the drawer of the user's open till.
export function recordCashMovement(db, { tillSessionId, direction, amount, reason, notes = null, supplierPaymentId = null, userId }) {
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO cash_movements (till_session_id, direction, amount, reason, notes, supplier_payment_id, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(tillSessionId, direction, amount, reason, notes, supplierPaymentId, userId)
  return Number(lastInsertRowid)
}
