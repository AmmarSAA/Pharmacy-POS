import { Router } from '../lib/router.js'
import { requireRole } from '../auth.js'
import { today } from '../db.js'
import { badRequest, notFound, reqString, optString, reqInt, optInt, optDate, oneOf } from '../lib/http.js'
import { supplierDues, supplierLedger, tillForSupplierPayment, recordSupplierPayment } from '../lib/supplier-ledger.js'

export const PAYMENT_METHODS = ['cash', 'bank', 'cheque', 'till']

const FIELDS = ['name', 'phone', 'address', 'ntn', 'drug_license_no', 'due_days', 'opening_balance', 'opening_date',
  'contact_person', 'email', 'active']

const flag = (v) => (v === undefined || v === null || v === '' ? 1 : v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0)

const read = (b) => {
  const email = optString(b, 'email')
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badRequest('Email is not valid')
  const openingBalance = optInt(b, 'opening_balance', 0, { label: 'Opening balance' })
  if (openingBalance < 0) throw badRequest('Opening balance cannot be negative')
  return {
    name: reqString(b, 'name', 'Name'),
    phone: optString(b, 'phone'),
    address: optString(b, 'address'),
    ntn: optString(b, 'ntn'),
    drug_license_no: optString(b, 'drug_license_no'),
    due_days: optInt(b, 'due_days', 0, { min: 0, max: 365, label: 'Due days' }),
    opening_balance: openingBalance,
    opening_date: optDate(b, 'opening_date', 'Opening date'),
    contact_person: optString(b, 'contact_person'),
    email,
    active: flag(b?.active),
  }
}

const withDues = (s, d) => ({ ...s, balance: d?.balance ?? 0, overdue: d?.overdue ?? 0 })

export default function supplierRoutes(db) {
  const r = Router()
  r.use(requireRole('admin', 'pharmacist'))

  const getSupplier = async (id) => {
    const s = await db.get('suppliers', Number(id))
    if (!s) throw notFound('Supplier')
    return s
  }
  const withOwnDues = async (s) => withDues(s, (await supplierDues(db, { supplierId: s.id })).get(s.id))

  // ?active=1 hides inactive suppliers.
  r.get('/', async (req, res) => {
    const dues = await supplierDues(db)
    let rows = await db.all('suppliers', {}, { sort: { name: 1 } })
    if (req.query.active === '1') rows = rows.filter((s) => s.active)
    res.json(rows.map((s) => withDues(s, dues.get(s.id))))
  })

  r.post('/', async (req, res) => {
    const id = await db.insert('suppliers', read(req.body))
    res.status(201).json(await withOwnDues(await getSupplier(id)))
  })

  // Payments across suppliers: ?from=&to= (paid_on), optional ?supplier_id=.
  r.get('/payments', async (req, res) => {
    const filter = {}
    const from = optDate(req.query, 'from', 'From date')
    const to = optDate(req.query, 'to', 'To date')
    if (from || to) filter.paid_on = { ...(from && { $gte: from }), ...(to && { $lte: to }) }
    if (req.query.supplier_id) filter.supplier_id = Number(req.query.supplier_id)
    const rows = await db.all('supplier_payments', filter, { sort: { paid_on: -1, id: -1 }, limit: 1000 })
    res.json(await db.join(rows, [
      { key: 'supplier_id', from: 'suppliers', fields: { supplier_name: 'name' } },
      { key: 'user_id', from: 'users', fields: { paid_by: 'full_name' } },
      { key: 'purchase_id', from: 'purchases', fields: { purchase_invoice_no: 'invoice_no' } },
    ]))
  })

  r.get('/:id', async (req, res) => {
    res.json(await withOwnDues(await getSupplier(req.params.id)))
  })

  // Fields left out of the body keep their current value.
  r.put('/:id', async (req, res) => {
    const existing = await getSupplier(req.params.id)
    const merged = {}
    for (const f of FIELDS) merged[f] = req.body?.[f] !== undefined ? req.body[f] : existing[f]
    await db.col('suppliers').updateOne({ _id: existing.id }, { $set: read(merged) })
    res.json(await withOwnDues(await getSupplier(existing.id)))
  })

  r.get('/:id/ledger', async (req, res) => {
    const s = await getSupplier(req.params.id)
    const from = optDate(req.query, 'from', 'From date')
    const to = optDate(req.query, 'to', 'To date')
    const { entries, balance } = await supplierLedger(db, s, { from, to })
    res.json({ supplier: await withOwnDues(s), entries, balance })
  })

  r.post('/:id/payments', async (req, res) => {
    const supplier = await getSupplier(req.params.id)
    const b = req.body || {}
    const amount = reqInt(b, 'amount', { label: 'Amount' })
    if (amount <= 0) throw badRequest('Amount must be more than 0')
    const method = oneOf(b.method || 'cash', PAYMENT_METHODS, 'Payment method')
    const purchaseId = optInt(b, 'purchase_id', null, { min: 1, label: 'Purchase' })
    if (purchaseId && !(await db.col('purchases').findOne({ _id: purchaseId, supplier_id: supplier.id }))) {
      throw badRequest('Purchase not found for this supplier')
    }
    const payment = {
      supplier, amount, method, purchaseId,
      reference: optString(b, 'reference'),
      paidOn: optDate(b, 'paid_on', 'Payment date') || today(),
      note: optString(b, 'note'),
      userId: req.user.id,
      till: method === 'till' ? await tillForSupplierPayment(db, req.user.id) : null,
    }
    const id = await db.tx(() => recordSupplierPayment(db, payment))
    const row = await db.get('supplier_payments', id)
    row.supplier_name = supplier.name
    res.status(201).json(row)
  })

  return r
}
