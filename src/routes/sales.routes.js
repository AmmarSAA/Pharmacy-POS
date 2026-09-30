import { Router } from 'express'
import { requireRole } from '../auth.js'
import { transaction, today, getSettings } from '../db.js'
import { HttpError, badRequest, notFound, reqInt, optInt, reqString, optString, optDate, oneOf } from '../lib/http.js'
import { allocateFefo, moveStock } from '../lib/stock.js'
import { percentOf, inclusiveTax, roundToRupee, packAmount } from '../lib/money.js'
import { tillForCash } from '../lib/till.js'

const PAYMENT_METHODS = ['cash', 'card', 'wallet']
const MAX_DISCOUNT_BPS = { cashier: 1000, pharmacist: 2500, admin: 10000 }

function readPrescription(body, needsControlled) {
  const rx = body.prescription
  if (!rx || typeof rx !== 'object') throw badRequest('Prescription details are required for prescription medicines')
  const out = {
    patient_name: reqString(rx, 'patient_name', 'Patient name'),
    patient_phone: optString(rx, 'patient_phone'),
    patient_cnic: optString(rx, 'patient_cnic'),
    prescriber_name: reqString(rx, 'prescriber_name', 'Prescriber name'),
    prescriber_reg_no: optString(rx, 'prescriber_reg_no'),
    rx_date: optDate(rx, 'rx_date', 'Prescription date'),
    notes: optString(rx, 'notes'),
  }
  if (needsControlled) {
    if (!out.patient_cnic) throw badRequest('Patient CNIC is required for controlled drugs')
    if (!out.prescriber_reg_no) throw badRequest('Prescriber PMDC number is required for controlled drugs')
  }
  return out
}

export function loadSale(db, id) {
  const sale = db
    .prepare(
      `SELECT s.*, u.full_name AS cashier_name FROM sales s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
    )
    .get(id)
  if (!sale) return null
  sale.items = db
    .prepare(
      `SELECT si.*, p.name AS product_name, p.strength, p.form, p.schedule, b.batch_no, b.expiry_date
       FROM sale_items si JOIN products p ON p.id = si.product_id JOIN batches b ON b.id = si.batch_id
       WHERE si.sale_id = ? ORDER BY si.id`,
    )
    .all(id)
  sale.prescription = sale.prescription_id
    ? db.prepare('SELECT * FROM prescriptions WHERE id = ?').get(sale.prescription_id)
    : null
  sale.returns = db
    .prepare('SELECT r.*, u.full_name AS user_name FROM returns r JOIN users u ON u.id = r.user_id WHERE sale_id = ? ORDER BY r.id')
    .all(id)
  return sale
}

export default function saleRoutes(db) {
  const r = Router()

  // Body: { items: [{ product_id, packs?, loose?, qty?, discount_bps }], payment_method, amount_paid,
  //         customer_name?, customer_phone?, prescription? }
  // Units per line = qty if given, else packs * pack_size + loose.
  r.post('/', (req, res) => {
    const items = req.body.items
    if (!Array.isArray(items) || items.length === 0) throw badRequest('The cart is empty')
    const paymentMethod = oneOf(req.body.payment_method || 'cash', PAYMENT_METHODS, 'Payment method')
    const maxDiscount = MAX_DISCOUNT_BPS[req.user.role]
    const onDate = today()

    // Merge duplicate lines for the same product so FEFO allocation sees the full quantity.
    const cart = new Map()
    for (const [i, it] of items.entries()) {
      const label = `Item ${i + 1}`
      const productId = reqInt(it, 'product_id', { min: 1, label: `${label}: product` })
      const p = db.prepare('SELECT * FROM products WHERE id = ?').get(productId)
      if (!p || !p.active) throw badRequest(`Product ${productId} is not available`)
      const packSize = p.pack_size || 1
      let qty
      if (it.qty !== undefined && it.qty !== null && it.qty !== '') {
        qty = reqInt(it, 'qty', { min: 1, max: 100000, label: `${label}: quantity` })
      } else {
        const packs = optInt(it, 'packs', 0, { min: 0, max: 100000, label: `${label}: packs` })
        const loose = optInt(it, 'loose', 0, { min: 0, max: 100000, label: `${label}: loose units` })
        qty = packs * packSize + loose
        if (qty < 1) throw badRequest(`${label}: quantity must be at least 1`)
        if (qty > 100000) throw badRequest(`${label}: quantity must be between 1 and 100000`)
      }
      if (!p.allow_loose && qty % packSize !== 0) {
        throw badRequest(`${p.name} is sold in full packs of ${packSize} only`)
      }
      const discountBps = reqInt({ v: it.discount_bps ?? 0 }, 'v', { min: 0, max: 10000, label: `${label}: discount` })
      if (discountBps > maxDiscount) {
        throw new HttpError(403, `Your role can give at most ${maxDiscount / 100}% discount`)
      }
      const prev = cart.get(productId)
      cart.set(productId, {
        productId, product: p, qty: (prev?.qty || 0) + qty, discountBps: Math.max(prev?.discountBps || 0, discountBps),
      })
    }
    const products = [...cart.values()]

    const hasRx = products.some((l) => l.product.schedule !== 'otc')
    const hasControlled = products.some((l) => l.product.schedule === 'controlled')
    if (hasControlled && req.user.role === 'cashier') {
      throw new HttpError(403, 'Controlled drugs must be dispensed by a pharmacist')
    }
    const prescription = hasRx ? readPrescription(req.body, hasControlled) : null
    const settings = getSettings(db)
    const till = tillForCash(db, req.user.id, settings, 'sell')

    const sale = transaction(db, () => {
      // Allocate stock and price every batch slice.
      const lines = []
      for (const l of products) {
        const { picks, available, short } = allocateFefo(db, l.product.id, l.qty, onDate)
        if (short > 0) {
          throw new HttpError(409, `Not enough stock for ${l.product.name}: ${available} available`)
        }
        for (const { batch, qty } of picks) {
          const packSize = batch.pack_size ?? 1
          const gross = packAmount(qty, batch.pack_price ?? batch.sale_price * packSize, packSize)
          const discount = percentOf(gross, l.discountBps)
          const net = gross - discount
          lines.push({
            product: l.product, batch, qty, gross, discount, net,
            discountBps: l.discountBps,
            tax: inclusiveTax(net, l.product.gst_rate_bps),
          })
        }
      }

      const subtotal = lines.reduce((s, l) => s + l.gross, 0)
      const discount = lines.reduce((s, l) => s + l.discount, 0)
      const tax = lines.reduce((s, l) => s + l.tax, 0)
      const net = subtotal - discount
      const total = settings.round_to_rupee === '1' ? roundToRupee(net) : net
      const roundOff = total - net

      let amountPaid = total
      if (paymentMethod === 'cash') {
        amountPaid = reqInt({ v: req.body.amount_paid ?? total }, 'v', { min: 0, label: 'Amount paid' })
        if (amountPaid < total) throw badRequest('Amount paid is less than the total')
      }

      let prescriptionId = null
      if (prescription) {
        prescriptionId = Number(
          db.prepare(
            `INSERT INTO prescriptions (patient_name, patient_phone, patient_cnic, prescriber_name, prescriber_reg_no, rx_date, notes)
             VALUES (:patient_name, :patient_phone, :patient_cnic, :prescriber_name, :prescriber_reg_no, :rx_date, :notes)`,
          ).run(prescription).lastInsertRowid,
        )
      }

      const next = db.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS n FROM sales').get().n
      const invoiceNo = `INV-${String(next).padStart(6, '0')}`
      const saleId = Number(
        db.prepare(
          `INSERT INTO sales (invoice_no, user_id, customer_name, customer_phone, prescription_id, subtotal, discount, tax,
             round_off, total, payment_method, amount_paid, change_due, till_session_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          invoiceNo, req.user.id,
          optString(req.body, 'customer_name') || prescription?.patient_name || null,
          optString(req.body, 'customer_phone') || prescription?.patient_phone || null,
          prescriptionId, subtotal, discount, tax, roundOff, total, paymentMethod, amountPaid, amountPaid - total,
          till?.id ?? null,
        ).lastInsertRowid,
      )

      const insertItem = db.prepare(
        `INSERT INTO sale_items (sale_id, product_id, batch_id, qty, unit_price, unit_cost, discount_bps, discount,
           gst_rate_bps, tax, line_total, pack_size) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      for (const l of lines) {
        insertItem.run(saleId, l.product.id, l.batch.id, l.qty, l.batch.sale_price, l.batch.cost_price, l.discountBps,
          l.discount, l.product.gst_rate_bps, l.tax, l.net, l.product.pack_size || 1)
        moveStock(db, { batchId: l.batch.id, change: -l.qty, reason: 'sale', refId: saleId, userId: req.user.id })
      }
      return saleId
    })

    res.status(201).json(loadSale(db, sale))
  })

  // ?from=YYYY-MM-DD&to=YYYY-MM-DD&q=invoice/customer
  r.get('/', (req, res) => {
    const from = req.query.from || today()
    const to = req.query.to || from
    const params = { from, to }
    let extra = ''
    if (req.query.q) {
      extra = 'AND (s.invoice_no LIKE :q OR s.customer_name LIKE :q OR s.customer_phone LIKE :q)'
      params.q = `%${String(req.query.q).trim()}%`
    }
    // Cashiers only see their own sales.
    if (req.user.role === 'cashier') {
      extra += ' AND s.user_id = :uid'
      params.uid = req.user.id
    }
    res.json(
      db.prepare(
        `SELECT s.*, u.full_name AS cashier_name,
           COALESCE((SELECT SUM(refund_total) FROM returns r WHERE r.sale_id = s.id), 0) AS refunded
         FROM sales s JOIN users u ON u.id = s.user_id
         WHERE date(s.created_at) BETWEEN :from AND :to ${extra}
         ORDER BY s.id DESC LIMIT 500`,
      ).all(params),
    )
  })

  r.get('/:ref', (req, res) => {
    const ref = req.params.ref
    const row = /^\d+$/.test(ref)
      ? { id: Number(ref) }
      : db.prepare('SELECT id FROM sales WHERE invoice_no = ?').get(ref.toUpperCase())
    const sale = row && loadSale(db, row.id)
    if (!sale) throw notFound('Sale')
    if (req.user.role === 'cashier' && sale.user_id !== req.user.id) throw notFound('Sale')
    res.json(sale)
  })

  // Body: { items: [{ sale_item_id, qty, restock? }], reason }
  r.post('/:id/returns', requireRole('admin', 'pharmacist'), (req, res) => {
    const saleId = Number(req.params.id)
    const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId)
    if (!sale) throw notFound('Sale')
    const items = req.body.items
    if (!Array.isArray(items) || items.length === 0) throw badRequest('Choose at least one item to return')
    const reason = reqString(req.body, 'reason', 'Reason')
    const till = tillForCash(db, req.user.id, getSettings(db), 'refund')

    transaction(db, () => {
      const lines = items.map((it, i) => {
        const si = db.prepare('SELECT * FROM sale_items WHERE id = ? AND sale_id = ?').get(Number(it.sale_item_id), saleId)
        if (!si) throw badRequest(`Item ${i + 1} is not on this sale`)
        const qty = reqInt(it, 'qty', { min: 1, max: si.qty - si.returned_qty, label: `Item ${i + 1}: return quantity` })
        // Refund at the price actually charged, including the item's share of the discount.
        const amount = Math.round((si.line_total * qty) / si.qty)
        const tax = Math.round((si.tax * qty) / si.qty)
        const batch = db.prepare('SELECT expiry_date FROM batches WHERE id = ?').get(si.batch_id)
        const restock = it.restock !== false && batch.expiry_date >= today()
        return { si, qty, amount, tax, restock }
      })
      const refundTotal = lines.reduce((s, l) => s + l.amount, 0)
      const returnId = Number(
        db.prepare('INSERT INTO returns (sale_id, user_id, reason, refund_total, till_session_id) VALUES (?, ?, ?, ?, ?)')
          .run(saleId, req.user.id, reason, refundTotal, till?.id ?? null).lastInsertRowid,
      )
      for (const l of lines) {
        db.prepare('INSERT INTO return_items (return_id, sale_item_id, qty, amount, tax, restocked) VALUES (?, ?, ?, ?, ?, ?)')
          .run(returnId, l.si.id, l.qty, l.amount, l.tax, l.restock ? 1 : 0)
        db.prepare('UPDATE sale_items SET returned_qty = returned_qty + ? WHERE id = ?').run(l.qty, l.si.id)
        if (l.restock) {
          moveStock(db, { batchId: l.si.batch_id, change: l.qty, reason: 'return', refId: returnId, userId: req.user.id })
        }
      }
      return returnId
    })
    res.status(201).json(loadSale(db, saleId))
  })

  return r
}
