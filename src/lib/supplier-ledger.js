import { today, getSettings } from '../db.js'
import { HttpError } from './http.js'
import { tillForCash, recordCashMovement } from './till.js'

// Supplier credit: bills (opening balance + purchases) against payments.
// Dates are 'YYYY-MM-DD'; date math is done in UTC so the server time zone cannot shift a day.

const toUtc = (date) => Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)))

export function addDays(date, days) {
  return new Date(toUtc(date) + days * 864e5).toISOString().slice(0, 10)
}

// Whole days from `from` to `to` (positive when `to` is later).
export function daysBetween(from, to) {
  return Math.round((toUtc(to) - toUtc(from)) / 864e5)
}

// Opening balance counts as a bill dated opening_date (or the supplier's created date). It falls due
// after the supplier's credit days, or at once when the owner sets opening_balance_due = 'immediate'.
const openingDate = (s) => s.opening_date || String(s.created_at).slice(0, 10)

async function loadRows(db, supplierId) {
  const filter = supplierId ? { supplier_id: supplierId } : {}
  const purchases = (await db.col('purchases').find(filter, {
    projection: { id: 1, supplier_id: 1, invoice_no: 1, payment_type: 1, total: 1, notes: 1, invoice_date: 1, due_date: 1, created_at: 1 },
  }).toArray()).map((p) => {
    const date = p.invoice_date || String(p.created_at).slice(0, 10)
    return { ...p, date, due_date: p.due_date || date }
  }).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id))
  const payments = await db.col('supplier_payments').find(filter, {
    projection: { id: 1, supplier_id: 1, amount: 1, method: 1, reference: 1, paid_on: 1, purchase_id: 1, note: 1 },
    sort: { paid_on: 1, id: 1 },
  }).toArray()
  return { purchases, payments }
}

function group(rows) {
  const m = new Map()
  for (const r of rows) {
    if (!m.has(r.supplier_id)) m.set(r.supplier_id, [])
    m.get(r.supplier_id).push(r)
  }
  return m
}

// Settles one supplier's bills: payments tied to a purchase go to that purchase first,
// everything else settles the oldest bills first. Returns ageing as of `asOf`.
function dues(supplier, purchases, payments, asOf, openingDue = 'terms') {
  const bills = []
  if (supplier.opening_balance > 0) {
    const d = openingDate(supplier)
    const due = openingDue === 'immediate' ? d : addDays(d, supplier.due_days || 0)
    bills.push({ key: 'opening', date: d, due_date: due, amount: supplier.opening_balance, left: supplier.opening_balance })
  }
  for (const p of purchases) {
    if (p.total > 0) bills.push({ key: p.id, date: p.date, due_date: p.due_date, amount: p.total, left: p.total })
  }
  // Opening balance first on the same date, then by bill date and id.
  bills.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.key === 'opening' ? -1 : b.key === 'opening' ? 1 : a.key - b.key))

  let pool = 0
  for (const pay of payments) {
    let amount = pay.amount
    const bill = pay.purchase_id ? bills.find((b) => b.key === pay.purchase_id) : null
    if (bill) {
      const take = Math.min(bill.left, amount)
      bill.left -= take
      amount -= take
    }
    pool += amount
  }
  for (const b of bills) {
    if (pool === 0) break
    const take = Math.min(b.left, pool)
    b.left -= take
    pool -= take
  }

  const out = {
    supplier_id: supplier.id, name: supplier.name, due_days: supplier.due_days,
    balance: 0, not_due: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0, overdue: 0, oldest_unpaid_date: null,
  }
  const billed = bills.reduce((s, b) => s + b.amount, 0)
  const paid = payments.reduce((s, p) => s + p.amount, 0)
  out.balance = billed - paid // negative = advance paid to the supplier
  for (const b of bills) {
    if (b.left <= 0) continue
    if (!out.oldest_unpaid_date) out.oldest_unpaid_date = b.date
    const late = daysBetween(b.due_date, asOf)
    if (late <= 0) out.not_due += b.left
    else if (late <= 30) out.d1_30 += b.left
    else if (late <= 60) out.d31_60 += b.left
    else if (late <= 90) out.d61_90 += b.left
    else out.d90_plus += b.left
    if (late > 0) out.overdue += b.left
  }
  return out
}

// Dues for every supplier (or one), keyed by supplier id.
export async function supplierDues(db, { supplierId = null, asOf = today() } = {}) {
  const suppliers = await db.col('suppliers').find(supplierId ? { _id: Number(supplierId) } : {}, { sort: { name: 1 } }).toArray()
  const { purchases, payments } = await loadRows(db, supplierId ? Number(supplierId) : null)
  const byP = group(purchases)
  const byPay = group(payments)
  const result = new Map()
  const openingDue = (await getSettings(db)).opening_balance_due
  for (const s of suppliers) result.set(s.id, dues(s, byP.get(s.id) || [], byPay.get(s.id) || [], asOf, openingDue))
  return result
}

const KIND_ORDER = { opening: 0, purchase: 1, payment: 2 }
const METHOD_LABEL = { cash: 'Cash', bank: 'Bank transfer', cheque: 'Cheque', till: 'Cash from till' }

// Statement with running balance (debit = billed, credit = paid, balance = owed).
// Entries before `from` are carried in as one "balance brought forward" line.
export async function supplierLedger(db, supplier, { from = null, to = null } = {}) {
  const { purchases, payments } = await loadRows(db, supplier.id)
  const all = []
  if (supplier.opening_balance > 0) {
    all.push({ date: openingDate(supplier), type: 'opening', ref: null, description: 'Opening balance',
      debit: supplier.opening_balance, credit: 0, id: 0 })
  }
  for (const p of purchases) {
    const desc = p.payment_type === 'cash' ? 'Cash purchase' : 'Credit purchase'
    all.push({ date: p.date, type: 'purchase', ref: p.invoice_no || `#${p.id}`, purchase_id: p.id, due_date: p.due_date,
      description: p.notes ? `${desc} - ${p.notes}` : desc, debit: p.total, credit: 0, id: p.id })
  }
  for (const pay of payments) {
    const parts = [METHOD_LABEL[pay.method] || pay.method, pay.reference, pay.note].filter(Boolean)
    all.push({ date: pay.paid_on, type: 'payment', ref: pay.reference || null, payment_id: pay.id, purchase_id: pay.purchase_id,
      description: `Payment (${parts.join(', ')})`, debit: 0, credit: pay.amount, id: pay.id })
  }
  all.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : KIND_ORDER[a.type] - KIND_ORDER[b.type] || a.id - b.id))

  const entries = []
  let balance = 0
  if (from) {
    const bf = all.filter((e) => e.date < from).reduce((s, e) => s + e.debit - e.credit, 0)
    balance = bf
    entries.push({ date: from, type: 'opening', ref: null, description: 'Balance brought forward',
      debit: Math.max(bf, 0), credit: Math.max(-bf, 0), balance: bf })
  }
  for (const e of all) {
    if (from && e.date < from) continue
    if (to && e.date > to) continue
    balance += e.debit - e.credit
    const { id, ...rest } = e
    entries.push({ ...rest, balance })
  }
  return { entries, balance }
}

// For method 'till': the paying user's open till, required even when the pharmacy does not
// require tills for sales (cash cannot leave a drawer that is not open).
export async function tillForSupplierPayment(db, userId) {
  const till = await tillForCash(db, userId, await getSettings(db), 'pay a supplier from the till')
  if (!till) throw new HttpError(409, 'Open your till before you pay a supplier from the till')
  return till
}

// Inserts a supplier payment (call inside a transaction). A 'till' payment also takes the cash
// out of the till given (from tillForSupplierPayment).
export async function recordSupplierPayment(db, { supplier, amount, method, reference = null, paidOn, purchaseId = null, note = null, userId, till = null }) {
  const id = await db.insert('supplier_payments', {
    supplier_id: supplier.id, amount, method, reference, paid_on: paidOn, purchase_id: purchaseId,
    till_session_id: method === 'till' ? till.id : null, note, user_id: userId,
  })
  if (method === 'till') {
    await recordCashMovement(db, { tillSessionId: till.id, direction: 'out', amount, reason: `Payment to ${supplier.name}`,
      supplierPaymentId: id, userId })
  }
  return id
}
