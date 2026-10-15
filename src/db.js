// All money is stored as integer paisa (1 PKR = 100 paisa) to avoid float rounding.
// All rates are stored as basis points (17% = 1700).
// Timestamps are local time 'YYYY-MM-DD HH:MM:SS' (see configureClock in store.js).
// Data lives in MongoDB (see store.js); each collection keeps the fields the SQL tables had.
export { configureClock, today, nowStamp } from './store.js'
import { withSession } from './store.js'
import { SYSTEM_ROLES } from './lib/permissions.js'

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
  loyalty_points_per_100rs: '1',       // points earned per Rs 100 of an account/loyalty sale
  loyalty_point_value_paisa: '100',    // paisa credited per point redeemed (100 = Rs 1/point)
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

// Indexes: uniqueness the SQL schema enforced, plus the lookups the app makes often.
const INDEXES = {
  users: [[{ username_lc: 1 }, { unique: true }]],
  products: [
    [{ barcode: 1 }, { unique: true, partialFilterExpression: { barcode: { $type: 'string' } } }],
    [{ name: 1 }], [{ generic_name: 1 }], [{ name_lc: 1 }], [{ active: 1, name: 1 }], [{ active: 1, pack_price: 1 }],
    [{ active: 1, reorder_level: 1 }],
  ],
  batches: [[{ product_id: 1, batch_no: 1 }, { unique: true }], [{ product_id: 1, expiry_date: 1 }], [{ expiry_date: 1, qty_on_hand: 1 }]],
  purchases: [[{ supplier_id: 1, created_at: 1 }], [{ created_at: 1 }]],
  purchase_items: [[{ purchase_id: 1 }], [{ batch_id: 1 }]],
  sales: [[{ invoice_no: 1 }, { unique: true }], [{ offline_id: 1 }, { unique: true, partialFilterExpression: { offline_id: { $type: 'string' } } }], [{ created_at: 1 }], [{ till_session_id: 1 }], [{ user_id: 1, created_at: 1 }], [{ customer_id: 1, payment_method: 1 }]],
  sale_items: [[{ sale_id: 1 }], [{ product_id: 1 }], [{ created_at: 1 }]],
  returns: [[{ sale_id: 1 }], [{ created_at: 1 }], [{ till_session_id: 1 }]],
  return_items: [[{ return_id: 1 }], [{ sale_item_id: 1 }], [{ created_at: 1 }]],
  stock_movements: [[{ product_id: 1, created_at: 1 }], [{ batch_id: 1 }], [{ created_at: 1 }]],
  supplier_payments: [[{ supplier_id: 1, paid_on: 1 }], [{ purchase_id: 1 }], [{ till_session_id: 1 }]],
  till_sessions: [
    [{ user_id: 1, status: 1 }], [{ business_date: 1 }],
    // One open till per user, even when two tabs open one at the same moment.
    [{ user_id: 1 }, { name: 'one_open_till', unique: true, partialFilterExpression: { status: 'open' } }],
  ],
  cash_movements: [[{ till_session_id: 1 }]],
  audit_log: [[{ created_at: -1 }]],
  departments: [[{ name_lc: 1 }, { unique: true }]],
  issue_requests: [[{ department_id: 1 }], [{ status: 1 }]],
  issue_request_items: [[{ request_id: 1 }]],
  issues: [[{ issue_no: 1 }, { unique: true }], [{ department_id: 1, created_at: 1 }], [{ created_at: 1 }], [{ request_id: 1 }]],
  issue_items: [[{ issue_id: 1 }], [{ request_item_id: 1 }], [{ department_id: 1, created_at: 1 }]],
  issue_returns: [[{ issue_id: 1 }], [{ created_at: 1 }]],
  issue_return_items: [[{ issue_return_id: 1 }], [{ issue_item_id: 1 }]],
  assistant_conversations: [[{ user_id: 1, updated_at: -1 }]],
  day_closes: [[{ business_date: 1 }, { unique: true }]],
  demand_lists: [[{ status: 1, id: -1 }], [{ supplier_id: 1, id: -1 }]],
  roles: [[{ key: 1 }, { unique: true }]],
  customers: [[{ name: 1 }], [{ phone: 1 }]],
  customer_payments: [[{ customer_id: 1, paid_on: 1 }], [{ sale_id: 1 }], [{ till_session_id: 1 }]],
  purchase_orders: [[{ status: 1, id: -1 }], [{ supplier_id: 1, id: -1 }]],
  purchase_order_items: [[{ purchase_order_id: 1 }]],
  locations: [[{ name: 1 }, { unique: true }]],
  stock_transfers: [[{ status: 1, id: -1 }], [{ from_location_id: 1 }], [{ to_location_id: 1 }]],
  stock_transfer_items: [[{ transfer_id: 1 }]],
  employees: [[{ user_id: 1 }, { unique: true, partialFilterExpression: { user_id: { $type: 'number' } } }], [{ full_name: 1 }]],
  appointments: [[{ with_user_id: 1, starts_at: 1 }], [{ starts_at: 1 }], [{ customer_id: 1 }]],
  messages: [[{ from_user_id: 1, to_user_id: 1, created_at: 1 }], [{ to_user_id: 1, read: 1 }]],
  knowledge_articles: [[{ title: 1 }], [{ tags: 1 }]],
}

// Creates indexes and default settings, and makes sure there is an owner. Safe on every start.
export async function initDb(store) {
  for (const [name, list] of Object.entries(INDEXES)) {
    await store.db.collection(name).createIndexes(list.map(([key, opts = {}]) => ({ key, ...opts })))
  }
  const settings = store.col('settings').raw
  await settings.bulkWrite(
    Object.entries(DEFAULT_SETTINGS).map(([k, v]) => ({
      updateOne: { filter: { _id: k }, update: { $setOnInsert: { value: v } }, upsert: true },
    })),
  )
  // Seed the 3 system roles (never overwritten once created, so an admin's own edits to a
  // role's permissions survive a restart). is_system roles can't be deleted (see roles.routes.js).
  const roles = store.col('roles')
  for (const sr of SYSTEM_ROLES) {
    if (!(await roles.findOne({ key: sr.key }))) {
      await store.insert('roles', { key: sr.key, name: sr.name, base_role: sr.base_role, is_system: 1, permissions: sr.permissions })
    }
  }

  // The first admin becomes the owner when no owner has been marked yet.
  const users = store.col('users')
  if (!(await users.findOne({ is_owner: 1 }))) {
    const first = await users.findOne({ role: 'admin', active: 1 }, { sort: { id: 1 } })
    if (first) await users.updateOne({ _id: first.id }, { $set: { is_owner: 1 } })
  }

  // One-time migration: point every user created before the roles system existed at the system
  // role matching its old `role` string.
  const withoutRoleId = await users.find({ role_id: { $exists: false } }, { projection: { id: 1, role: 1 } }).toArray()
  if (withoutRoleId.length) {
    const byKey = Object.fromEntries((await roles.find({ is_system: 1 }, { projection: { id: 1, key: 1 } }).toArray()).map((r) => [r.key, r.id]))
    for (const u of withoutRoleId) {
      await users.updateOne({ _id: u.id }, { $set: { role_id: byKey[u.role] || byKey.cashier } })
    }
  }
  return store
}

// The id of one of the 3 built-in system roles (e.g. to assign a role to a brand-new user).
export async function systemRoleId(store, key) {
  const row = await store.col('roles').findOne({ key, is_system: 1 }, { projection: { id: 1 } })
  return row?.id ?? null
}

// Settings only the owner may change (with password confirmation).
export const PROTECTED_SETTINGS = [
  'require_open_till', 'refund_card_sales', 'opening_balance_due',
  'max_discount_cashier_bps', 'max_discount_pharmacist_bps', 'max_discount_admin_bps',
  'assistant_enabled',
]

// A fresh copy each call (callers may change it); read from a short cache cleared on every settings write.
export async function getSettings(store) {
  const all = await store.cached('settings', 'all', 60000, async () => {
    const rows = await store.col('settings').raw.find({}, withSession()).toArray()
    return Object.fromEntries(rows.map((r) => [r._id, r.value]))
  })
  return { ...all }
}

export async function getSetting(store, key) {
  return (await getSettings(store))[key] ?? null
}

export async function setSetting(store, key, value) {
  await store.col('settings').updateOne({ _id: key }, { $set: { value: String(value) } }, { upsert: true })
}
