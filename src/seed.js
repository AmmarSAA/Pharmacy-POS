// Loads demo suppliers, products and stock into an empty database, for trying the app out.
// Run after creating the admin account: npm run seed
import { openStore } from './db-node.js'
import { moveStock } from './lib/stock.js'
import { today } from './db.js'

const db = await openStore()
const admin = await db.col('users').findOne({ role: 'admin' }, { sort: { id: 1 } })
if (!admin) {
  console.error('Create the admin account first (start the app and open it in a browser), then run the seed.')
  process.exit(1)
}
if ((await db.col('products').countDocuments({})) > 0) {
  console.error('Products already exist; the seed only runs on an empty catalogue.')
  process.exit(1)
}

const inMonths = (m) => {
  const d = new Date()
  d.setMonth(d.getMonth() + m)
  return d.toISOString().slice(0, 10)
}

// name, generic, barcode, form, strength, pack, schedule, gst bps, reorder, price (paisa/unit), cost
const PRODUCTS = [
  ['Panadol', 'Paracetamol', '8964000100011', 'Tablet', '500mg', 10, 'otc', 0, 100, 250, 190],
  ['Panadol Extra', 'Paracetamol + Caffeine', '8964000100028', 'Tablet', '500mg/65mg', 10, 'otc', 0, 50, 420, 330],
  ['Brufen', 'Ibuprofen', '8964000100035', 'Tablet', '400mg', 10, 'otc', 0, 50, 600, 470],
  ['Disprin', 'Aspirin', '8964000100042', 'Tablet', '300mg', 10, 'otc', 0, 50, 180, 140],
  ['ORS Sachet', 'Oral rehydration salts', '8964000100059', 'Sachet', '20.5g', 1, 'otc', 0, 30, 3500, 2800],
  ['Augmentin', 'Amoxicillin + Clavulanate', '8964000100066', 'Tablet', '625mg', 6, 'rx', 0, 20, 5200, 4300],
  ['Flagyl', 'Metronidazole', '8964000100073', 'Tablet', '400mg', 10, 'rx', 0, 20, 450, 360],
  ['Glucophage', 'Metformin', '8964000100080', 'Tablet', '500mg', 10, 'rx', 0, 30, 550, 440],
  ['Risek', 'Omeprazole', '8964000100097', 'Capsule', '20mg', 14, 'rx', 0, 30, 1450, 1150],
  ['Xanax', 'Alprazolam', '8964000100103', 'Tablet', '0.5mg', 30, 'controlled', 0, 10, 700, 560],
  ['Tramal', 'Tramadol', '8964000100110', 'Capsule', '50mg', 10, 'controlled', 0, 10, 900, 720],
  ['Dettol Antiseptic', 'Chloroxylenol', '8964000100127', 'Liquid', '250ml', 1, 'otc', 1800, 10, 45000, 38000],
  ['Surgical Mask', null, '8964000100134', 'Mask', '3-ply', 50, 'otc', 1800, 100, 1000, 600],
]

await db.tx(async () => {
  const supplierId = await db.insert('suppliers', { name: 'City Pharma Distributors', phone: '042-00000000', address: 'Lahore', due_days: 0, opening_balance: 0, active: 1 })
  const purchaseId = await db.insert('purchases', {
    supplier_id: supplierId, invoice_no: 'DEMO-1', invoice_date: today(), payment_type: 'credit', due_date: today(), gross: 0, discount: 0, total: 0, user_id: admin.id,
  })
  let total = 0
  for (const [i, [name, generic, barcode, form, strength, pack, schedule, gst, reorder, price, cost]] of PRODUCTS.entries()) {
    const productId = await db.insert('products', {
      name, name_lc: name.toLowerCase(), generic_name: generic, barcode, form, strength, pack_size: pack, schedule, gst_rate_bps: gst,
      reorder_level: reorder, sale_price: price, pack_price: price * pack, allow_loose: 1, active: 1,
    })
    // Two batches each: one expiring soon, one later, so FEFO and expiry alerts are visible.
    for (const [suffix, months, qty] of [['A', 2 + (i % 3), 40], ['B', 18, 120]]) {
      const batchId = await db.insert('batches', {
        product_id: productId, batch_no: `DEMO${i + 1}${suffix}`, expiry_date: inMonths(months), cost_price: cost, sale_price: price,
        pack_price: price * pack, pack_size: pack, qty_on_hand: 0,
      })
      await db.insert('purchase_items', { purchase_id: purchaseId, batch_id: batchId, qty, cost_price: cost, line_total: qty * cost })
      await moveStock(db, { batchId, change: qty, reason: 'purchase', refId: purchaseId, userId: admin.id })
      total += qty * cost
    }
  }
  await db.col('purchases').updateOne({ _id: purchaseId }, { $set: { total, gross: total } })
})
console.log(`Seeded ${PRODUCTS.length} products with stock.`)
await db.client.close()
