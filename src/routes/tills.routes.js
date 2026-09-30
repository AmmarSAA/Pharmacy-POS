import { Router } from 'express'
import { requireRole } from '../auth.js'
import { transaction, today, getSettings, sqlNow } from '../db.js'
import { HttpError, badRequest, notFound, reqInt, reqString, optString, reqDate, oneOf } from '../lib/http.js'
import { openTillFor, tillTotals, recordCashMovement } from '../lib/till.js'

// Till sessions, cash in/out and day close. See docs/API-CONTRACT.md.

const SUPERVISORS = ['admin', 'pharmacist']
const MAX_CASH = 1e12

// Current local timestamp on the same clock as the table defaults (datetime('now', <modifier>)).
// Current timestamp on the same clock as the column defaults.
const nowStamp = (db) => db.prepare(`SELECT ${sqlNow()} AS t`).get().t

// Note count { "5000": 2, "100": 3 } -> { notes, amount (paisa) }. Only the configured denominations.
function readNotes(notes, settings) {
  if (typeof notes !== 'object' || notes === null || Array.isArray(notes)) {
    throw badRequest('Notes must be a note count like { "5000": 2 }')
  }
  const allowed = new Set(String(settings.cash_denominations || '').split(',').map((d) => d.trim()).filter(Boolean))
  const clean = {}
  let rupees = 0
  for (const [den, count] of Object.entries(notes)) {
    const key = String(Number(den))
    if (!/^\d+$/.test(den.trim()) || !allowed.has(key)) throw badRequest(`Rs ${den} is not a listed note or coin`)
    const n = reqInt({ v: count }, 'v', { min: 0, max: 1000000, label: `Count of Rs ${key}` })
    if (n === 0) continue
    clean[key] = (clean[key] || 0) + n
    rupees += Number(key) * n
  }
  return { notes: clean, amount: rupees * 100 }
}

// Cash from a body: a note count (preferred) or a paisa amount in `field`.
function readCash(body, field, settings, label) {
  if (body.notes !== undefined && body.notes !== null) {
    const { notes, amount } = readNotes(body.notes, settings)
    return { amount, notes: JSON.stringify(notes) }
  }
  const v = body[field]
  const amount = v === undefined || v === null || v === '' ? 0 : reqInt(body, field, { min: 0, max: MAX_CASH, label })
  return { amount, notes: null }
}

function parseJson(text) {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

const varianceOf = (s) => (s.counted_cash !== null && s.expected_cash !== null ? s.counted_cash - s.expected_cash : null)

function present(s) {
  return { ...s, opening_notes: parseJson(s.opening_notes), closing_notes: parseJson(s.closing_notes), variance: varianceOf(s) }
}

function loadSession(db, id) {
  const s = db
    .prepare('SELECT t.*, u.full_name AS user_name FROM till_sessions t JOIN users u ON u.id = t.user_id WHERE t.id = ?')
    .get(id)
  return s ? present(s) : null
}

function movementsOf(db, sessionId) {
  return db
    .prepare(
      `SELECT m.*, u.full_name AS user_name FROM cash_movements m JOIN users u ON u.id = m.user_id
       WHERE m.till_session_id = ? ORDER BY m.id`,
    )
    .all(sessionId)
    .map((m) => ({ ...m, notes: parseJson(m.notes) }))
}

const TOTAL_KEYS = ['opening_cash', 'cash_sales', 'card_sales', 'wallet_sales', 'invoices', 'refunds', 'cash_in', 'cash_out',
  'expected_cash']

function daySummary(db, date) {
  const tills = db
    .prepare(
      `SELECT t.*, u.full_name AS user_name FROM till_sessions t JOIN users u ON u.id = t.user_id
       WHERE t.business_date = ? ORDER BY t.id`,
    )
    .all(date)
    .map((s) => ({
      id: s.id, user_id: s.user_id, user_name: s.user_name, opened_at: s.opened_at, closed_at: s.closed_at,
      expected_cash: s.expected_cash, counted_cash: s.counted_cash, variance: varianceOf(s),
      totals: tillTotals(db, s.id),
    }))
  const sum = (fn) => tills.reduce((acc, t) => acc + (fn(t) || 0), 0)
  const totals = Object.fromEntries(TOTAL_KEYS.map((k) => [k, sum((t) => t.totals[k])]))
  totals.counted_cash = sum((t) => t.counted_cash)
  totals.variance = sum((t) => t.variance)
  const sales = db
    .prepare('SELECT COUNT(*) AS count, COALESCE(SUM(total), 0) AS total FROM sales WHERE date(created_at) = ?')
    .get(date)
  const returns = db
    .prepare('SELECT COUNT(*) AS count, COALESCE(SUM(refund_total), 0) AS total FROM returns WHERE date(created_at) = ?')
    .get(date)
  return {
    date,
    tills,
    totals,
    sales: { count: sales.count, total: sales.total },
    returns: { count: returns.count, total: returns.total },
    net_sales: sales.total - returns.total,
  }
}

function loadDayClose(db, date) {
  const row = db
    .prepare('SELECT d.*, u.full_name AS user_name FROM day_closes d JOIN users u ON u.id = d.user_id WHERE d.business_date = ?')
    .get(date)
  return row ? { ...row, summary: parseJson(row.summary) } : null
}

export default function tillRoutes(db) {
  const r = Router()

  // The signed-in user's open till.
  r.get('/current', (req, res) => {
    const till = openTillFor(db, req.user.id)
    if (!till) return res.json({ session: null })
    res.json({ session: loadSession(db, till.id), totals: tillTotals(db, till.id), movements: movementsOf(db, till.id) })
  })

  // Body: { notes?: { "5000": 2, ... }, opening_cash? }
  r.post('/open', (req, res) => {
    const { amount, notes } = readCash(req.body, 'opening_cash', getSettings(db), 'Opening cash')
    const id = transaction(db, () => {
      if (openTillFor(db, req.user.id)) throw new HttpError(409, 'You already have an open till')
      return Number(
        db.prepare("INSERT INTO till_sessions (user_id, business_date, opening_cash, opening_notes, status) VALUES (?, ?, ?, ?, 'open')")
          .run(req.user.id, today(), amount, notes).lastInsertRowid,
      )
    })
    res.status(201).json(loadSession(db, id))
  })

  // Body: { direction: 'in'|'out', amount, reason, notes? }
  r.post('/current/movements', (req, res) => {
    const direction = oneOf(req.body.direction, ['in', 'out'], 'Direction')
    const amount = reqInt(req.body, 'amount', { min: 1, max: MAX_CASH, label: 'Amount' })
    const reason = reqString(req.body, 'reason', 'Reason')
    const notes = req.body.notes === undefined || req.body.notes === null
      ? null
      : JSON.stringify(readNotes(req.body.notes, getSettings(db)).notes)
    const till = openTillFor(db, req.user.id)
    if (!till) throw new HttpError(409, 'Open your till before you move cash')
    const id = recordCashMovement(db, { tillSessionId: till.id, direction, amount, reason, notes, userId: req.user.id })
    res.status(201).json(movementsOf(db, till.id).find((m) => m.id === id))
  })

  // Body: { notes?: {...}, counted_cash?, note? }
  r.post('/current/close', (req, res) => {
    const { amount, notes } = readCash(req.body, 'counted_cash', getSettings(db), 'Counted cash')
    const closeNote = optString(req.body, 'note')
    const id = transaction(db, () => {
      const till = openTillFor(db, req.user.id)
      if (!till) throw new HttpError(409, 'You have no open till')
      const { expected_cash: expected } = tillTotals(db, till.id)
      db.prepare(
        `UPDATE till_sessions SET status = 'closed', closed_at = ?, expected_cash = ?, counted_cash = ?,
           closing_notes = ?, close_note = ? WHERE id = ?`,
      ).run(nowStamp(db), expected, amount, notes, closeNote, till.id)
      return till.id
    })
    res.json({ ...loadSession(db, id), totals: tillTotals(db, id) })
  })

  // ?date=YYYY-MM-DD (default today) -> { day_close } or { day_close: null }
  r.get('/day-close', (req, res) => {
    const date = req.query.date ? reqDate(req.query, 'date', 'Date') : today()
    res.json({ day_close: loadDayClose(db, date) })
  })

  // Body: { date } (default today)
  r.post('/day-close', requireRole(...SUPERVISORS), (req, res) => {
    const date = req.body.date ? reqDate(req.body, 'date', 'Date') : today()
    transaction(db, () => {
      if (db.prepare('SELECT 1 FROM day_closes WHERE business_date = ?').get(date)) {
        throw new HttpError(409, `${date} is already closed`)
      }
      const open = db
        .prepare(
          `SELECT u.full_name FROM till_sessions t JOIN users u ON u.id = t.user_id
           WHERE t.business_date = ? AND t.status = 'open' ORDER BY t.id`,
        )
        .all(date)
      if (open.length) {
        throw new HttpError(409, `Close every till first (still open: ${open.map((o) => o.full_name).join(', ')})`)
      }
      db.prepare('INSERT INTO day_closes (business_date, summary, user_id) VALUES (?, ?, ?)')
        .run(date, JSON.stringify(daySummary(db, date)), req.user.id)
    })
    res.status(201).json({ day_close: loadDayClose(db, date) })
  })

  // ?date=YYYY-MM-DD (default today). Cashiers see only their own tills.
  r.get('/', (req, res) => {
    const date = req.query.date ? reqDate(req.query, 'date', 'Date') : today()
    const own = !SUPERVISORS.includes(req.user.role)
    const rows = db
      .prepare(
        `SELECT t.*, u.full_name AS user_name FROM till_sessions t JOIN users u ON u.id = t.user_id
         WHERE t.business_date = ? ${own ? 'AND t.user_id = ?' : ''} ORDER BY t.id`,
      )
      .all(...(own ? [date, req.user.id] : [date]))
    res.json(rows.map((s) => ({ ...present(s), totals: tillTotals(db, s.id) })))
  })

  r.get('/:id', (req, res) => {
    const id = Number(req.params.id)
    const s = Number.isInteger(id) && id > 0 ? loadSession(db, id) : null
    if (!s || (!SUPERVISORS.includes(req.user.role) && s.user_id !== req.user.id)) throw notFound('Till session')
    res.json({ session: s, movements: movementsOf(db, id), totals: tillTotals(db, id) })
  })

  return r
}
