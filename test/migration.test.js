import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { initDb } from '../src/db.js'

// The first release's tables, before pack pricing, supplier credit and tills existed.
const V1 = `
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, full_name TEXT NOT NULL,
  password_hash TEXT NOT NULL, role TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT);
CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT NOT NULL, generic_name TEXT, barcode TEXT UNIQUE,
  manufacturer TEXT, form TEXT, strength TEXT, pack_size INTEGER NOT NULL DEFAULT 1, category TEXT,
  schedule TEXT NOT NULL DEFAULT 'otc', gst_rate_bps INTEGER NOT NULL DEFAULT 0, reorder_level INTEGER NOT NULL DEFAULT 0,
  sale_price INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, created_at TEXT);
CREATE TABLE suppliers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT, address TEXT, ntn TEXT,
  drug_license_no TEXT, created_at TEXT);
CREATE TABLE batches (id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL, batch_no TEXT NOT NULL,
  expiry_date TEXT NOT NULL, cost_price INTEGER NOT NULL DEFAULT 0, sale_price INTEGER NOT NULL,
  qty_on_hand INTEGER NOT NULL DEFAULT 0, created_at TEXT, UNIQUE (product_id, batch_no));
INSERT INTO products (id, name, pack_size, sale_price) VALUES (1, 'Panadol', 10, 250);
INSERT INTO batches (product_id, batch_no, expiry_date, cost_price, sale_price, qty_on_hand) VALUES (1, 'A1', '2030-01-01', 190, 250, 40);
INSERT INTO suppliers (name) VALUES ('City Pharma');
`

test('a first-release database upgrades in place and keeps its data', () => {
  const db = new DatabaseSync(':memory:')
  db.exec(V1)
  initDb(db)
  initDb(db) // running again is a no-op

  const cols = (t) => db.prepare(`SELECT name FROM pragma_table_info('${t}')`).all().map((r) => r.name)
  for (const c of ['pack_price', 'packing', 'allow_loose', 'shelf_location']) assert.ok(cols('products').includes(c), c)
  for (const c of ['due_days', 'opening_balance']) assert.ok(cols('suppliers').includes(c), c)
  for (const t of ['supplier_payments', 'till_sessions', 'cash_movements', 'day_closes']) assert.ok(cols(t).length > 0, t)

  const p = db.prepare('SELECT * FROM products WHERE id = 1').get()
  assert.equal(p.pack_price, 2500, 'pack price backfilled from unit price x pack size')
  assert.equal(p.allow_loose, 1)
  const b = db.prepare('SELECT * FROM batches WHERE product_id = 1').get()
  assert.deepEqual([b.pack_size, b.pack_price, b.qty_on_hand], [10, 2500, 40])
  assert.equal(db.prepare('SELECT due_days FROM suppliers').get().due_days, 0)
  assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'default_margin_bps'").get().value, '1500')
})
