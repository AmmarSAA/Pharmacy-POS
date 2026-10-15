import { Router } from '../lib/router.js'
import { requirePermission } from '../auth.js'
import { today } from '../db.js'
import { badRequest, notFound, reqString, optString, reqInt, optInt, optDate, oneOf } from '../lib/http.js'
import { customerDues, customerLedger, tillForCustomerPayment, recordCustomerPayment } from '../lib/customer-ledger.js'

export const PAYMENT_METHODS = ['cash', 'bank', 'cheque', 'till']

const FIELDS = ['name', 'phone', 'address', 'cnic', 'due_days', 'opening_balance', 'opening_date', 'active']

const flag = (v) => (v === undefined || v === null || v === '' ? 1 : v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0)

const read = (b) => {
  const openingBalance = optInt(b, 'opening_balance', 0, { label: 'Opening balance' })
  if (openingBalance < 0) throw badRequest('Opening balance cannot be negative')
  return {
    name: reqString(b, 'name', 'Name'),
    phone: optString(b, 'phone'),
    address: optString(b, 'address'),
    cnic: optString(b, 'cnic'),
    due_days: optInt(b, 'due_days', 0, { min: 0, max: 365, label: 'Due days' }),
    opening_balance: openingBalance,
    opening_date: optDate(b, 'opening_date', 'Opening date'),
    active: flag(b?.active),
  }
}

const withDues = (c, d) => ({ ...c, balance: d?.balance ?? 0, overdue: d?.overdue ?? 0 })

export default function customerRoutes(db) {
  const r = Router()
  r.use(requirePermission('customers.manage'))

  const getCustomer = async (id) => {
    const c = await db.get('customers', Number(id))
    if (!c) throw notFound('Customer')
    return c
  }
  const withOwnDues = async (c) => withDues(c, (await customerDues(db, { customerId: c.id })).get(c.id))

  // ?active=1 hides inactive customers. ?q= searches name/phone.
  r.get('/', async (req, res) => {
    const dues = await customerDues(db)
    let rows = await db.all('customers', {}, { sort: { name: 1 } })
    if (req.query.active === '1') rows = rows.filter((c) => c.active)
    if (req.query.q) {
      const q = String(req.query.q).trim().toLowerCase()
      rows = rows.filter((c) => c.name.toLowerCase().includes(q) || String(c.phone || '').includes(q))
    }
    res.json(rows.map((c) => withDues(c, dues.get(c.id))))
  })

  r.post('/', async (req, res) => {
    const id = await db.insert('customers', { ...read(req.body), loyalty_points: 0 })
    res.status(201).json(await withOwnDues(await getCustomer(id)))
  })

  // Payments across customers: ?from=&to= (paid_on), optional ?customer_id=.
  r.get('/payments', async (req, res) => {
    const filter = {}
    const from = optDate(req.query, 'from', 'From date')
    const to = optDate(req.query, 'to', 'To date')
    if (from || to) filter.paid_on = { ...(from && { $gte: from }), ...(to && { $lte: to }) }
    if (req.query.customer_id) filter.customer_id = Number(req.query.customer_id)
    const rows = await db.all('customer_payments', filter, { sort: { paid_on: -1, id: -1 }, limit: 1000 })
    res.json(await db.join(rows, [
      { key: 'customer_id', from: 'customers', fields: { customer_name: 'name' } },
      { key: 'user_id', from: 'users', fields: { received_by: 'full_name' } },
      { key: 'sale_id', from: 'sales', fields: { sale_invoice_no: 'invoice_no' } },
    ]))
  })

  r.get('/:id', async (req, res) => {
    res.json(await withOwnDues(await getCustomer(req.params.id)))
  })

  // Fields left out of the body keep their current value.
  r.put('/:id', async (req, res) => {
    const existing = await getCustomer(req.params.id)
    const merged = {}
    for (const f of FIELDS) merged[f] = req.body?.[f] !== undefined ? req.body[f] : existing[f]
    await db.col('customers').updateOne({ _id: existing.id }, { $set: read(merged) })
    res.json(await withOwnDues(await getCustomer(existing.id)))
  })

  r.get('/:id/ledger', async (req, res) => {
    const c = await getCustomer(req.params.id)
    const from = optDate(req.query, 'from', 'From date')
    const to = optDate(req.query, 'to', 'To date')
    const { entries, balance } = await customerLedger(db, c, { from, to })
    res.json({ customer: await withOwnDues(c), entries, balance })
  })

  r.post('/:id/payments', async (req, res) => {
    const customer = await getCustomer(req.params.id)
    const b = req.body || {}
    const amount = reqInt(b, 'amount', { label: 'Amount' })
    if (amount <= 0) throw badRequest('Amount must be more than 0')
    const method = oneOf(b.method || 'cash', PAYMENT_METHODS, 'Payment method')
    const saleId = optInt(b, 'sale_id', null, { min: 1, label: 'Sale' })
    if (saleId && !(await db.col('sales').findOne({ _id: saleId, customer_id: customer.id }))) {
      throw badRequest('Sale not found for this customer')
    }
    const payment = {
      customer, amount, method, saleId,
      reference: optString(b, 'reference'),
      paidOn: optDate(b, 'paid_on', 'Payment date') || today(),
      note: optString(b, 'note'),
      userId: req.user.id,
      till: method === 'till' ? await tillForCustomerPayment(db, req.user.id) : null,
    }
    const id = await db.tx(() => recordCustomerPayment(db, payment))
    const row = await db.get('customer_payments', id)
    row.customer_name = customer.name
    res.status(201).json(row)
  })

  return r
}
