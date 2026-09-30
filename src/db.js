// All money is stored as integer paisa (1 PKR = 100 paisa) to avoid float rounding.
// All rates are stored as basis points (17% = 1700).
// Timestamps are local time 'YYYY-MM-DD HH:MM:SS' (see configureClock).
// This module has no Node-only imports so it also runs on Cloudflare Workers; see db-node.js.

// SQLite modifier that turns UTC 'now' into pharmacy local time.
const clock = { sqlModifier: 'localtime', offsetMinutes: null }

// On servers whose clock is UTC (e.g. Cloudflare), pin the pharmacy's UTC offset explicitly.
// Pakistan is UTC+5 with no daylight saving, so a fixed offset is exact.
export function configureClock(utcOffsetMinutes) {
  const m = Number(utcOffsetMinutes)
  if (!Number.isFinite(m)) return
  clock.offsetMinutes = m
  clock.sqlModifier = `${m >= 0 ? '+' : '-'}${Math.abs(m)} minutes`
}

const schema = () => `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  full_name     TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin', 'pharmacist', 'cashier')),
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now', '${clock.sqlModifier}'))
);

CREATE TABLE IF NOT EXISTS products (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  generic_name  TEXT,
  barcode       TEXT UNIQUE,
  manufacturer  TEXT,
  form          TEXT,                 -- tablet, syrup, injection ...
  strength      TEXT,                 -- 500mg, 125mg/5ml ...
  pack_size     INTEGER NOT NULL DEFAULT 1,
  category      TEXT,
  schedule      TEXT NOT NULL DEFAULT 'otc' CHECK (schedule IN ('otc', 'rx', 'controlled')),
  gst_rate_bps  INTEGER NOT NULL DEFAULT 0,
  reorder_level INTEGER NOT NULL DEFAULT 0,
  sale_price    INTEGER NOT NULL DEFAULT 0,  -- default retail price per unit, tax inclusive
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now', '${clock.sqlModifier}'))
);
CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
CREATE INDEX IF NOT EXISTS idx_products_generic ON products(generic_name);

CREATE TABLE IF NOT EXISTS suppliers (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  phone      TEXT,
  address    TEXT,
  ntn        TEXT,
  drug_license_no TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now', '${clock.sqlModifier}'))
);

CREATE TABLE IF NOT EXISTS purchases (
  id           INTEGER PRIMARY KEY,
  supplier_id  INTEGER NOT NULL REFERENCES suppliers(id),
  invoice_no   TEXT,
  invoice_date TEXT,
  total        INTEGER NOT NULL DEFAULT 0,
  notes        TEXT,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (datetime('now', '${clock.sqlModifier}'))
);

CREATE TABLE IF NOT EXISTS batches (
  id           INTEGER PRIMARY KEY,
  product_id   INTEGER NOT NULL REFERENCES products(id),
  batch_no     TEXT NOT NULL,
  expiry_date  TEXT NOT NULL,          -- YYYY-MM-DD
  cost_price   INTEGER NOT NULL DEFAULT 0,  -- per unit
  sale_price   INTEGER NOT NULL,            -- per unit, tax inclusive (MRP)
  qty_on_hand  INTEGER NOT NULL DEFAULT 0 CHECK (qty_on_hand >= 0),
  created_at   TEXT NOT NULL DEFAULT (datetime('now', '${clock.sqlModifier}')),
  UNIQUE (product_id, batch_no)
);
CREATE INDEX IF NOT EXISTS idx_batches_fefo ON batches(product_id, expiry_date);

CREATE TABLE IF NOT EXISTS purchase_items (
  id          INTEGER PRIMARY KEY,
  purchase_id INTEGER NOT NULL REFERENCES purchases(id),
  batch_id    INTEGER NOT NULL REFERENCES batches(id),
  qty         INTEGER NOT NULL,
  cost_price  INTEGER NOT NULL,
  line_total  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS prescriptions (
  id                INTEGER PRIMARY KEY,
  patient_name      TEXT NOT NULL,
  patient_phone     TEXT,
  patient_cnic      TEXT,
  prescriber_name   TEXT NOT NULL,
  prescriber_reg_no TEXT,              -- PMDC registration number
  rx_date           TEXT,
  notes             TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now', '${clock.sqlModifier}'))
);

CREATE TABLE IF NOT EXISTS sales (
  id              INTEGER PRIMARY KEY,
  invoice_no      TEXT NOT NULL UNIQUE,
  user_id         INTEGER NOT NULL REFERENCES users(id),
  customer_name   TEXT,
  customer_phone  TEXT,
  prescription_id INTEGER REFERENCES prescriptions(id),
  subtotal        INTEGER NOT NULL,   -- sum of unit_price * qty
  discount        INTEGER NOT NULL,
  tax             INTEGER NOT NULL,   -- GST contained in the (inclusive) total
  round_off       INTEGER NOT NULL DEFAULT 0,
  total           INTEGER NOT NULL,   -- amount payable
  payment_method  TEXT NOT NULL CHECK (payment_method IN ('cash', 'card', 'wallet')),
  amount_paid     INTEGER NOT NULL,
  change_due      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now', '${clock.sqlModifier}'))
);
CREATE INDEX IF NOT EXISTS idx_sales_created ON sales(created_at);

CREATE TABLE IF NOT EXISTS sale_items (
  id            INTEGER PRIMARY KEY,
  sale_id       INTEGER NOT NULL REFERENCES sales(id),
  product_id    INTEGER NOT NULL REFERENCES products(id),
  batch_id      INTEGER NOT NULL REFERENCES batches(id),
  qty           INTEGER NOT NULL CHECK (qty > 0),
  unit_price    INTEGER NOT NULL,
  unit_cost     INTEGER NOT NULL DEFAULT 0,
  discount_bps  INTEGER NOT NULL DEFAULT 0,
  discount      INTEGER NOT NULL DEFAULT 0,
  gst_rate_bps  INTEGER NOT NULL DEFAULT 0,
  tax           INTEGER NOT NULL DEFAULT 0,
  line_total    INTEGER NOT NULL,
  returned_qty  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id);

CREATE TABLE IF NOT EXISTS returns (
  id           INTEGER PRIMARY KEY,
  sale_id      INTEGER NOT NULL REFERENCES sales(id),
  user_id      INTEGER NOT NULL REFERENCES users(id),
  reason       TEXT,
  refund_total INTEGER NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now', '${clock.sqlModifier}'))
);

CREATE TABLE IF NOT EXISTS return_items (
  id           INTEGER PRIMARY KEY,
  return_id    INTEGER NOT NULL REFERENCES returns(id),
  sale_item_id INTEGER NOT NULL REFERENCES sale_items(id),
  qty          INTEGER NOT NULL,
  amount       INTEGER NOT NULL,
  tax          INTEGER NOT NULL DEFAULT 0,
  restocked    INTEGER NOT NULL DEFAULT 1
);

-- Every change to batch stock goes through here; it is also the controlled-drug register.
CREATE TABLE IF NOT EXISTS stock_movements (
  id         INTEGER PRIMARY KEY,
  batch_id   INTEGER NOT NULL REFERENCES batches(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  change     INTEGER NOT NULL,
  balance    INTEGER NOT NULL,        -- batch qty_on_hand after this movement
  reason     TEXT NOT NULL CHECK (reason IN ('purchase', 'sale', 'return', 'adjustment', 'expired', 'damaged')),
  ref_id     INTEGER,                 -- purchase / sale / return id
  user_id    INTEGER NOT NULL REFERENCES users(id),
  note       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now', '${clock.sqlModifier}'))
);
CREATE INDEX IF NOT EXISTS idx_movements_product ON stock_movements(product_id, created_at);
`

const DEFAULT_SETTINGS = {
  pharmacy_name: 'My Pharmacy',
  address: '',
  phone: '',
  ntn: '',
  strn: '',
  drug_license_no: '',
  default_gst_rate_bps: '0',
  near_expiry_days: '90',
  round_to_rupee: '1',
  receipt_footer: 'Medicines once sold can be returned within 7 days with receipt, if unopened and stored properly.',
}

// Creates tables and default settings if they don't exist. Safe to run on every start.
export function initDb(db) {
  db.exec(schema())
  const insert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)')
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insert.run(k, v)
  return db
}

// Runs fn inside a write transaction; rolls back if it throws.
export function transaction(db, fn) {
  // Cloudflare Durable Object storage has its own transaction API and rejects BEGIN.
  if (db.transactionSync) return db.transactionSync(fn)
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

export function getSettings(db) {
  const rows = db.prepare('SELECT key, value FROM settings').all()
  return Object.fromEntries(rows.map((r) => [r.key, r.value]))
}

export function today() {
  if (clock.offsetMinutes !== null) {
    return new Date(Date.now() + clock.offsetMinutes * 60000).toISOString().slice(0, 10)
  }
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
