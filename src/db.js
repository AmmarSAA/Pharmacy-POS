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

// SQL expression for the current pharmacy-local timestamp, e.g. SELECT ${sqlNow()} AS t
export const sqlNow = () => `datetime('now', '${clock.sqlModifier}')`

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
  reason     TEXT NOT NULL CHECK (reason IN ('purchase', 'sale', 'return', 'adjustment', 'expired', 'damaged', 'issue', 'issue_return')),
  ref_id     INTEGER,                 -- purchase / sale / return id
  user_id    INTEGER NOT NULL REFERENCES users(id),
  note       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now', '${clock.sqlModifier}'))
);
CREATE INDEX IF NOT EXISTS idx_movements_product ON stock_movements(product_id, created_at);

-- Money paid to suppliers (and the automatic payment recorded for a cash purchase).
CREATE TABLE IF NOT EXISTS supplier_payments (
  id               INTEGER PRIMARY KEY,
  supplier_id      INTEGER NOT NULL REFERENCES suppliers(id),
  amount           INTEGER NOT NULL CHECK (amount > 0),
  method           TEXT NOT NULL CHECK (method IN ('cash', 'bank', 'cheque', 'till')),
  reference        TEXT,               -- cheque / transfer number
  paid_on          TEXT NOT NULL,      -- YYYY-MM-DD
  purchase_id      INTEGER REFERENCES purchases(id),
  till_session_id  INTEGER REFERENCES till_sessions(id),
  note             TEXT,
  user_id          INTEGER NOT NULL REFERENCES users(id),
  created_at       TEXT NOT NULL DEFAULT (datetime('now', '${clock.sqlModifier}'))
);
CREATE INDEX IF NOT EXISTS idx_supplier_payments ON supplier_payments(supplier_id, paid_on);

-- A cashier's shift at the counter: opening float, cash in/out, counted cash at close.
CREATE TABLE IF NOT EXISTS till_sessions (
  id               INTEGER PRIMARY KEY,
  user_id          INTEGER NOT NULL REFERENCES users(id),
  business_date    TEXT NOT NULL,      -- YYYY-MM-DD the till was opened for
  opening_cash     INTEGER NOT NULL DEFAULT 0,
  opening_notes    TEXT,               -- JSON { "5000": 1, "1000": 3, ... }
  opened_at        TEXT NOT NULL DEFAULT (datetime('now', '${clock.sqlModifier}')),
  closed_at        TEXT,
  expected_cash    INTEGER,
  counted_cash     INTEGER,
  closing_notes    TEXT,
  close_note       TEXT,
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed'))
);
CREATE INDEX IF NOT EXISTS idx_till_sessions_user ON till_sessions(user_id, status);

CREATE TABLE IF NOT EXISTS cash_movements (
  id               INTEGER PRIMARY KEY,
  till_session_id  INTEGER NOT NULL REFERENCES till_sessions(id),
  direction        TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  amount           INTEGER NOT NULL CHECK (amount > 0),
  reason           TEXT NOT NULL,
  notes            TEXT,               -- JSON note count, optional
  supplier_payment_id INTEGER REFERENCES supplier_payments(id),
  user_id          INTEGER NOT NULL REFERENCES users(id),
  created_at       TEXT NOT NULL DEFAULT (datetime('now', '${clock.sqlModifier}'))
);

-- Who changed what in owner-level settings and staff accounts.
CREATE TABLE IF NOT EXISTS audit_log (
  id               INTEGER PRIMARY KEY,
  user_id          INTEGER REFERENCES users(id),
  action           TEXT NOT NULL,
  detail           TEXT,               -- JSON
  created_at       TEXT NOT NULL DEFAULT (datetime('now', '${clock.sqlModifier}'))
);

-- Hospital wards/departments that draw stock from the pharmacy (MultiTec "Issue").
CREATE TABLE IF NOT EXISTS departments (
  id               INTEGER PRIMARY KEY,
  name             TEXT NOT NULL UNIQUE COLLATE NOCASE,
  incharge         TEXT,
  active           INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL DEFAULT (datetime('now', '${clock.sqlModifier}'))
);

-- A department's written request (indent/requisition) for stock.
CREATE TABLE IF NOT EXISTS issue_requests (
  id               INTEGER PRIMARY KEY,
  department_id    INTEGER NOT NULL REFERENCES departments(id),
  requested_by     TEXT,               -- name on the requisition slip
  ref_no           TEXT,
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'partial', 'closed', 'cancelled')),
  note             TEXT,
  user_id          INTEGER NOT NULL REFERENCES users(id),
  created_at       TEXT NOT NULL DEFAULT (datetime('now', '${clock.sqlModifier}'))
);

CREATE TABLE IF NOT EXISTS issue_request_items (
  id               INTEGER PRIMARY KEY,
  request_id       INTEGER NOT NULL REFERENCES issue_requests(id),
  product_id       INTEGER NOT NULL REFERENCES products(id),
  qty_requested    INTEGER NOT NULL CHECK (qty_requested > 0),   -- units
  qty_issued       INTEGER NOT NULL DEFAULT 0
);

-- Stock handed to a department. Valued at cost; no sale, no till.
CREATE TABLE IF NOT EXISTS issues (
  id               INTEGER PRIMARY KEY,
  issue_no         TEXT NOT NULL UNIQUE,
  department_id    INTEGER NOT NULL REFERENCES departments(id),
  request_id       INTEGER REFERENCES issue_requests(id),
  received_by      TEXT,
  patient_name     TEXT,               -- when issued for a named in-patient
  note             TEXT,
  total_cost       INTEGER NOT NULL DEFAULT 0,
  user_id          INTEGER NOT NULL REFERENCES users(id),
  created_at       TEXT NOT NULL DEFAULT (datetime('now', '${clock.sqlModifier}'))
);

CREATE TABLE IF NOT EXISTS issue_items (
  id               INTEGER PRIMARY KEY,
  issue_id         INTEGER NOT NULL REFERENCES issues(id),
  product_id       INTEGER NOT NULL REFERENCES products(id),
  batch_id         INTEGER NOT NULL REFERENCES batches(id),
  request_item_id  INTEGER REFERENCES issue_request_items(id),
  qty              INTEGER NOT NULL CHECK (qty > 0),
  unit_cost        INTEGER NOT NULL DEFAULT 0,
  line_cost        INTEGER NOT NULL DEFAULT 0,
  pack_size        INTEGER NOT NULL DEFAULT 1,
  returned_qty     INTEGER NOT NULL DEFAULT 0
);

-- Unused stock sent back by a department.
CREATE TABLE IF NOT EXISTS issue_returns (
  id               INTEGER PRIMARY KEY,
  issue_id         INTEGER NOT NULL REFERENCES issues(id),
  reason           TEXT,
  total_cost       INTEGER NOT NULL DEFAULT 0,
  user_id          INTEGER NOT NULL REFERENCES users(id),
  created_at       TEXT NOT NULL DEFAULT (datetime('now', '${clock.sqlModifier}'))
);

CREATE TABLE IF NOT EXISTS issue_return_items (
  id               INTEGER PRIMARY KEY,
  issue_return_id  INTEGER NOT NULL REFERENCES issue_returns(id),
  issue_item_id    INTEGER NOT NULL REFERENCES issue_items(id),
  qty              INTEGER NOT NULL CHECK (qty > 0),
  restocked        INTEGER NOT NULL DEFAULT 1
);

-- In-app assistant conversations (one row per conversation, per user).
CREATE TABLE IF NOT EXISTS assistant_conversations (
  id               INTEGER PRIMARY KEY,
  user_id          INTEGER NOT NULL REFERENCES users(id),
  title            TEXT NOT NULL,
  provider         TEXT NOT NULL,
  lang             TEXT NOT NULL DEFAULT 'en',
  status           TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'running', 'awaiting_approval')),
  messages         TEXT NOT NULL DEFAULT '[]',  -- provider-native history (JSON)
  transcript       TEXT NOT NULL DEFAULT '[]',  -- what the user sees (JSON)
  pending          TEXT,                        -- actions waiting for approval (JSON)
  steps_this_turn  INTEGER NOT NULL DEFAULT 0,
  retry_after_ms   INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (datetime('now', '${clock.sqlModifier}')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now', '${clock.sqlModifier}'))
);
CREATE INDEX IF NOT EXISTS idx_assistant_user ON assistant_conversations(user_id, updated_at);

CREATE TABLE IF NOT EXISTS day_closes (
  id               INTEGER PRIMARY KEY,
  business_date    TEXT NOT NULL UNIQUE,
  summary          TEXT NOT NULL,      -- JSON snapshot of the day's figures
  user_id          INTEGER NOT NULL REFERENCES users(id),
  created_at       TEXT NOT NULL DEFAULT (datetime('now', '${clock.sqlModifier}'))
);
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
  default_margin_bps: '1500',
  // Owner-only policy settings (see PROTECTED_SETTINGS)
  refund_card_sales: 'drawer',          // drawer: all refunds in cash | original: card/wallet sales back to card/wallet
  opening_balance_due: 'terms',         // terms: after the supplier's credit days | immediate
  max_discount_cashier_bps: '1000',
  max_discount_pharmacist_bps: '2500',
  max_discount_admin_bps: '10000',
  assistant_enabled: '1',               // in-app AI assistant on/off (owner)
  require_open_till: '1',
  default_sale_unit: 'pack',
  cash_denominations: '5000,1000,500,100,50,20,10,5,2,1',
  receipt_footer: 'Medicines once sold can be returned within 7 days with receipt, if unopened and stored properly.',
}

// Columns added after the first release. Applied to new and existing databases alike, so a
// fresh install and an upgraded live database end up with the same shape.
const ADDED_COLUMNS = {
  products: {
    pack_price: 'INTEGER',                       // price of one full pack, tax inclusive
    packing: 'TEXT',                             // Strip, Box, Bottle ...
    allow_loose: 'INTEGER NOT NULL DEFAULT 1',   // may be sold by single unit
    shelf_location: 'TEXT',
  },
  batches: {
    pack_price: 'INTEGER',                       // MRP per pack for this batch
    pack_size: 'INTEGER',                        // units per pack when the batch was received
  },
  suppliers: {
    due_days: 'INTEGER NOT NULL DEFAULT 0',      // credit terms
    opening_balance: 'INTEGER NOT NULL DEFAULT 0', // owed before using this system
    opening_date: 'TEXT',
    contact_person: 'TEXT',
    email: 'TEXT',
    active: 'INTEGER NOT NULL DEFAULT 1',
  },
  purchases: {
    payment_type: "TEXT NOT NULL DEFAULT 'credit'",
    due_date: 'TEXT',
    gross: 'INTEGER NOT NULL DEFAULT 0',
    discount: 'INTEGER NOT NULL DEFAULT 0',
  },
  purchase_items: {
    packs: 'INTEGER',
    loose_qty: 'INTEGER NOT NULL DEFAULT 0',
    bonus_qty: 'INTEGER NOT NULL DEFAULT 0',
    pack_cost: 'INTEGER',
    discount_bps: 'INTEGER NOT NULL DEFAULT 0',
    pack_price: 'INTEGER',
  },
  sale_items: {
    pack_size: 'INTEGER NOT NULL DEFAULT 1',
  },
  sales: {
    till_session_id: 'INTEGER',
  },
  returns: {
    till_session_id: 'INTEGER',
    refund_method: "TEXT NOT NULL DEFAULT 'cash'",   // cash from the drawer, or back to card/wallet
  },
  users: {
    is_owner: 'INTEGER NOT NULL DEFAULT 0',          // may change protected settings and admins
  },
}

function columnsOf(db, table) {
  return new Set(db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all().map((r) => r.name))
}

// Stock movements first shipped with a narrower reason CHECK. SQLite cannot alter a CHECK,
// so rebuild the table once when the old definition is found.
function widenMovementReasons(db) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'stock_movements'").get()
  if (!row || row.sql.includes("'issue'")) return
  const cols = 'id, batch_id, product_id, change, balance, reason, ref_id, user_id, note, created_at'
  const create = schema().match(/CREATE TABLE IF NOT EXISTS stock_movements \([\s\S]*?\n\);/)[0]
    .replace('CREATE TABLE IF NOT EXISTS stock_movements', 'CREATE TABLE stock_movements_new')
  transaction(db, () => {
    db.exec(create)
    db.exec(`INSERT INTO stock_movements_new (${cols}) SELECT ${cols.replace('created_at', `COALESCE(created_at, ${sqlNow()})`)} FROM stock_movements`)
    db.exec('DROP TABLE stock_movements')
    db.exec('ALTER TABLE stock_movements_new RENAME TO stock_movements')
    db.exec('CREATE INDEX IF NOT EXISTS idx_movements_product ON stock_movements(product_id, created_at)')
  })
}

function migrate(db) {
  widenMovementReasons(db)
  for (const [table, cols] of Object.entries(ADDED_COLUMNS)) {
    const have = columnsOf(db, table)
    for (const [col, ddl] of Object.entries(cols)) {
      if (!have.has(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`)
    }
  }
  // Pack prices for rows created before pack pricing existed.
  db.exec(`UPDATE products SET pack_price = sale_price * pack_size WHERE pack_price IS NULL`)
  db.exec(`UPDATE batches SET pack_size = COALESCE((SELECT pack_size FROM products p WHERE p.id = batches.product_id), 1)
           WHERE pack_size IS NULL`)
  db.exec(`UPDATE batches SET pack_price = sale_price * pack_size WHERE pack_price IS NULL`)
  // The first admin becomes the owner when no owner has been marked yet.
  db.exec(`UPDATE users SET is_owner = 1 WHERE id = (SELECT MIN(id) FROM users WHERE role = 'admin' AND active = 1)
           AND NOT EXISTS (SELECT 1 FROM users WHERE is_owner = 1)`)
}

// Creates tables and default settings if they don't exist, then migrates. Safe on every start.
export function initDb(db) {
  db.exec(schema())
  migrate(db)
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

// Settings only the owner may change (with password confirmation).
export const PROTECTED_SETTINGS = [
  'require_open_till', 'refund_card_sales', 'opening_balance_due',
  'max_discount_cashier_bps', 'max_discount_pharmacist_bps', 'max_discount_admin_bps',
  'assistant_enabled',
]

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
