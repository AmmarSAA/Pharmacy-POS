import { Router } from 'express'
import { requireRole } from '../auth.js'
import { transaction } from '../db.js'
import { HttpError, badRequest, notFound, reqInt, reqString, optString, reqDate, optDate } from '../lib/http.js'
import { moveStock } from '../lib/stock.js'

export default function purchaseRoutes(db) {
  const r = Router()
  r.use(requireRole('admin', 'pharmacist'))

  r.get('/', (req, res) => {
    res.json(
      db.prepare(
        `SELECT pu.*, s.name AS supplier_name, u.full_name AS received_by,
           (SELECT COUNT(*) FROM purchase_items pi WHERE pi.purchase_id = pu.id) AS item_count
         FROM purchases pu JOIN suppliers s ON s.id = pu.supplier_id JOIN users u ON u.id = pu.user_id
         ORDER BY pu.id DESC LIMIT 200`,
      ).all(),
    )
  })

  r.get('/:id', (req, res) => {
    const p = db
      .prepare(
        `SELECT pu.*, s.name AS supplier_name, u.full_name AS received_by FROM purchases pu
         JOIN suppliers s ON s.id = pu.supplier_id JOIN users u ON u.id = pu.user_id WHERE pu.id = ?`,
      )
      .get(Number(req.params.id))
    if (!p) throw notFound('Purchase')
    p.items = db
      .prepare(
        `SELECT pi.*, b.batch_no, b.expiry_date, b.sale_price, pr.name AS product_name
         FROM purchase_items pi JOIN batches b ON b.id = pi.batch_id JOIN products pr ON pr.id = b.product_id
         WHERE pi.purchase_id = ?`,
      )
      .all(p.id)
    res.json(p)
  })

  // Receive stock against a supplier invoice. Each line creates or tops up a batch.
  r.post('/', (req, res) => {
    const supplierId = reqInt(req.body, 'supplier_id', { min: 1, label: 'Supplier' })
    if (!db.prepare('SELECT 1 FROM suppliers WHERE id = ?').get(supplierId)) throw notFound('Supplier')
    const items = req.body.items
    if (!Array.isArray(items) || items.length === 0) throw badRequest('Add at least one item')

    const lines = items.map((it, i) => {
      const n = `Line ${i + 1}`
      const productId = reqInt(it, 'product_id', { min: 1, label: `${n}: product` })
      const product = db.prepare('SELECT id, name, sale_price FROM products WHERE id = ?').get(productId)
      if (!product) throw badRequest(`${n}: product not found`)
      const line = {
        product,
        batch_no: reqString(it, 'batch_no', `${n}: batch number`).toUpperCase(),
        expiry_date: reqDate(it, 'expiry_date', `${n}: expiry date`),
        qty: reqInt(it, 'qty', { min: 1, label: `${n}: quantity` }),
        bonus_qty: reqInt({ v: it.bonus_qty ?? 0 }, 'v', { min: 0, label: `${n}: bonus quantity` }),
        cost_price: reqInt(it, 'cost_price', { min: 0, label: `${n}: cost price` }),
        sale_price: reqInt({ v: it.sale_price ?? product.sale_price }, 'v', { min: 0, label: `${n}: sale price` }),
      }
      return line
    })

    const purchase = transaction(db, () => {
      const total = lines.reduce((s, l) => s + l.qty * l.cost_price, 0)
      const { lastInsertRowid } = db
        .prepare('INSERT INTO purchases (supplier_id, invoice_no, invoice_date, total, notes, user_id) VALUES (?, ?, ?, ?, ?, ?)')
        .run(supplierId, optString(req.body, 'invoice_no'), optDate(req.body, 'invoice_date', 'Invoice date'), total, optString(req.body, 'notes'), req.user.id)
      const purchaseId = Number(lastInsertRowid)

      for (const l of lines) {
        let batch = db.prepare('SELECT * FROM batches WHERE product_id = ? AND batch_no = ?').get(l.product.id, l.batch_no)
        if (batch && batch.expiry_date !== l.expiry_date) {
          throw new HttpError(409, `${l.product.name} batch ${l.batch_no} is already recorded with expiry ${batch.expiry_date}`)
        }
        if (!batch) {
          const ins = db
            .prepare('INSERT INTO batches (product_id, batch_no, expiry_date, cost_price, sale_price) VALUES (?, ?, ?, ?, ?)')
            .run(l.product.id, l.batch_no, l.expiry_date, l.cost_price, l.sale_price)
          batch = { id: Number(ins.lastInsertRowid) }
        } else {
          db.prepare('UPDATE batches SET cost_price = ?, sale_price = ? WHERE id = ?').run(l.cost_price, l.sale_price, batch.id)
        }
        const received = l.qty + l.bonus_qty
        db.prepare('INSERT INTO purchase_items (purchase_id, batch_id, qty, cost_price, line_total) VALUES (?, ?, ?, ?, ?)')
          .run(purchaseId, batch.id, received, l.cost_price, l.qty * l.cost_price)
        moveStock(db, { batchId: batch.id, change: received, reason: 'purchase', refId: purchaseId, userId: req.user.id,
          note: l.bonus_qty ? `incl. ${l.bonus_qty} bonus` : null })
        db.prepare('UPDATE products SET sale_price = ? WHERE id = ?').run(l.sale_price, l.product.id)
      }
      return purchaseId
    })
    res.status(201).json({ id: purchase })
  })

  return r
}
