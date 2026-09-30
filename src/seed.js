// Loads demo suppliers, products and stock into an empty database, for trying the app out.
// Run after creating the admin account: npm run seed
import { transaction } from './db.js'
import { openDb } from './db-node.js'
import { moveStock } from './lib/stock.js'

const db = openDb()
const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get()
if (!admin) {
  console.error('Create the admin account first (start the app and open it in a browser), then run the seed.')
  process.exit(1)
}
if (db.prepare('SELECT COUNT(*) AS n FROM products').get().n > 0) {
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

transaction(db, () => {
  const supplierId = Number(
    db.prepare("INSERT INTO suppliers (name, phone, address) VALUES ('City Pharma Distributors', '042-00000000', 'Lahore')")
      .run().lastInsertRowid,
  )
  const purchaseId = Number(
    db.prepare("INSERT INTO purchases (supplier_id, invoice_no, invoice_date, total, user_id) VALUES (?, 'DEMO-1', date('now'), 0, ?)")
      .run(supplierId, admin.id).lastInsertRowid,
  )
  let total = 0
  PRODUCTS.forEach(([name, generic, barcode, form, strength, pack, schedule, gst, reorder, price, cost], i) => {
    const productId = Number(
      db.prepare(
        `INSERT INTO products (name, generic_name, barcode, form, strength, pack_size, schedule, gst_rate_bps, reorder_level, sale_price)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(name, generic, barcode, form, strength, pack, schedule, gst, reorder, price).lastInsertRowid,
    )
    // Two batches each: one expiring soon, one later, so FEFO and expiry alerts are visible.
    for (const [suffix, months, qty] of [['A', 2 + (i % 3), 40], ['B', 18, 120]]) {
      const batchId = Number(
        db.prepare('INSERT INTO batches (product_id, batch_no, expiry_date, cost_price, sale_price) VALUES (?, ?, ?, ?, ?)')
          .run(productId, `DEMO${i + 1}${suffix}`, inMonths(months), cost, price).lastInsertRowid,
      )
      db.prepare('INSERT INTO purchase_items (purchase_id, batch_id, qty, cost_price, line_total) VALUES (?, ?, ?, ?, ?)')
        .run(purchaseId, batchId, qty, cost, qty * cost)
      moveStock(db, { batchId, change: qty, reason: 'purchase', refId: purchaseId, userId: admin.id })
      total += qty * cost
    }
  })
  db.prepare('UPDATE purchases SET total = ? WHERE id = ?').run(total, purchaseId)
})
console.log(`Seeded ${PRODUCTS.length} products with stock.`)
