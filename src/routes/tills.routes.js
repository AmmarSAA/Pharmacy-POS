import { Router } from '../lib/router.js'
import { requireRole } from '../auth.js'
import { today, nowStamp, getSettings } from '../db.js'
import { HttpError, badRequest, notFound, reqInt, reqString, optString, reqDate, oneOf } from '../lib/http.js'
import { openTillFor, tillTotals, recordCashMovement } from '../lib/till.js'

// Till sessions, cash in/out and day close. See docs/API-CONTRACT.md.

const SUPERVISORS = ['admin', 'pharmacist']
const MAX_CASH = 1e12

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

async function loadSession(db, id) {
  const s = await db.get('till_sessions', id)
  if (!s) return null
  await db.join([s], [{ key: 'user_id', from: 'users', fields: { user_name: 'full_name' } }])
  return present(s)
}

async function movementsOf(db, sessionId) {
  const rows = await db.all('cash_movements', { till_session_id: sessionId }, { sort: { id: 1 } })
  await db.join(rows, [{ key: 'user_id', from: 'users', fields: { user_name: 'full_name' } }])
  return rows.map((m) => ({ ...m, notes: parseJson(m.notes) }))
}

const TOTAL_KEYS = ['opening_cash', 'cash_sales', 'card_sales', 'wallet_sales', 'invoices', 'refunds', 'cash_in', 'cash_out',
  'expected_cash']

const dayFilter = (date) => ({ created_at: { $gte: date, $lt: `${date}~` } })

async function daySummary(db, date) {
  const sessions = await db.all('till_sessions', { business_date: date }, { sort: { id: 1 } })
  await db.join(sessions, [{ key: 'user_id', from: 'users', fields: { user_name: 'full_name' } }])
  const tills = []
  for (const s of sessions) {
    tills.push({
      id: s.id, user_id: s.user_id, user_name: s.user_name, opened_at: s.opened_at, closed_at: s.closed_at,
      expected_cash: s.expected_cash, counted_cash: s.counted_cash, variance: varianceOf(s),
      totals: await tillTotals(db, s.id),
    })
  }
  const sum = (fn) => tills.reduce((acc, t) => acc + (fn(t) || 0), 0)
  const totals = Object.fromEntries(TOTAL_KEYS.map((k) => [k, sum((t) => t.totals[k])]))
  totals.counted_cash = sum((t) => t.counted_cash)
  totals.variance = sum((t) => t.variance)
  const sales = { count: await db.col('sales').countDocuments(dayFilter(date)), total: await db.sum('sales', dayFilter(date), 'total') }
  const returns = { count: await db.col('returns').countDocuments(dayFilter(date)), total: await db.sum('returns', dayFilter(date), 'refund_total') }
  return { date, tills, totals, sales, returns, net_sales: sales.total - returns.total }
}

async function loadDayClose(db, date) {
  const row = await db.col('day_closes').findOne({ business_date: date })
  if (!row) return null
  await db.join([row], [{ key: 'user_id', from: 'users', fields: { user_name: 'full_name' } }])
  return { ...row, summary: parseJson(row.summary) }
}

export default function tillRoutes(db) {
  const r = Router()

  // The signed-in user's open till.
  r.get('/current', async (req, res) => {
    const till = await openTillFor(db, req.user.id)
    if (!till) return res.json({ session: null })
    res.json({ session: await loadSession(db, till.id), totals: await tillTotals(db, till.id), movements: await movementsOf(db, till.id) })
  })

  // Body: { notes?: { "5000": 2, ... }, opening_cash? }
  r.post('/open', async (req, res) => {
    const { amount, notes } = readCash(req.body, 'opening_cash', await getSettings(db), 'Opening cash')
    const id = await db.tx(async () => {
      if (await openTillFor(db, req.user.id)) throw new HttpError(409, 'You already have an open till')
      const id = await db.nextId('till_sessions')
      await db.col('till_sessions').insertOne({
        _id: id, id, user_id: req.user.id, business_date: today(), opening_cash: amount, opening_notes: notes,
        opened_at: nowStamp(), closed_at: null, expected_cash: null, counted_cash: null, closing_notes: null, close_note: null,
        status: 'open',
      })
      return id
    })
    res.status(201).json(await loadSession(db, id))
  })

  // Body: { direction: 'in'|'out', amount, reason, notes? }
  r.post('/current/movements', async (req, res) => {
    const direction = oneOf(req.body.direction, ['in', 'out'], 'Direction')
    const amount = reqInt(req.body, 'amount', { min: 1, max: MAX_CASH, label: 'Amount' })
    const reason = reqString(req.body, 'reason', 'Reason')
    const notes = req.body.notes === undefined || req.body.notes === null
      ? null
      : JSON.stringify(readNotes(req.body.notes, await getSettings(db)).notes)
    const till = await openTillFor(db, req.user.id)
    if (!till) throw new HttpError(409, 'Open your till before you move cash')
    const id = await recordCashMovement(db, { tillSessionId: till.id, direction, amount, reason, notes, userId: req.user.id })
    res.status(201).json((await movementsOf(db, till.id)).find((m) => m.id === id))
  })

  // Body: { notes?: {...}, counted_cash?, note? }
  r.post('/current/close', async (req, res) => {
    const { amount, notes } = readCash(req.body, 'counted_cash', await getSettings(db), 'Counted cash')
    const closeNote = optString(req.body, 'note')
    const id = await db.tx(async () => {
      const till = await openTillFor(db, req.user.id)
      if (!till) throw new HttpError(409, 'You have no open till')
      const { expected_cash: expected } = await tillTotals(db, till.id)
      await db.col('till_sessions').updateOne({ _id: till.id }, { $set: {
        status: 'closed', closed_at: nowStamp(), expected_cash: expected, counted_cash: amount, closing_notes: notes, close_note: closeNote,
      } })
      return till.id
    })
    res.json({ ...(await loadSession(db, id)), totals: await tillTotals(db, id) })
  })

  // ?date=YYYY-MM-DD (default today) -> { day_close } or { day_close: null }
  r.get('/day-close', async (req, res) => {
    const date = req.query.date ? reqDate(req.query, 'date', 'Date') : today()
    res.json({ day_close: await loadDayClose(db, date) })
  })

  // Body: { date } (default today)
  r.post('/day-close', requireRole(...SUPERVISORS), async (req, res) => {
    const date = req.body.date ? reqDate(req.body, 'date', 'Date') : today()
    await db.tx(async () => {
      if (await db.col('day_closes').findOne({ business_date: date })) {
        throw new HttpError(409, `${date} is already closed`)
      }
      const open = await db.all('till_sessions', { business_date: date, status: 'open' }, { sort: { id: 1 } })
      await db.join(open, [{ key: 'user_id', from: 'users', fields: { full_name: 'full_name' } }])
      if (open.length) {
        throw new HttpError(409, `Close every till first (still open: ${open.map((o) => o.full_name).join(', ')})`)
      }
      await db.insert('day_closes', { business_date: date, summary: JSON.stringify(await daySummary(db, date)), user_id: req.user.id })
    })
    res.status(201).json({ day_close: await loadDayClose(db, date) })
  })

  // ?date=YYYY-MM-DD (default today). Cashiers see only their own tills.
  r.get('/', async (req, res) => {
    const date = req.query.date ? reqDate(req.query, 'date', 'Date') : today()
    const own = !SUPERVISORS.includes(req.user.role)
    const rows = await db.all('till_sessions', { business_date: date, ...(own && { user_id: req.user.id }) }, { sort: { id: 1 } })
    await db.join(rows, [{ key: 'user_id', from: 'users', fields: { user_name: 'full_name' } }])
    const out = []
    for (const s of rows) out.push({ ...present(s), totals: await tillTotals(db, s.id) })
    res.json(out)
  })

  r.get('/:id', async (req, res) => {
    const id = Number(req.params.id)
    const s = Number.isInteger(id) && id > 0 ? await loadSession(db, id) : null
    if (!s || (!SUPERVISORS.includes(req.user.role) && s.user_id !== req.user.id)) throw notFound('Till session')
    res.json({ session: s, movements: await movementsOf(db, id), totals: await tillTotals(db, id) })
  })

  return r
}
