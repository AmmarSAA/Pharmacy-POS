import { Router } from '../lib/router.js'
import { requireRole } from '../auth.js'
import { today, nowStamp, getSettings } from '../db.js'
import { escapeRegex } from './products.routes.js'
import { addDays } from '../lib/supplier-ledger.js'
import { HttpError, badRequest, notFound, reqInt, optInt, reqString, optString, optDate, oneOf } from '../lib/http.js'
import { allocateFefo, moveStock } from '../lib/stock.js'
import { percentOf, inclusiveTax, roundToRupee, packAmount } from '../lib/money.js'
import { tillForCash } from '../lib/till.js'

const PAYMENT_METHODS = ['cash', 'card', 'wallet']
// Owner-set discount caps per role (settings max_discount_<role>_bps).
const maxDiscountFor = (settings, role) => Number(settings[`max_discount_${role}_bps`] ?? 0)

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

const STAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/

function readOffline(body) {
  if (body.offline_id === undefined || body.offline_id === null || body.offline_id === '') return null
  const id = String(body.offline_id)
  if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) throw badRequest('offline_id is not valid')
  const at = String(body.offline_at || '')
  if (!STAMP.test(at) || Number.isNaN(Date.parse(at.replace(' ', 'T')))) throw badRequest('offline_at must be YYYY-MM-DD HH:MM:SS')
  const now = nowStamp()
  if (at > now) throw badRequest('offline_at is in the future')
  // Older than a week means a device sat offline far too long; a person should look at it.
  if (at.slice(0, 10) < addDays(now.slice(0, 10), -7)) throw badRequest('This offline sale is more than 7 days old; enter it by hand')
  return { id, at }
}

// The user's till that was open at a moment (opened before it, not yet closed then).
async function tillAt(db, userId, at) {
  return (await db.col('till_sessions').findOne(
    { user_id: userId, opened_at: { $lte: at }, $or: [{ closed_at: null }, { closed_at: { $gte: at } }] },
    { sort: { id: -1 } },
  )) || null
}

export async function loadSale(db, id) {
  const sale = await db.get('sales', id)
  if (!sale) return null
  await db.join([sale], [{ key: 'user_id', from: 'users', fields: { cashier_name: 'full_name' } }])
  sale.items = await db.all('sale_items', { sale_id: sale.id }, { sort: { id: 1 } })
  await db.join(sale.items, [
    { key: 'product_id', from: 'products', fields: { product_name: 'name', strength: 'strength', form: 'form', schedule: 'schedule' } },
    { key: 'batch_id', from: 'batches', fields: { batch_no: 'batch_no', expiry_date: 'expiry_date' } },
  ])
  sale.prescription = sale.prescription_id ? await db.get('prescriptions', sale.prescription_id) : null
  sale.returns = await db.all('returns', { sale_id: sale.id }, { sort: { id: 1 } })
  await db.join(sale.returns, [{ key: 'user_id', from: 'users', fields: { user_name: 'full_name' } }])
  return sale
}

export default function saleRoutes(db) {
  const r = Router()

  // Body: { items: [{ product_id, packs?, loose?, qty?, discount_bps }], payment_method, amount_paid,
  //         customer_name?, customer_phone?, prescription? }
  // Units per line = qty if given, else packs * pack_size + loose.
  r.post('/', async (req, res) => {
    // A sale made while the counter was offline, synced now: offline_id makes the sync idempotent,
    // offline_at is when it really happened (it is dated and assigned to the till open at that time).
    const offline = readOffline(req.body)
    if (offline) {
      const done = await db.col('sales').findOne({ offline_id: offline.id }, { projection: { id: 1 } })
      if (done) return res.status(200).json(await loadSale(db, done.id))
    }
    const items = req.body.items
    if (!Array.isArray(items) || items.length === 0) throw badRequest('The cart is empty')
    const paymentMethod = oneOf(req.body.payment_method || 'cash', PAYMENT_METHODS, 'Payment method')
    const settings = await getSettings(db)
    const maxDiscount = maxDiscountFor(settings, req.user.role)
    const onDate = offline ? offline.at.slice(0, 10) : today()

    // Merge duplicate lines for the same product so FEFO allocation sees the full quantity.
    const cart = new Map()
    for (const [i, it] of items.entries()) {
      const label = `Item ${i + 1}`
      const productId = reqInt(it, 'product_id', { min: 1, label: `${label}: product` })
      const p = await db.get('products', productId)
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
    if (hasControlled && offline) {
      throw new HttpError(409, 'Controlled drugs cannot be sold offline; the register must be kept online')
    }
    if (hasControlled && req.user.role === 'cashier') {
      throw new HttpError(403, 'Controlled drugs must be dispensed by a pharmacist')
    }
    const prescription = hasRx ? readPrescription(req.body, hasControlled) : null
    // Offline sales already happened: they go to the till that was open then (or none), never refused.
    const till = offline ? await tillAt(db, req.user.id, offline.at) : await tillForCash(db, req.user.id, settings, 'sell')

    const createSale = () => db.tx(async () => {
      // Allocate stock and price every batch slice.
      const lines = []
      for (const l of products) {
        const { picks, available, short } = await allocateFefo(db, l.product.id, l.qty, onDate)
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
        prescriptionId = await db.insert('prescriptions', prescription)
      }

      const saleId = await db.nextId('sales')
      const stamp = offline ? offline.at : nowStamp()
      await db.col('sales').insertOne({
        _id: saleId, id: saleId, invoice_no: `INV-${String(saleId).padStart(6, '0')}`, user_id: req.user.id,
        customer_name: optString(req.body, 'customer_name') || prescription?.patient_name || null,
        customer_phone: optString(req.body, 'customer_phone') || prescription?.patient_phone || null,
        prescription_id: prescriptionId, subtotal, discount, tax, round_off: roundOff, total, payment_method: paymentMethod,
        amount_paid: amountPaid, change_due: amountPaid - total, till_session_id: till?.id ?? null, created_at: stamp,
        has_controlled: hasControlled ? 1 : 0,
        ...(offline && { offline_id: offline.id, synced_at: nowStamp() }),
      })

      let itemId = await db.reserveIds('sale_items', lines.length)
      const docs = lines.map((l) => {
        const id = itemId++
        return {
          _id: id, id, sale_id: saleId, product_id: l.product.id, batch_id: l.batch.id, qty: l.qty, unit_price: l.batch.sale_price,
          unit_cost: l.batch.cost_price, discount_bps: l.discountBps, discount: l.discount, gst_rate_bps: l.product.gst_rate_bps,
          tax: l.tax, line_total: l.net, returned_qty: 0, pack_size: l.product.pack_size || 1, created_at: stamp,
        }
      })
      await db.col('sale_items').insertMany(docs)
      for (const l of lines) {
        await moveStock(db, { batchId: l.batch.id, change: -l.qty, reason: 'sale', refId: saleId, userId: req.user.id })
      }
      return saleId
    })

    let sale
    try {
      sale = await createSale()
    } catch (err) {
      // The same offline sale synced twice at once: the second one returns the first.
      if (offline && err.code === 11000) {
        const done = await db.col('sales').findOne({ offline_id: offline.id }, { projection: { id: 1 } })
        if (done) return res.status(200).json(await loadSale(db, done.id))
      }
      throw err
    }
    res.status(201).json(await loadSale(db, sale))
  })

  // ?from=YYYY-MM-DD&to=YYYY-MM-DD&q=invoice/customer
  r.get('/', async (req, res) => {
    const from = req.query.from || today()
    const to = req.query.to || from
    const filter = { created_at: { $gte: from, $lt: `${to}~` } }
    if (req.query.q) {
      const q = new RegExp(escapeRegex(String(req.query.q).trim()), 'i')
      filter.$or = [{ invoice_no: q }, { customer_name: q }, { customer_phone: q }]
    }
    // Cashiers only see their own sales.
    if (req.user.role === 'cashier') filter.user_id = req.user.id
    const rows = await db.all('sales', filter, { sort: { id: -1 }, limit: 500 })
    await db.join(rows, [{ key: 'user_id', from: 'users', fields: { cashier_name: 'full_name' } }])
    const refunds = await db.col('returns').aggregate([
      { $match: { sale_id: { $in: rows.map((r) => r.id) } } }, { $group: { _id: '$sale_id', v: { $sum: '$refund_total' } } },
    ]).toArray()
    const byId = new Map(refunds.map((x) => [x._id, x.v]))
    for (const row of rows) row.refunded = byId.get(row.id) || 0
    res.json(rows)
  })

  r.get('/:ref', async (req, res) => {
    const ref = req.params.ref
    const row = /^\d+$/.test(ref)
      ? { id: Number(ref) }
      : await db.col('sales').findOne({ invoice_no: ref.toUpperCase() }, { projection: { id: 1 } })
    const sale = row && (await loadSale(db, row.id))
    if (!sale) throw notFound('Sale')
    if (req.user.role === 'cashier' && sale.user_id !== req.user.id) throw notFound('Sale')
    res.json(sale)
  })

  // Body: { items: [{ sale_item_id, qty, restock? }], reason }
  r.post('/:id/returns', requireRole('admin', 'pharmacist'), async (req, res) => {
    const saleId = Number(req.params.id)
    const sale = await db.get('sales', saleId)
    if (!sale) throw notFound('Sale')
    const items = req.body.items
    if (!Array.isArray(items) || items.length === 0) throw badRequest('Choose at least one item to return')
    const reason = reqString(req.body, 'reason', 'Reason')
    // Card/wallet sales go back to the card/wallet when the owner allows it; everything else is cash.
    const settings = await getSettings(db)
    const refundMethod =
      settings.refund_card_sales === 'original' && sale.payment_method !== 'cash' ? sale.payment_method : 'cash'
    const till = refundMethod === 'cash' ? await tillForCash(db, req.user.id, settings, 'refund') : null

    await db.tx(async () => {
      const lines = []
      for (const [i, it] of items.entries()) {
        const si = await db.col('sale_items').findOne({ _id: Number(it.sale_item_id), sale_id: saleId })
        if (!si) throw badRequest(`Item ${i + 1} is not on this sale`)
        const qty = reqInt(it, 'qty', { min: 1, max: si.qty - si.returned_qty, label: `Item ${i + 1}: return quantity` })
        // Refund at the price actually charged, including the item's share of the discount.
        const amount = Math.round((si.line_total * qty) / si.qty)
        const tax = Math.round((si.tax * qty) / si.qty)
        const batch = await db.get('batches', si.batch_id)
        const restock = it.restock !== false && batch.expiry_date >= today()
        lines.push({ si, qty, amount, tax, restock })
      }
      const refundTotal = lines.reduce((s, l) => s + l.amount, 0)
      const returnId = await db.insert('returns', {
        sale_id: saleId, user_id: req.user.id, reason, refund_total: refundTotal, till_session_id: till?.id ?? null, refund_method: refundMethod,
      })
      for (const l of lines) {
        await db.insert('return_items', {
          return_id: returnId, sale_item_id: l.si.id, qty: l.qty, amount: l.amount, tax: l.tax, restocked: l.restock ? 1 : 0,
          unit_cost: l.si.unit_cost, product_id: l.si.product_id,
        })
        // Conditional, so a line can never be returned twice over.
        const upd = await db.col('sale_items').updateOne(
          { _id: l.si.id, returned_qty: { $lte: l.si.qty - l.qty } }, { $inc: { returned_qty: l.qty } },
        )
        if (!upd.modifiedCount) throw new HttpError(409, 'This item was returned already')
        if (l.restock) {
          await moveStock(db, { batchId: l.si.batch_id, change: l.qty, reason: 'return', refId: returnId, userId: req.user.id })
        }
      }
      return returnId
    })
    res.status(201).json(await loadSale(db, saleId))
  })

  return r
}
