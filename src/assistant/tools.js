// Tools the in-app assistant can use. Each one calls this app's own API in-process as the signed-in
// user (see internal.js), so route validation and role checks always apply. Money in tool inputs and
// outputs is rupees (the API itself uses paisa).
// kind 'read' runs automatically; kind 'write' changes data and only runs after the user approves.
import { HttpError } from '../lib/http.js'
import { today } from '../db.js'

const ALL = ['admin', 'pharmacist', 'cashier']
const STAFF = ['admin', 'pharmacist']
const ADMIN = ['admin']

const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false })
const str = (description) => ({ type: 'string', description })
const num = (description) => ({ type: 'number', description })
const int = (description) => ({ type: 'integer', description })
const FROM = str('Start date YYYY-MM-DD; default today')
const TO = str('End date YYYY-MM-DD; default same as from')
const PRODUCT = str('Item code (e.g. ph5152), barcode or exact name')

const bad = (msg) => new HttpError(400, msg)
const rupees = (paisa) => (paisa == null ? null : Math.round(Number(paisa)) / 100)
function toPaisa(rs, label) {
  const n = Number(rs)
  if (!Number.isFinite(n) || n < 0) throw bad(`${label} must be an amount in rupees`)
  return Math.round(n * 100)
}
const fmtRs = (paisa) =>
  'Rs ' + (Number(paisa || 0) / 100).toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v))
function dates({ from, to }) {
  if (from && !isDate(from)) throw bad('from must be a date YYYY-MM-DD')
  if (to && !isDate(to)) throw bad('to must be a date YYYY-MM-DD')
  const f = from || today()
  return { from: f, to: to || f }
}
const qs = (params) => {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v))
  const s = p.toString()
  return s ? `?${s}` : ''
}
// "3 packs + 4" (units shown as packs where a pack has several units).
function packsText(units, packSize) {
  const ps = packSize || 1
  if (ps <= 1) return `${units} units`
  const packs = Math.floor(units / ps)
  const loose = units % ps
  return `${packs} pack${packs === 1 ? '' : 's'}${loose ? ` + ${loose} loose` : ''} (${units} units)`
}
const label = (p) => [p.barcode, p.name, p.strength, p.form].filter(Boolean).join(' ')
const SCHEDULE_TEXT = { otc: 'OTC', rx: 'Rx (prescription)', controlled: 'Controlled' }

// ── Lookups by human identifiers ────────────────────────────────────────────
async function findProduct(call, ref) {
  const s = String(ref ?? '').trim()
  if (!s) throw bad('Product is required')
  const rows = await call('GET', `/products${qs({ q: s, limit: 8 })}`)
  const lc = s.toLowerCase()
  const hit = rows.find((p) => p.barcode && p.barcode.toLowerCase() === lc) ||
    (rows.filter((p) => p.name.toLowerCase() === lc).length === 1 && rows.find((p) => p.name.toLowerCase() === lc)) ||
    (rows.length === 1 && rows[0])
  if (hit) return hit
  if (!rows.length && /^\d+$/.test(s)) {
    const byId = await call('GET', `/products/${s}`).catch(() => null)
    if (byId) return byId
  }
  if (!rows.length) throw new HttpError(404, `No product matches "${s}". Use search_products to find the item code.`)
  throw new HttpError(409, `"${s}" matches several products: ${rows.map(label).join('; ')}. Ask the user which one, then use its code.`)
}

async function findSupplier(call, ref) {
  const s = String(ref ?? '').trim().toLowerCase()
  if (!s) throw bad('Supplier is required')
  const all = await call('GET', '/suppliers')
  const hit = (/^\d+$/.test(s) && all.find((x) => String(x.id) === s)) ||
    all.find((x) => x.name.toLowerCase() === s)
  if (hit) return hit
  const matches = all.filter((x) => x.name.toLowerCase().includes(s) || (x.contact_person || '').toLowerCase().includes(s))
  if (matches.length === 1) return matches[0]
  if (!matches.length) throw new HttpError(404, `No supplier matches "${ref}". Use search_suppliers.`)
  throw new HttpError(409, `"${ref}" matches several suppliers: ${matches.slice(0, 8).map((x) => `#${x.id} ${x.name}`).join('; ')}. Ask the user which one.`)
}

async function findDepartment(call, ref, { activeOnly = true } = {}) {
  const s = String(ref ?? '').trim().toLowerCase()
  if (!s) throw bad('Department is required')
  const all = await call('GET', '/departments?all=1')
  const hit = (/^\d+$/.test(s) && all.find((d) => String(d.id) === s)) || all.find((d) => d.name.toLowerCase() === s)
  const matches = hit ? [hit] : all.filter((d) => d.name.toLowerCase().includes(s))
  if (matches.length === 1) {
    if (activeOnly && !matches[0].active) throw bad(`${matches[0].name} is not active`)
    return matches[0]
  }
  const names = all.filter((d) => d.active).map((d) => d.name).join(', ') || 'none yet'
  if (!matches.length) throw new HttpError(404, `No department matches "${ref}". Departments: ${names}.`)
  throw new HttpError(409, `"${ref}" matches several departments: ${matches.map((d) => d.name).join(', ')}. Ask the user which one.`)
}

const productView = (p, { cost = false } = {}) => ({
  id: p.id,
  code: p.barcode,
  name: p.name,
  generic: p.generic_name,
  strength: p.strength,
  form: p.form,
  schedule: p.schedule,
  pack_size: p.pack_size,
  packing: p.packing,
  loose_allowed: !!p.allow_loose,
  // The price charged now: the batch that sells next (FEFO), else the list price.
  pack_price_rs: rupees(p.current_pack_price ?? p.pack_price),
  list_pack_price_rs: rupees(p.pack_price),
  stock: packsText(p.stock ?? 0, p.pack_size),
  stock_units: p.stock ?? 0,
  next_expiry: p.next_expiry,
  shelf: p.shelf_location,
  reorder_level: p.reorder_level,
  ...(p.active === 0 && { inactive: true }),
  ...(cost && p.batches && {
    batches: p.batches.map((b) => ({
      batch_no: b.batch_no, expiry: b.expiry_date, stock: packsText(b.qty_on_hand, p.pack_size),
      pack_price_rs: rupees(b.pack_price ?? b.sale_price * (b.pack_size || p.pack_size || 1)),
      cost_per_unit_rs: rupees(b.cost_price),
    })),
  }),
})

// ── Tool definitions ───────────────────────────────────────────────────────
export const TOOLS = [
  {
    name: 'search_products', kind: 'read', roles: ALL, label: 'Searched medicines',
    description: 'Find medicines by name, generic name or item code. Returns stock (sellable, unexpired), current pack price, next expiry and schedule (otc/rx/controlled).',
    input_schema: obj({ query: str('Name, generic name or item code'), limit: int('Max results, default 10, at most 25') }, ['query']),
    async run({ query, limit = 10 }, { call }) {
      const rows = await call('GET', `/products${qs({ q: query, limit: Math.min(Math.max(Number(limit) || 10, 1), 25) })}`)
      return { count: rows.length, items: rows.map((p) => productView(p)) }
    },
  },
  {
    name: 'get_product', kind: 'read', roles: ALL, label: 'Checked medicine',
    description: 'One medicine with its batches in stock (batch no, expiry, quantity, price). Sold first-expiry-first-out.',
    input_schema: obj({ product: PRODUCT }, ['product']),
    async run({ product }, { call, user }) {
      const p = await findProduct(call, product)
      const full = await call('GET', `/products/${p.id}`)
      const v = productView(full, { cost: true })
      if (user.role === 'cashier') v.batches?.forEach((b) => delete b.cost_per_unit_rs)
      return v
    },
  },
  {
    name: 'sales_summary', kind: 'read', roles: STAFF, label: 'Checked sales',
    description: 'Sales totals for a date range: invoices, gross, discount, GST, returns, net sales, gross profit, by payment method and by cashier.',
    input_schema: obj({ from: FROM, to: TO }),
    async run(input, { call }) {
      const r = await call('GET', `/reports/summary${qs(dates(input))}`)
      return {
        from: r.from, to: r.to, invoices: r.sales.invoices,
        gross_rs: rupees(r.sales.gross), discount_rs: rupees(r.sales.discount), gst_rs: rupees(r.sales.tax),
        sales_total_rs: rupees(r.sales.total), returns: r.returns.count, returns_rs: rupees(r.returns.total),
        net_sales_rs: rupees(r.net_sales), gross_profit_rs: rupees(r.gross_profit), cash_in_drawer_rs: rupees(r.cash_in_drawer),
        by_payment: r.byPayment.map((b) => ({ method: b.payment_method, invoices: b.invoices, total_rs: rupees(b.total) })),
        by_cashier: r.byUser.map((b) => ({ name: b.full_name, invoices: b.invoices, total_rs: rupees(b.total) })),
        ...(r.byDay.length > 1 && { by_day: r.byDay.map((d) => ({ day: d.day, invoices: d.invoices, total_rs: rupees(d.total) })) }),
      }
    },
  },
  {
    name: 'list_sales', kind: 'read', roles: ALL, label: 'Looked up sales',
    description: 'Invoices in a date range, newest first (cashiers see only their own). Optional search by invoice no, customer name or phone.',
    input_schema: obj({ from: FROM, to: TO, query: str('Invoice no, customer name or phone') }),
    async run(input, { call }) {
      const rows = await call('GET', `/sales${qs({ ...dates(input), q: input.query })}`)
      return {
        count: rows.length,
        total_rs: rupees(rows.reduce((s, x) => s + x.total, 0)),
        invoices: rows.slice(0, 30).map((s) => ({
          invoice_no: s.invoice_no, time: s.created_at, total_rs: rupees(s.total), payment: s.payment_method,
          cashier: s.cashier_name, customer: s.customer_name || undefined, refunded_rs: s.refunded ? rupees(s.refunded) : undefined,
        })),
        ...(rows.length > 30 && { note: `Showing 30 of ${rows.length}` }),
      }
    },
  },
  {
    name: 'get_sale', kind: 'read', roles: ALL, label: 'Opened invoice',
    description: 'One invoice by invoice number: items, quantities, prices, payment, prescription and returns.',
    input_schema: obj({ invoice_no: str('Invoice number') }, ['invoice_no']),
    async run({ invoice_no }, { call }) {
      const s = await call('GET', `/sales/${encodeURIComponent(String(invoice_no).trim())}`)
      return {
        invoice_no: s.invoice_no, time: s.created_at, cashier: s.cashier_name, customer: s.customer_name,
        payment: s.payment_method, subtotal_rs: rupees(s.subtotal), discount_rs: rupees(s.discount), gst_rs: rupees(s.tax),
        total_rs: rupees(s.total), paid_rs: rupees(s.amount_paid),
        items: s.items.map((i) => ({
          product: [i.product_name, i.strength].filter(Boolean).join(' '), schedule: i.schedule, batch: i.batch_no,
          expiry: i.expiry_date, qty: packsText(i.qty, i.pack_size), line_total_rs: rupees(i.line_total), returned_units: i.returned_qty || undefined,
        })),
        prescription: s.prescription ? { patient: s.prescription.patient_name, prescriber: s.prescription.prescriber_name } : null,
        returns: s.returns.map((r) => ({ time: r.created_at, refund_rs: rupees(r.refund_total), method: r.refund_method, reason: r.reason })),
      }
    },
  },
  {
    name: 'my_till', kind: 'read', roles: ALL, label: 'Checked my till',
    description: "The signed-in user's open till: opening cash, cash/card/wallet sales, refunds, cash in/out and expected cash in the drawer.",
    input_schema: obj({}),
    async run(_, { call }) {
      const r = await call('GET', '/tills/current')
      if (!r.session) return { open: false, message: 'No open till for this user.' }
      const t = r.totals
      return {
        open: true, opened_at: r.session.opened_at, business_date: r.session.business_date, invoices: t.invoices,
        opening_cash_rs: rupees(t.opening_cash), cash_sales_rs: rupees(t.cash_sales), card_sales_rs: rupees(t.card_sales),
        wallet_sales_rs: rupees(t.wallet_sales), cash_refunds_rs: rupees(t.refunds), cash_in_rs: rupees(t.cash_in),
        cash_out_rs: rupees(t.cash_out), expected_cash_rs: rupees(t.expected_cash),
      }
    },
  },
  {
    name: 'top_products', kind: 'read', roles: STAFF, label: 'Checked best sellers',
    description: 'Best-selling medicines by revenue in a date range.',
    input_schema: obj({ from: FROM, to: TO, limit: int('Default 10, at most 50') }),
    async run(input, { call }) {
      const rows = await call('GET', `/reports/top-products${qs(dates(input))}`)
      return rows.slice(0, Math.min(Number(input.limit) || 10, 50)).map((r) => ({
        name: [r.name, r.strength].filter(Boolean).join(' '), units: r.qty, revenue_rs: rupees(r.revenue), profit_rs: rupees(r.profit),
      }))
    },
  },
  {
    name: 'low_stock', kind: 'read', roles: STAFF, label: 'Checked low stock',
    description: 'Medicines at or below their reorder level (only items with a reorder level set).',
    input_schema: obj({}),
    async run(_, { call }) {
      const rows = await call('GET', '/reports/low-stock')
      return { count: rows.length, items: rows.slice(0, 40).map((r) => ({ name: [r.name, r.strength, r.form].filter(Boolean).join(' '), stock_units: r.stock, reorder_level: r.reorder_level })) }
    },
  },
  {
    name: 'expiring_stock', kind: 'read', roles: STAFF, label: 'Checked expiry',
    description: 'Batches in stock that are expired or expire within the given number of days (default: near-expiry setting, usually 90).',
    input_schema: obj({ days: int('Days ahead, e.g. 30, 90, 180') }),
    async run({ days }, { call }) {
      const rows = await call('GET', `/reports/expiry${qs({ days })}`)
      return {
        count: rows.length,
        expired_batches: rows.filter((r) => r.days_to_expiry < 0).length,
        cost_value_rs: rupees(rows.reduce((s, r) => s + r.cost_value, 0)),
        batches: rows.slice(0, 40).map((r) => ({
          product: [r.product_name, r.strength].filter(Boolean).join(' '), batch_no: r.batch_no, expiry: r.expiry_date,
          days_left: r.days_to_expiry, stock: packsText(r.qty_on_hand, r.pack_size), cost_value_rs: rupees(r.cost_value),
        })),
      }
    },
  },
  {
    name: 'stock_value', kind: 'read', roles: ADMIN, label: 'Checked stock value',
    description: 'Value of unexpired stock at cost and at retail, plus expired stock at cost, and the 10 items holding the most value.',
    input_schema: obj({}),
    async run(_, { call }) {
      const r = await call('GET', '/reports/stock-valuation')
      return {
        cost_value_rs: rupees(r.cost_value), retail_value_rs: rupees(r.retail_value), expired_cost_value_rs: rupees(r.expired_cost_value),
        items_in_stock: r.rows.length,
        top_items: r.rows.slice(0, 10).map((x) => ({ name: [x.name, x.strength].filter(Boolean).join(' '), units: x.qty, cost_value_rs: rupees(x.cost_value), retail_value_rs: rupees(x.retail_value) })),
      }
    },
  },
  {
    name: 'search_suppliers', kind: 'read', roles: STAFF, label: 'Searched suppliers',
    description: 'Find suppliers by name or contact person; shows how much we owe each (balance) and how much is overdue.',
    input_schema: obj({ query: str('Name or contact person; empty lists all') }),
    async run({ query = '' }, { call }) {
      const q = String(query).trim().toLowerCase()
      const rows = (await call('GET', '/suppliers')).filter((s) => !q || s.name.toLowerCase().includes(q) || (s.contact_person || '').toLowerCase().includes(q))
      return { count: rows.length, suppliers: rows.slice(0, 25).map((s) => ({ id: s.id, name: s.name, phone: s.phone, contact: s.contact_person, credit_days: s.due_days, owed_rs: rupees(s.balance), overdue_rs: rupees(s.overdue), active: !!s.active })) }
    },
  },
  {
    name: 'supplier_dues', kind: 'read', roles: STAFF, label: 'Checked supplier dues',
    description: 'What we owe each supplier, with ageing by days past due. Only suppliers with a balance.',
    input_schema: obj({}),
    async run(_, { call }) {
      const rows = await call('GET', '/reports/supplier-dues?owing=1')
      return {
        total_owed_rs: rupees(rows.reduce((s, r) => s + r.balance, 0)),
        total_overdue_rs: rupees(rows.reduce((s, r) => s + r.overdue, 0)),
        suppliers: rows.slice(0, 30).map((r) => ({
          id: r.supplier_id, name: r.name, owed_rs: rupees(r.balance), not_due_rs: rupees(r.not_due), overdue_rs: rupees(r.overdue),
          overdue_1_30_rs: rupees(r.d1_30), overdue_31_60_rs: rupees(r.d31_60), overdue_61_90_rs: rupees(r.d61_90), overdue_90_plus_rs: rupees(r.d90_plus),
          oldest_unpaid: r.oldest_unpaid_date,
        })),
      }
    },
  },
  {
    name: 'supplier_ledger', kind: 'read', roles: STAFF, label: 'Opened supplier ledger',
    description: "A supplier's account: opening balance, purchases (bills) and payments with running balance (owed).",
    input_schema: obj({ supplier: str('Supplier name or id'), from: str('YYYY-MM-DD, optional'), to: str('YYYY-MM-DD, optional') }, ['supplier']),
    async run({ supplier, from, to }, { call }) {
      const s = await findSupplier(call, supplier)
      if ((from && !isDate(from)) || (to && !isDate(to))) throw bad('Dates must be YYYY-MM-DD')
      const r = await call('GET', `/suppliers/${s.id}/ledger${qs({ from, to })}`)
      const entries = r.entries.slice(-25)
      return {
        supplier: r.supplier.name, owed_rs: rupees(r.balance), overdue_rs: rupees(r.supplier.overdue),
        entries: entries.map((e) => ({ date: e.date, type: e.type, ref: e.ref, description: e.description, billed_rs: rupees(e.debit) || undefined, paid_rs: rupees(e.credit) || undefined, balance_rs: rupees(e.balance) })),
        ...(r.entries.length > 25 && { note: `Last 25 of ${r.entries.length} entries` }),
      }
    },
  },
  {
    name: 'list_departments', kind: 'read', roles: STAFF, label: 'Checked departments',
    description: 'Hospital wards/departments that draw stock from the pharmacy.',
    input_schema: obj({}),
    async run(_, { call }) {
      return (await call('GET', '/departments?all=1')).map((d) => ({ id: d.id, name: d.name, incharge: d.incharge, active: !!d.active }))
    },
  },
  {
    name: 'department_usage', kind: 'read', roles: STAFF, label: 'Checked department usage',
    description: 'Stock issued to departments at cost in a date range. Without a department: one row per department; with one: per medicine.',
    input_schema: obj({ from: FROM, to: TO, department: str('Department name, optional') }),
    async run(input, { call }) {
      const d = input.department ? await findDepartment(call, input.department, { activeOnly: false }) : null
      const rows = await call('GET', `/reports/department-usage${qs({ ...dates(input), department_id: d?.id })}`)
      return d
        ? { department: d.name, items: rows.map((r) => ({ name: r.name, units_issued: r.qty_issued, units_returned: r.qty_returned, net_cost_rs: rupees(r.net_cost) })) }
        : rows.map((r) => ({ department: r.name, issues: r.issues, issued_rs: rupees(r.issued_cost), returned_rs: rupees(r.returned_cost), net_cost_rs: rupees(r.net_cost) }))
    },
  },
  {
    name: 'controlled_register', kind: 'read', roles: STAFF, label: 'Checked controlled register',
    description: 'Controlled-drug register: every stock movement of controlled medicines in a date range, with balance, patient/prescriber for sales, supplier for purchases, department for issues.',
    input_schema: obj({ from: FROM, to: TO, product: str('Item code or name, optional') }),
    async run(input, { call }) {
      const p = input.product ? await findProduct(call, input.product) : null
      const rows = await call('GET', `/reports/controlled-register${qs({ ...dates(input), product_id: p?.id })}`)
      return {
        count: rows.length,
        movements: rows.slice(-50).map((m) => ({
          time: m.created_at, product: [m.product_name, m.strength].filter(Boolean).join(' '), batch: m.batch_no, reason: m.reason,
          change: m.change, balance: m.balance, invoice: m.invoice_no || undefined, patient: m.patient_name || undefined,
          prescriber: m.prescriber_name || undefined, supplier: m.supplier_name || undefined, department: m.department_name || undefined, by: m.user_name,
        })),
        ...(rows.length > 50 && { note: `Last 50 of ${rows.length}` }),
      }
    },
  },

  // ── Actions (need approval) ───────────────────────────────────────────────
  {
    name: 'set_product_price', kind: 'write', roles: STAFF, label: 'Set pack price',
    description: "Set a medicine's list pack price in rupees (price of one full pack; the per-unit price follows). New stock is priced from it; batches already in stock keep their own price.",
    input_schema: obj({ product: PRODUCT, pack_price_rs: num('New price of one full pack in rupees') }, ['product', 'pack_price_rs']),
    async summary(i, { call }) {
      const p = await findProduct(call, i.product)
      const price = toPaisa(i.pack_price_rs, 'Pack price')
      if (price <= 0) throw bad('Pack price must be more than 0')
      const rows = [
        ['Medicine', label(p)],
        ['Pack size', `${p.pack_size} units${p.packing ? ` (${p.packing})` : ''}`],
        ['Current list pack price', fmtRs(p.pack_price)],
        ['New pack price', fmtRs(price)],
        ['Per unit', fmtRs(Math.round(price / (p.pack_size || 1)))],
      ]
      if (p.current_pack_price != null && p.current_pack_price !== price) rows.push(['Stock on hand', `keeps its batch price ${fmtRs(p.current_pack_price)}`])
      return rows
    },
    async run(i, { call }) {
      const p = await findProduct(call, i.product)
      const price = toPaisa(i.pack_price_rs, 'Pack price')
      const full = await call('GET', `/products/${p.id}`)
      const out = await call('PUT', `/products/${p.id}`, { ...full, pack_price: price })
      return { updated: true, product: label(out), pack_price_rs: rupees(out.pack_price), unit_price_rs: rupees(out.sale_price) }
    },
  },
  {
    name: 'set_product_schedule', kind: 'write', roles: STAFF, label: 'Set schedule',
    description: 'Mark one or more medicines (up to 25 at a time) as otc, rx (prescription only) or controlled. Use item codes from search_products.',
    input_schema: obj({
      products: { type: 'array', items: { type: 'string' }, description: 'Item codes or exact names, 1 to 25' },
      schedule: { type: 'string', enum: ['otc', 'rx', 'controlled'], description: 'New schedule' },
    }, ['products', 'schedule']),
    async summary(i, ctx) {
      const list = await scheduleTargets(i, ctx)
      return [
        ['New schedule', SCHEDULE_TEXT[i.schedule]],
        ...list.map((p, n) => [`Medicine ${n + 1}`, `${label(p)} (now ${SCHEDULE_TEXT[p.schedule]})`]),
      ]
    },
    async run(i, ctx) {
      const list = await scheduleTargets(i, ctx)
      const done = []
      for (const p of list) {
        const full = await ctx.call('GET', `/products/${p.id}`)
        await ctx.call('PUT', `/products/${p.id}`, { ...full, schedule: i.schedule })
        done.push(label(p))
      }
      return { updated: done.length, schedule: i.schedule, products: done }
    },
  },
  {
    name: 'record_supplier_payment', kind: 'write', roles: STAFF, label: 'Pay supplier',
    description: 'Record a payment made to a supplier (cash, bank or cheque). Amount in rupees. Not for till cash.',
    input_schema: obj({
      supplier: str('Supplier name or id'),
      amount_rs: num('Amount paid in rupees'),
      method: { type: 'string', enum: ['cash', 'bank', 'cheque'], description: 'Default cash' },
      reference: str('Cheque or transfer number'),
      paid_on: str('YYYY-MM-DD; default today'),
      note: str('Note'),
    }, ['supplier', 'amount_rs']),
    async summary(i, { call }) {
      const s = await findSupplier(call, i.supplier)
      const amount = paymentInput(i)
      return [
        ['Supplier', s.name], ['Owed now', fmtRs(s.balance)], ['Amount', fmtRs(amount)], ['Method', i.method || 'cash'],
        ['Reference', i.reference], ['Date', i.paid_on || today()], ['Owed after', fmtRs(s.balance - amount)], ['Note', i.note],
      ]
    },
    async run(i, { call }) {
      const s = await findSupplier(call, i.supplier)
      const amount = paymentInput(i)
      const p = await call('POST', `/suppliers/${s.id}/payments`, {
        amount, method: i.method || 'cash', reference: i.reference, paid_on: i.paid_on, note: i.note,
      })
      return { recorded: true, payment_id: p.id, supplier: p.supplier_name, amount_rs: rupees(p.amount), method: p.method, paid_on: p.paid_on }
    },
  },
  {
    name: 'create_department', kind: 'write', roles: STAFF, label: 'Add department',
    description: 'Add a hospital ward/department that can request and receive stock.',
    input_schema: obj({ name: str('Department name, e.g. Emergency, ICU, OT'), incharge: str('Person in charge') }, ['name']),
    async summary(i, { call }) {
      const name = String(i.name || '').trim()
      if (!name) throw bad('Department name is required')
      const all = await call('GET', '/departments?all=1')
      if (all.some((d) => d.name.toLowerCase() === name.toLowerCase())) throw new HttpError(409, `Department "${name}" already exists`)
      return [['Name', name], ['In charge', i.incharge]]
    },
    async run(i, { call }) {
      const d = await call('POST', '/departments', { name: String(i.name).trim(), incharge: i.incharge })
      return { created: true, department_id: d.id, name: d.name }
    },
  },
  {
    name: 'create_issue_request', kind: 'write', roles: STAFF, label: 'Department request',
    description: "Record a department's requisition (indent) for stock. Quantities in packs and/or loose units. This does not issue stock; it is issued later from the Issues screen.",
    input_schema: obj({
      department: str('Department name'),
      items: {
        type: 'array', description: 'Requested medicines',
        items: obj({ product: PRODUCT, packs: int('Full packs'), loose: int('Loose units') }, ['product']),
      },
      requested_by: str('Name on the requisition slip'),
      ref_no: str('Requisition number'),
      note: str('Note'),
    }, ['department', 'items']),
    async summary(i, ctx) {
      const { dept, lines } = await requestLines(i, ctx)
      return [
        ['Department', dept.name],
        ...lines.map(({ p, units }, n) => [`Item ${n + 1}`, `${label(p)}: ${packsText(units, p.pack_size)}; in stock ${packsText(p.stock ?? 0, p.pack_size)}`]),
        ['Requested by', i.requested_by], ['Ref no', i.ref_no], ['Note', i.note],
      ]
    },
    async run(i, ctx) {
      const { dept, lines } = await requestLines(i, ctx)
      const r = await ctx.call('POST', '/issue-requests', {
        department_id: dept.id, requested_by: i.requested_by, ref_no: i.ref_no, note: i.note,
        items: lines.map(({ p, units }) => ({ product_id: p.id, qty: units })),
      })
      return { created: true, request_id: r.id, department: r.department_name, items: r.items.length, status: r.status }
    },
  },
]

async function scheduleTargets(i, { call }) {
  const refs = Array.isArray(i.products) ? i.products.map((x) => String(x ?? '').trim()).filter(Boolean) : []
  if (!refs.length) throw bad('List at least one medicine')
  if (refs.length > 25) throw bad('At most 25 medicines at a time; split the list')
  if (!['otc', 'rx', 'controlled'].includes(i.schedule)) throw bad('schedule must be otc, rx or controlled')
  const list = []
  for (const ref of refs) {
    const p = await findProduct(call, ref)
    if (!list.some((x) => x.id === p.id)) list.push(p)
  }
  return list
}

function paymentInput(i) {
  if (i.method && !['cash', 'bank', 'cheque'].includes(i.method)) throw bad('Method must be cash, bank or cheque (till payments are made from the Suppliers screen)')
  if (i.paid_on && !isDate(i.paid_on)) throw bad('paid_on must be a date YYYY-MM-DD')
  const amount = toPaisa(i.amount_rs, 'Amount')
  if (amount <= 0) throw bad('Amount must be more than 0')
  return amount
}

async function requestLines(i, { call }) {
  const dept = await findDepartment(call, i.department)
  if (!Array.isArray(i.items) || !i.items.length) throw bad('Add at least one item')
  if (i.items.length > 40) throw bad('At most 40 items per request')
  const lines = []
  for (const it of i.items) {
    const p = await findProduct(call, it?.product)
    const packs = Number(it.packs ?? 0)
    const loose = Number(it.loose ?? 0)
    if (!Number.isInteger(packs) || !Number.isInteger(loose) || packs < 0 || loose < 0) throw bad(`${p.name}: packs and loose must be whole numbers`)
    const units = packs * (p.pack_size || 1) + loose
    if (units < 1) throw bad(`${p.name}: give a quantity in packs or loose units`)
    if (loose && !p.allow_loose) throw bad(`${p.name} is issued in full packs of ${p.pack_size} only`)
    lines.push({ p, units })
  }
  return { dept, lines }
}

export const toolsFor = (user) => TOOLS.filter((t) => t.roles.includes(user.role))
export const toolByName = (name) => TOOLS.find((t) => t.name === name)
export const allowedFor = (tool, user) => !!tool && tool.roles.includes(user.role)

// API-facing definitions (name/description/schema only).
export const apiTools = (user) => toolsFor(user).map(({ name, description, input_schema }) => ({ name, description, input_schema }))

// Models sometimes send null for an optional field; drop those so each tool's defaults apply.
const clean = (input) => Object.fromEntries(Object.entries(input || {}).filter(([, v]) => v !== null && v !== undefined && v !== ''))

export async function runReadTool(tool, input, ctx) {
  if (!allowedFor(tool, ctx.user)) throw new HttpError(403, 'Not permitted')
  return tool.run(clean(input), ctx)
}

export async function runWriteTool(tool, input, ctx) {
  if (!allowedFor(tool, ctx.user)) throw new HttpError(403, 'Your role is not allowed to do this')
  return tool.run(clean(input), ctx)
}

// Rows for the approval card; an error means the action can't work as asked (sent back to the model).
export async function describeWrite(tool, input, ctx) {
  try {
    const rows = await tool.summary(clean(input), ctx)
    return { details: rows.filter(([, v]) => v !== undefined && v !== null && v !== '').map(([l, v]) => [l, String(v)]) }
  } catch (err) {
    return { details: [], error: err.message }
  }
}
