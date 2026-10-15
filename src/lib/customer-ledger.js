// Customer credit: bills (opening balance + sales made "on account") against payments.
// A direct mirror of supplier-ledger.js, with "purchases" replaced by account sales (net of any
// returns refunded back to the account) and payment direction reversed (cash comes IN to the till).
import { getSettings, today } from '../db.js'
import { HttpError } from './http.js'
import { tillForCash, recordCashMovement } from './till.js'
import { addDays, daysBetween } from './supplier-ledger.js'

export { addDays, daysBetween }

const openingDate = (c) => c.opening_date || String(c.created_at).slice(0, 10)

async function loadRows(db, customerId) {
  const saleFilter = { payment_method: 'account', ...(customerId ? { customer_id: customerId } : {}) }
  const [saleRows, payments] = await Promise.all([
    db.col('sales').find(saleFilter, { projection: { id: 1, customer_id: 1, invoice_no: 1, total: 1, account_due_date: 1, created_at: 1 } }).toArray(),
    db.col('customer_payments').find(customerId ? { customer_id: customerId } : {}, {
      projection: { id: 1, customer_id: 1, amount: 1, method: 1, reference: 1, paid_on: 1, sale_id: 1, note: 1 },
      sort: { paid_on: 1, id: 1 },
    }).toArray(),
  ])
  const saleIds = saleRows.map((s) => s.id)
  const returnRows = saleIds.length
    ? await db.col('returns').find({ sale_id: { $in: saleIds }, refund_method: 'account' }, { projection: { sale_id: 1, refund_total: 1 } }).toArray()
    : []
  const returnedBySale = new Map()
  for (const r of returnRows) returnedBySale.set(r.sale_id, (returnedBySale.get(r.sale_id) || 0) + r.refund_total)
  const sales = saleRows.map((s) => {
    const date = String(s.created_at).slice(0, 10)
    return { ...s, date, due_date: s.account_due_date || date, total: s.total - (returnedBySale.get(s.id) || 0) }
  }).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id))
  return { sales, payments }
}

function group(rows, key) {
  const m = new Map()
  for (const r of rows) {
    if (!m.has(r[key])) m.set(r[key], [])
    m.get(r[key]).push(r)
  }
  return m
}

// Settles one customer's bills: payments tied to a sale go to that sale first, everything else
// settles the oldest bills first. Returns ageing as of `asOf`.
function dues(customer, sales, payments, asOf, openingDue = 'terms') {
  const bills = []
  if (customer.opening_balance > 0) {
    const d = openingDate(customer)
    const due = openingDue === 'immediate' ? d : addDays(d, customer.due_days || 0)
    bills.push({ key: 'opening', date: d, due_date: due, amount: customer.opening_balance, left: customer.opening_balance })
  }
  for (const s of sales) {
    if (s.total > 0) bills.push({ key: s.id, date: s.date, due_date: s.due_date, amount: s.total, left: s.total })
  }
  bills.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.key === 'opening' ? -1 : b.key === 'opening' ? 1 : a.key - b.key))

  let pool = 0
  for (const pay of payments) {
    let amount = pay.amount
    const bill = pay.sale_id ? bills.find((b) => b.key === pay.sale_id) : null
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
    customer_id: customer.id, name: customer.name, due_days: customer.due_days,
    balance: 0, not_due: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0, overdue: 0, oldest_unpaid_date: null,
  }
  const billed = bills.reduce((s, b) => s + b.amount, 0)
  const paid = payments.reduce((s, p) => s + p.amount, 0)
  out.balance = billed - paid // negative = the customer has a credit balance
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

// Dues for every customer (or one), keyed by customer id.
export async function customerDues(db, { customerId = null, asOf = today() } = {}) {
  const [customers, { sales, payments }] = await Promise.all([
    db.col('customers').find(customerId ? { _id: Number(customerId) } : {}, { sort: { name: 1 } }).toArray(),
    loadRows(db, customerId ? Number(customerId) : null),
  ])
  const byS = group(sales, 'customer_id')
  const byPay = group(payments, 'customer_id')
  const result = new Map()
  const openingDue = (await getSettings(db)).opening_balance_due
  for (const c of customers) result.set(c.id, dues(c, byS.get(c.id) || [], byPay.get(c.id) || [], asOf, openingDue))
  return result
}

const KIND_ORDER = { opening: 0, sale: 1, payment: 2 }
const METHOD_LABEL = { cash: 'Cash', bank: 'Bank transfer', cheque: 'Cheque', till: 'Cash at till' }

// Statement with running balance (debit = billed, credit = paid, balance = owed).
export async function customerLedger(db, customer, { from = null, to = null } = {}) {
  const { sales, payments } = await loadRows(db, customer.id)
  const all = []
  if (customer.opening_balance > 0) {
    all.push({ date: openingDate(customer), type: 'opening', ref: null, description: 'Opening balance',
      debit: customer.opening_balance, credit: 0, id: 0 })
  }
  for (const s of sales) {
    all.push({ date: s.date, type: 'sale', ref: s.invoice_no, sale_id: s.id, due_date: s.due_date,
      description: `Sale on account (${s.invoice_no})`, debit: s.total, credit: 0, id: s.id })
  }
  for (const pay of payments) {
    const parts = [METHOD_LABEL[pay.method] || pay.method, pay.reference, pay.note].filter(Boolean)
    all.push({ date: pay.paid_on, type: 'payment', ref: pay.reference || null, payment_id: pay.id, sale_id: pay.sale_id,
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

// For method 'till': the receiving user's open till, required even when the pharmacy does not
// require tills for sales (cash cannot enter a drawer that is not open).
export async function tillForCustomerPayment(db, userId) {
  const till = await tillForCash(db, userId, await getSettings(db), 'take a payment from a customer')
  if (!till) throw new HttpError(409, 'Open your till before you take a payment from a customer')
  return till
}

// Inserts a customer payment (call inside a transaction). A 'till' payment also puts the cash
// into the till given (from tillForCustomerPayment).
export async function recordCustomerPayment(db, { customer, amount, method, reference = null, paidOn, saleId = null, note = null, userId, till = null }) {
  const id = await db.insert('customer_payments', {
    customer_id: customer.id, amount, method, reference, paid_on: paidOn, sale_id: saleId,
    till_session_id: method === 'till' ? till.id : null, note, user_id: userId,
  })
  if (method === 'till') {
    await recordCashMovement(db, { tillSessionId: till.id, direction: 'in', amount, reason: `Payment from ${customer.name}`,
      customerPaymentId: id, userId })
  }
  return id
}
