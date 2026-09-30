import { Router } from 'express'
import { requireRole } from '../auth.js'
import { transaction, today } from '../db.js'
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

  const getSupplier = (id) => {
    const s = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(Number(id))
    if (!s) throw notFound('Supplier')
    return s
  }
  const withOwnDues = (s) => withDues(s, supplierDues(db, { supplierId: s.id }).get(s.id))

  // ?active=1 hides inactive suppliers.
  r.get('/', (req, res) => {
    const dues = supplierDues(db)
    let rows = db.prepare('SELECT * FROM suppliers ORDER BY name').all()
    if (req.query.active === '1') rows = rows.filter((s) => s.active)
    res.json(rows.map((s) => withDues(s, dues.get(s.id))))
  })

  r.post('/', (req, res) => {
    const { lastInsertRowid } = db
      .prepare(`INSERT INTO suppliers (${FIELDS.join(', ')}) VALUES (${FIELDS.map((f) => `:${f}`).join(', ')})`)
      .run(read(req.body))
    res.status(201).json(withOwnDues(getSupplier(lastInsertRowid)))
  })

  // Payments across suppliers: ?from=&to= (paid_on), optional ?supplier_id=.
  r.get('/payments', (req, res) => {
    const where = []
    const p = {}
    const from = optDate(req.query, 'from', 'From date')
    const to = optDate(req.query, 'to', 'To date')
    if (from) { where.push('sp.paid_on >= :from'); p.from = from }
    if (to) { where.push('sp.paid_on <= :to'); p.to = to }
    if (req.query.supplier_id) { where.push('sp.supplier_id = :sid'); p.sid = Number(req.query.supplier_id) }
    res.json(
      db.prepare(
        `SELECT sp.*, s.name AS supplier_name, u.full_name AS paid_by, pu.invoice_no AS purchase_invoice_no
         FROM supplier_payments sp JOIN suppliers s ON s.id = sp.supplier_id JOIN users u ON u.id = sp.user_id
         LEFT JOIN purchases pu ON pu.id = sp.purchase_id
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY sp.paid_on DESC, sp.id DESC LIMIT 1000`,
      ).all(...(where.length ? [p] : [])),
    )
  })

  r.get('/:id', (req, res) => {
    res.json(withOwnDues(getSupplier(req.params.id)))
  })

  // Fields left out of the body keep their current value.
  r.put('/:id', (req, res) => {
    const existing = getSupplier(req.params.id)
    const merged = {}
    for (const f of FIELDS) merged[f] = req.body?.[f] !== undefined ? req.body[f] : existing[f]
    db.prepare(`UPDATE suppliers SET ${FIELDS.map((f) => `${f} = :${f}`).join(', ')} WHERE id = :id`)
      .run({ ...read(merged), id: existing.id })
    res.json(withOwnDues(getSupplier(existing.id)))
  })

  r.get('/:id/ledger', (req, res) => {
    const s = getSupplier(req.params.id)
    const from = optDate(req.query, 'from', 'From date')
    const to = optDate(req.query, 'to', 'To date')
    const { entries, balance } = supplierLedger(db, s, { from, to })
    res.json({ supplier: withOwnDues(s), entries, balance })
  })

  r.post('/:id/payments', (req, res) => {
    const supplier = getSupplier(req.params.id)
    const b = req.body || {}
    const amount = reqInt(b, 'amount', { label: 'Amount' })
    if (amount <= 0) throw badRequest('Amount must be more than 0')
    const method = oneOf(b.method || 'cash', PAYMENT_METHODS, 'Payment method')
    const purchaseId = optInt(b, 'purchase_id', null, { min: 1, label: 'Purchase' })
    if (purchaseId && !db.prepare('SELECT 1 FROM purchases WHERE id = ? AND supplier_id = ?').get(purchaseId, supplier.id)) {
      throw badRequest('Purchase not found for this supplier')
    }
    const payment = {
      supplier, amount, method, purchaseId,
      reference: optString(b, 'reference'),
      paidOn: optDate(b, 'paid_on', 'Payment date') || today(),
      note: optString(b, 'note'),
      userId: req.user.id,
      till: method === 'till' ? tillForSupplierPayment(db, req.user.id) : null,
    }
    const id = transaction(db, () => recordSupplierPayment(db, payment))
    res.status(201).json(
      db.prepare(
        'SELECT sp.*, s.name AS supplier_name FROM supplier_payments sp JOIN suppliers s ON s.id = sp.supplier_id WHERE sp.id = ?',
      ).get(id),
    )
  })

  return r
}
