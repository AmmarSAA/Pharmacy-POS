import { Router } from '../lib/router.js'
import { today, getSettings } from '../db.js'
import { openTillFor, tillTotals } from '../lib/till.js'
import { supplierDues, addDays, daysBetween } from '../lib/supplier-ledger.js'

// Role-based home dashboard. See docs/API-CONTRACT.md (Round 3).
// cashier: own till and sales only. pharmacist: + store sales, stock alerts, requisitions.
// admin: + profit, cash in tills, supplier dues, stock value, 7-day chart. owner: + recent audit.

// created_at ranges ('YYYY-MM-DD' <= created_at < next day) use the created_at indexes.
const dayRange = (from, to) => ({ created_at: { $gte: from, $lt: addDays(to, 1) } })

async function myTill(db, userId) {
  const till = await openTillFor(db, userId)
  return till ? { session: till, totals: await tillTotals(db, till.id) } : null
}

// Per-day sales for [from, to] with zero days filled in.
async function salesByDay(db, from, to) {
  const rows = await db.col('sales').aggregate([
    { $match: dayRange(from, to) },
    { $group: {
      _id: { $substrBytes: ['$created_at', 0, 10] }, invoices: { $sum: 1 }, total: { $sum: '$total' }, tax: { $sum: '$tax' },
      prescriptions: { $sum: { $cond: [{ $gt: ['$prescription_id', null] }, 1, 0] } },
      controlled: { $sum: { $ifNull: ['$has_controlled', 0] } },
    } },
  ]).toArray()
  const byDay = new Map(rows.map((r) => [r._id, r]))
  const out = []
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const r = byDay.get(d)
    out.push({ day: d, invoices: r?.invoices || 0, total: r?.total || 0, tax: r?.tax || 0,
      prescriptions: r?.prescriptions || 0, controlled: r?.controlled || 0 })
  }
  return out
}

// Gross profit on goods for one day, same formula as /reports/summary (excludes GST).
async function grossProfit(db, day, sales) {
  const when = dayRange(day, day)
  const cost = (await db.col('sale_items').aggregate([
    { $match: when }, { $group: { _id: null, v: { $sum: { $multiply: ['$unit_cost', '$qty'] } } } },
  ]).toArray())[0]?.v || 0
  const ret = (await db.col('return_items').aggregate([
    { $match: when }, { $group: { _id: null, tax: { $sum: '$tax' }, cost: { $sum: { $multiply: ['$unit_cost', '$qty'] } } } },
  ]).toArray())[0] || { tax: 0, cost: 0 }
  const refunds = await db.sum('returns', when, 'refund_total')
  return (sales.total - refunds) - (sales.tax - ret.tax) - (cost - ret.cost)
}

// Unexpired stock per product, for the given products.
async function stockFor(db, productIds, t) {
  const rows = await db.col('batches').aggregate([
    { $match: { product_id: { $in: productIds }, expiry_date: { $gte: t }, qty_on_hand: { $gt: 0 } } },
    { $group: { _id: '$product_id', q: { $sum: '$qty_on_hand' } } },
  ]).toArray()
  return new Map(rows.map((r) => [r._id, r.q]))
}

export default function dashboardRoutes(db) {
  const r = Router()

  r.get('/', async (req, res) => {
    const { role, id: userId } = req.user
    const isOwner = !!req.user.is_owner
    const staff = role === 'admin' || role === 'pharmacist'
    const admin = role === 'admin'
    const t = today()
    const tr = dayRange(t, t)
    const cards = {}
    const lists = {}
    const charts = {}

    // Everyone: own till and own sales today.
    cards.my_till = await myTill(db, userId)
    const mine = { ...tr, user_id: userId }
    cards.my_sales_today = { invoices: await db.col('sales').countDocuments(mine), total: await db.sum('sales', mine, 'total') }
    // Cashiers see only their own sales; supervisors see the latest across the pharmacy.
    const recent = await db.all('sales', staff ? {} : { user_id: userId }, {
      sort: { created_at: -1, id: -1 }, limit: 10,
      projection: { id: 1, invoice_no: 1, created_at: 1, customer_name: 1, payment_method: 1, total: 1, prescription_id: 1, user_id: 1 },
    })
    await db.join(recent, [{ key: 'user_id', from: 'users', fields: { cashier_name: 'full_name' } }])
    lists.recent_sales = recent.map(({ user_id, ...s }) => s)

    if (staff) {
      const days = await salesByDay(db, addDays(t, -6), t)
      const td = days[6]
      const yd = days[5]
      cards.sales_today = { invoices: td.invoices, total: td.total, prescriptions: td.prescriptions, controlled: td.controlled }

      // Stock alerts. Stock counts only unexpired batches, as /reports/low-stock does.
      const nearDays = Number((await getSettings(db)).near_expiry_days) || 90
      const nearLimit = addDays(t, nearDays)
      const products = db.col('products')
      const unpricedFilter = { active: 1, $or: [{ pack_price: 0 }, { pack_price: null }] }
      const unpriced = await products.countDocuments(unpricedFilter)
      // Items in stock without a price: only products that have stock can count, so start from batches.
      const inStock = await db.col('batches').distinct('product_id', { qty_on_hand: { $gt: 0 }, expiry_date: { $gte: t } })
      const unpricedInStock = await products.countDocuments({ ...unpricedFilter, _id: { $in: inStock } })
      const reorder = await db.all('products', { active: 1, reorder_level: { $gt: 0 } }, {
        projection: { id: 1, name: 1, strength: 1, form: 1, pack_size: 1, reorder_level: 1 },
      })
      const stock = await stockFor(db, reorder.map((p) => p.id), t)
      const low = reorder.map((p) => ({ ...p, stock: stock.get(p.id) || 0 })).filter((p) => p.stock <= p.reorder_level)
        .sort((a, b) => a.stock - b.stock || String(a.name).localeCompare(String(b.name)))
      const batches = db.col('batches')
      cards.alerts = {
        low_stock: low.length,
        near_expiry: await batches.countDocuments({ qty_on_hand: { $gt: 0 }, expiry_date: { $gte: t, $lte: nearLimit } }),
        expired: await batches.countDocuments({ qty_on_hand: { $gt: 0 }, expiry_date: { $lt: t } }),
        unpriced_items: unpriced, unpriced_in_stock: unpricedInStock, near_expiry_days: nearDays,
      }
      cards.open_requisitions = await db.col('issue_requests').countDocuments({ status: { $in: ['open', 'partial'] } })
      const expiring = await db.all('batches', { qty_on_hand: { $gt: 0 }, expiry_date: { $gte: t, $lte: nearLimit } }, {
        sort: { expiry_date: 1, id: 1 }, limit: 10, projection: { id: 1, product_id: 1, batch_no: 1, expiry_date: 1, qty_on_hand: 1 },
      })
      await db.join(expiring, [{ key: 'product_id', from: 'products', fields: { product_name: 'name', strength: 'strength' } }])
      lists.expiring_soon = expiring.map((b) => ({ ...b, days_to_expiry: daysBetween(t, b.expiry_date) }))
      lists.low_stock = low.slice(0, 10)

      if (admin) {
        cards.sales_yesterday = { invoices: yd.invoices, total: yd.total }
        cards.gross_profit_today = await grossProfit(db, t, td)
        const open = await db.all('till_sessions', { status: 'open' }, { projection: { id: 1 } })
        let expected = 0
        for (const x of open) expected += (await tillTotals(db, x.id))?.expected_cash || 0
        cards.cash_in_open_tills = { tills: open.length, expected_cash: expected }
        const dues = [...(await supplierDues(db)).values()]
        cards.supplier_dues = {
          balance: dues.reduce((s, d) => s + d.balance, 0),
          overdue: dues.reduce((s, d) => s + d.overdue, 0),
          suppliers_overdue: dues.filter((d) => d.overdue > 0).length,
        }
        const sv = (await batches.aggregate([
          { $match: { qty_on_hand: { $gt: 0 }, expiry_date: { $gte: t } } },
          { $group: { _id: null, cost: { $sum: { $multiply: ['$qty_on_hand', '$cost_price'] } }, retail: { $sum: { $multiply: ['$qty_on_hand', '$sale_price'] } } } },
        ]).toArray())[0]
        cards.stock_value = { cost: sv?.cost || 0, retail: sv?.retail || 0 }
        cards.issues_today = { count: await db.col('issues').countDocuments(tr), cost: await db.sum('issues', tr, 'total_cost') }
        charts.sales_7d = days.map((d) => ({ day: d.day, total: d.total, invoices: d.invoices }))
        const top = (await db.col('sale_items').aggregate([
          { $match: tr },
          { $group: { _id: '$product_id', qty: { $sum: { $subtract: ['$qty', '$returned_qty'] } }, revenue: { $sum: '$line_total' } } },
          { $sort: { revenue: -1 } }, { $limit: 5 },
        ]).toArray()).map((x) => ({ id: x._id, qty: x.qty, revenue: x.revenue }))
        await db.join(top, [{ key: 'id', from: 'products', fields: { name: 'name', strength: 'strength' } }])
        lists.top_products_today = top.map(({ id, name, strength, qty, revenue }) => ({ id, name, strength, qty, revenue }))
      }
    }

    if (admin && isOwner) {
      const audit = await db.all('audit_log', {}, { sort: { id: -1 }, limit: 5 })
      await db.join(audit, [{ key: 'user_id', from: 'users', fields: { user_name: 'full_name' } }])
      lists.recent_audit = audit.map((row) => {
        let detail = row.detail
        try { detail = row.detail ? JSON.parse(row.detail) : null } catch { /* keep raw text */ }
        return { id: row.id, created_at: row.created_at, action: row.action, detail, user_name: row.user_name }
      })
    }

    res.json({ role, is_owner: isOwner, date: t, cards, lists, charts })
  })

  return r
}
