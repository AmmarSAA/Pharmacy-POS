import { Router } from '../lib/router.js'
import { requireRole } from '../auth.js'
import { today, getSettings } from '../db.js'
import { HttpError, badRequest, notFound, reqInt, optInt, reqString, optString, reqDate, optDate, oneOf } from '../lib/http.js'
import { packAmount, percentOf, priceForMargin } from '../lib/money.js'
import { moveStock } from '../lib/stock.js'
import { addDays, tillForSupplierPayment, recordSupplierPayment } from '../lib/supplier-ledger.js'

const PAYMENT_TYPES = ['credit', 'cash']
const CASH_PURCHASE_METHODS = ['cash', 'till', 'bank']

// One invoice line. Pack lines: { packs, loose_qty, bonus_qty, pack_cost, discount_bps, pack_price }.
// Legacy unit lines: { qty, cost_price, sale_price } (per unit).
async function readLine(db, it, i, marginBps) {
  const n = `Line ${i + 1}`
  if (!it || typeof it !== 'object') throw badRequest(`${n}: item is not valid`)
  const productId = reqInt(it, 'product_id', { min: 1, label: `${n}: product` })
  const product = await db.col('products').findOne({ _id: productId }, { projection: { id: 1, name: 1, pack_size: 1, pack_price: 1, sale_price: 1 } })
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

  const getPurchase = async (id) => {
    const p = await db.get('purchases', id)
    if (!p) throw notFound('Purchase')
    await db.join([p], [
      { key: 'supplier_id', from: 'suppliers', fields: { supplier_name: 'name' } },
      { key: 'user_id', from: 'users', fields: { received_by: 'full_name' } },
    ])
    const items = await db.all('purchase_items', { purchase_id: p.id }, { sort: { id: 1 } })
    await db.join(items, [{ key: 'batch_id', from: 'batches', fields: {
      product_id: 'product_id', batch_no: 'batch_no', expiry_date: 'expiry_date', sale_price: 'sale_price', pack_size: 'pack_size',
    } }])
    await db.join(items, [{ key: 'product_id', from: 'products', fields: { product_name: 'name' } }])
    p.items = items
    p.paid = await db.sum('supplier_payments', { purchase_id: p.id }, 'amount')
    return p
  }

  // Optional ?supplier_id=.
  r.get('/', async (req, res) => {
    const sid = req.query.supplier_id ? Number(req.query.supplier_id) : null
    const rows = await db.all('purchases', sid ? { supplier_id: sid } : {}, { sort: { id: -1 }, limit: 200 })
    await db.join(rows, [
      { key: 'supplier_id', from: 'suppliers', fields: { supplier_name: 'name' } },
      { key: 'user_id', from: 'users', fields: { received_by: 'full_name' } },
    ])
    const counts = await db.col('purchase_items').aggregate([
      { $match: { purchase_id: { $in: rows.map((r) => r.id) } } }, { $group: { _id: '$purchase_id', n: { $sum: 1 } } },
    ]).toArray()
    const byId = new Map(counts.map((c) => [c._id, c.n]))
    for (const row of rows) row.item_count = byId.get(row.id) || 0
    res.json(rows)
  })

  r.get('/:id', async (req, res) => {
    res.json(await getPurchase(Number(req.params.id)))
  })

  // Receive stock against a supplier invoice. Each line creates or tops up a batch.
  r.post('/', async (req, res) => {
    const body = req.body || {}
    const supplierId = reqInt(body, 'supplier_id', { min: 1, label: 'Supplier' })
    const supplier = await db.get('suppliers', supplierId)
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

    const settings = await getSettings(db)
    const margin = Number(settings.default_margin_bps)
    const marginBps = Number.isFinite(margin) && settings.default_margin_bps !== '' ? margin : 1500
    const lines = []
    for (const [i, it] of items.entries()) lines.push(await readLine(db, it, i, marginBps))
    const till = paymentMethod === 'till' ? await tillForSupplierPayment(db, req.user.id) : null

    const purchaseId = await db.tx(async () => {
      const gross = lines.reduce((s, l) => s + l.gross, 0)
      const discount = lines.reduce((s, l) => s + l.discount, 0)
      const total = gross - discount
      const purchaseId = await db.insert('purchases', {
        supplier_id: supplierId, invoice_no: optString(body, 'invoice_no'), invoice_date: invoiceDate, payment_type: paymentType,
        due_date: dueDate, gross, discount, total, notes: optString(body, 'notes'), user_id: req.user.id,
      })

      for (const [i, l] of lines.entries()) {
        let batch = await db.col('batches').findOne({ product_id: l.product.id, batch_no: l.batch_no })
        if (batch && batch.expiry_date !== l.expiry_date) {
          throw new HttpError(409, `Line ${i + 1}: ${l.product.name} batch ${l.batch_no} is already recorded with expiry ${batch.expiry_date}`)
        }
        if (!batch) {
          const id = await db.insert('batches', {
            product_id: l.product.id, batch_no: l.batch_no, expiry_date: l.expiry_date, cost_price: l.cost_price,
            sale_price: l.sale_price, pack_price: l.pack_price, pack_size: l.pack_size, qty_on_hand: 0,
          })
          batch = { id }
        } else {
          await db.col('batches').updateOne({ _id: batch.id }, {
            $set: { cost_price: l.cost_price, sale_price: l.sale_price, pack_price: l.pack_price, pack_size: l.pack_size },
          })
        }
        const received = l.units + l.bonus_qty
        await db.insert('purchase_items', {
          purchase_id: purchaseId, batch_id: batch.id, qty: received, cost_price: l.cost_price, line_total: l.net,
          packs: l.packs, loose_qty: l.loose_qty, bonus_qty: l.bonus_qty, pack_cost: l.pack_cost,
          discount_bps: l.discount_bps, pack_price: l.pack_price,
        })
        await moveStock(db, { batchId: batch.id, change: received, reason: 'purchase', refId: purchaseId, userId: req.user.id,
          note: l.bonus_qty ? `incl. ${l.bonus_qty} bonus` : null })
        await db.col('products').updateOne({ _id: l.product.id }, { $set: { pack_price: l.pack_price, sale_price: l.sale_price } })
      }

      // A cash purchase is paid on the spot.
      if (paymentType === 'cash' && total > 0) {
        await recordSupplierPayment(db, {
          supplier, amount: total, method: paymentMethod, paidOn: billDate, purchaseId,
          note: `Cash purchase ${optString(body, 'invoice_no') || `#${purchaseId}`}`, userId: req.user.id, till,
        })
      }
      return purchaseId
    })
    res.status(201).json(await getPurchase(purchaseId))
  })

  return r
}
