import { Router } from 'express'
import { requireRole } from '../auth.js'
import { transaction, today, getSettings } from '../db.js'
import { HttpError, badRequest, notFound, reqInt, optInt, reqString, optString, reqDate, optDate, oneOf } from '../lib/http.js'
import { packAmount, percentOf, priceForMargin } from '../lib/money.js'
import { moveStock } from '../lib/stock.js'
import { addDays, tillForSupplierPayment, recordSupplierPayment } from '../lib/supplier-ledger.js'

const PAYMENT_TYPES = ['credit', 'cash']
const CASH_PURCHASE_METHODS = ['cash', 'till', 'bank']

// One invoice line. Pack lines: { packs, loose_qty, bonus_qty, pack_cost, discount_bps, pack_price }.
// Legacy unit lines: { qty, cost_price, sale_price } (per unit).
function readLine(db, it, i, marginBps) {
  const n = `Line ${i + 1}`
  if (!it || typeof it !== 'object') throw badRequest(`${n}: item is not valid`)
  const productId = reqInt(it, 'product_id', { min: 1, label: `${n}: product` })
  const product = db.prepare('SELECT id, name, pack_size, pack_price, sale_price FROM products WHERE id = ?').get(productId)
  if (!product) throw badRequest(`${n}: product not found`)
  const packSize = product.pack_size || 1
  const line = {
    product,
    pack_size: packSize,
    batch_no: reqString(it, 'batch_no', `${n}: batch number`).toUpperCase(),
    expiry_date: reqDate(it, 'expiry_date', `${n}: expiry date`),
    bonus_qty: optInt(it, 'bonus_qty', 0, { min: 0, label: `${n}: bonus quantity` }),
    discount_bps: optInt(it, 'discount_bps', 0, { min: 0, max: 10000, label: `${n}: discount` }),
    packs: null,
    loose_qty: 0,
    pack_cost: null,
  }
  let givenPackPrice
  const legacy = it.packs === undefined && it.pack_cost === undefined && it.qty !== undefined
  if (legacy) {
    line.units = reqInt(it, 'qty', { min: 1, label: `${n}: quantity` })
    const unitCost = reqInt(it, 'cost_price', { min: 0, label: `${n}: cost price` })
    line.gross = line.units * unitCost
    const unitPrice = optInt(it, 'sale_price', null, { min: 0, label: `${n}: sale price` })
    givenPackPrice = unitPrice === null ? null : unitPrice * packSize
  } else {
    line.packs = optInt(it, 'packs', 0, { min: 0, label: `${n}: packs` })
    line.loose_qty = optInt(it, 'loose_qty', 0, { min: 0, label: `${n}: loose units` })
    line.units = line.packs * packSize + line.loose_qty
    if (line.units <= 0) throw badRequest(`${n}: enter the number of packs or loose units`)
    line.pack_cost = reqInt(it, 'pack_cost', { min: 0, label: `${n}: pack cost` })
    line.gross = packAmount(line.units, line.pack_cost, packSize)
    givenPackPrice = optInt(it, 'pack_price', null, { min: 0, label: `${n}: pack price` })
  }
  line.discount = percentOf(line.gross, line.discount_bps)
  line.net = line.gross - line.discount
  // Cost per unit spreads the net amount over bonus units too.
  line.cost_price = Math.round(line.net / (line.units + line.bonus_qty))
  const productPackPrice = product.pack_price || product.sale_price * packSize
  line.pack_price = givenPackPrice ?? (productPackPrice > 0
    ? productPackPrice
    : priceForMargin(Math.round((line.net * packSize) / line.units), marginBps))
  line.sale_price = Math.round(line.pack_price / packSize)
  return line
}

export default function purchaseRoutes(db) {
  const r = Router()
  r.use(requireRole('admin', 'pharmacist'))

  const getPurchase = (id) => {
    const p = db
      .prepare(
        `SELECT pu.*, s.name AS supplier_name, u.full_name AS received_by FROM purchases pu
         JOIN suppliers s ON s.id = pu.supplier_id JOIN users u ON u.id = pu.user_id WHERE pu.id = ?`,
      )
      .get(id)
    if (!p) throw notFound('Purchase')
    p.items = db
      .prepare(
        `SELECT pi.*, b.product_id, b.batch_no, b.expiry_date, b.sale_price, b.pack_size, pr.name AS product_name
         FROM purchase_items pi JOIN batches b ON b.id = pi.batch_id JOIN products pr ON pr.id = b.product_id
         WHERE pi.purchase_id = ? ORDER BY pi.id`,
      )
      .all(p.id)
    p.paid = db.prepare('SELECT COALESCE(SUM(amount), 0) AS v FROM supplier_payments WHERE purchase_id = ?').get(p.id).v
    return p
  }

  // Optional ?supplier_id=.
  r.get('/', (req, res) => {
    const sid = req.query.supplier_id ? Number(req.query.supplier_id) : null
    res.json(
      db.prepare(
        `SELECT pu.*, s.name AS supplier_name, u.full_name AS received_by,
           (SELECT COUNT(*) FROM purchase_items pi WHERE pi.purchase_id = pu.id) AS item_count
         FROM purchases pu JOIN suppliers s ON s.id = pu.supplier_id JOIN users u ON u.id = pu.user_id
         ${sid ? 'WHERE pu.supplier_id = ?' : ''}
         ORDER BY pu.id DESC LIMIT 200`,
      ).all(...(sid ? [sid] : [])),
    )
  })

  r.get('/:id', (req, res) => {
    res.json(getPurchase(Number(req.params.id)))
  })

  // Receive stock against a supplier invoice. Each line creates or tops up a batch.
  r.post('/', (req, res) => {
    const body = req.body || {}
    const supplierId = reqInt(body, 'supplier_id', { min: 1, label: 'Supplier' })
    const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(supplierId)
    if (!supplier) throw notFound('Supplier')
    const paymentType = oneOf(body.payment_type || 'credit', PAYMENT_TYPES, 'Payment type')
    const paymentMethod = paymentType === 'cash'
      ? oneOf(body.payment_method || 'cash', CASH_PURCHASE_METHODS, 'Payment method')
      : null
    const invoiceDate = optDate(body, 'invoice_date', 'Invoice date')
    const billDate = invoiceDate || today()
    const dueDate = paymentType === 'credit' ? addDays(billDate, supplier.due_days || 0) : billDate
    const items = body.items
    if (!Array.isArray(items) || items.length === 0) throw badRequest('Add at least one item')

    const settings = getSettings(db)
    const margin = Number(settings.default_margin_bps)
    const marginBps = Number.isFinite(margin) && settings.default_margin_bps !== '' ? margin : 1500
    const lines = items.map((it, i) => readLine(db, it, i, marginBps))
    const till = paymentMethod === 'till' ? tillForSupplierPayment(db, req.user.id) : null

    const purchaseId = transaction(db, () => {
      const gross = lines.reduce((s, l) => s + l.gross, 0)
      const discount = lines.reduce((s, l) => s + l.discount, 0)
      const total = gross - discount
      const { lastInsertRowid } = db
        .prepare(
          `INSERT INTO purchases (supplier_id, invoice_no, invoice_date, payment_type, due_date, gross, discount, total, notes, user_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(supplierId, optString(body, 'invoice_no'), invoiceDate, paymentType, dueDate, gross, discount, total,
          optString(body, 'notes'), req.user.id)
      const purchaseId = Number(lastInsertRowid)

      for (const [i, l] of lines.entries()) {
        let batch = db.prepare('SELECT * FROM batches WHERE product_id = ? AND batch_no = ?').get(l.product.id, l.batch_no)
        if (batch && batch.expiry_date !== l.expiry_date) {
          throw new HttpError(409, `Line ${i + 1}: ${l.product.name} batch ${l.batch_no} is already recorded with expiry ${batch.expiry_date}`)
        }
        if (!batch) {
          const ins = db
            .prepare(
              `INSERT INTO batches (product_id, batch_no, expiry_date, cost_price, sale_price, pack_price, pack_size)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(l.product.id, l.batch_no, l.expiry_date, l.cost_price, l.sale_price, l.pack_price, l.pack_size)
          batch = { id: Number(ins.lastInsertRowid) }
        } else {
          db.prepare('UPDATE batches SET cost_price = ?, sale_price = ?, pack_price = ?, pack_size = ? WHERE id = ?')
            .run(l.cost_price, l.sale_price, l.pack_price, l.pack_size, batch.id)
        }
        const received = l.units + l.bonus_qty
        db.prepare(
          `INSERT INTO purchase_items (purchase_id, batch_id, qty, cost_price, line_total, packs, loose_qty, bonus_qty,
             pack_cost, discount_bps, pack_price)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(purchaseId, batch.id, received, l.cost_price, l.net, l.packs, l.loose_qty, l.bonus_qty, l.pack_cost,
          l.discount_bps, l.pack_price)
        moveStock(db, { batchId: batch.id, change: received, reason: 'purchase', refId: purchaseId, userId: req.user.id,
          note: l.bonus_qty ? `incl. ${l.bonus_qty} bonus` : null })
        db.prepare('UPDATE products SET pack_price = ?, sale_price = ? WHERE id = ?').run(l.pack_price, l.sale_price, l.product.id)
      }

      // A cash purchase is paid on the spot.
      if (paymentType === 'cash' && total > 0) {
        recordSupplierPayment(db, {
          supplier, amount: total, method: paymentMethod, paidOn: billDate, purchaseId,
          note: `Cash purchase ${optString(body, 'invoice_no') || `#${purchaseId}`}`, userId: req.user.id, till,
        })
      }
      return purchaseId
    })
    res.status(201).json(getPurchase(purchaseId))
  })

  return r
}
