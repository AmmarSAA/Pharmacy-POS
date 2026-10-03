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
  const [c, r, refunds] = await Promise.all([
    db.col('sale_items').aggregate([
      { $match: when }, { $group: { _id: null, v: { $sum: { $multiply: ['$unit_cost', '$qty'] } } } },
    ]).toArray(),
    db.col('return_items').aggregate([
      { $match: when }, { $group: { _id: null, tax: { $sum: '$tax' }, cost: { $sum: { $multiply: ['$unit_cost', '$qty'] } } } },
    ]).toArray(),
    db.sum('returns', when, 'refund_total'),
  ])
  const cost = c[0]?.v || 0
  const ret = r[0] || { tax: 0, cost: 0 }
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

    const sales = db.col('sales')
    const batches = db.col('batches')
    const products = db.col('products')
    const mine = { ...tr, user_id: userId }

    // Everything below is independent, so it runs in parallel (each query is a network round trip).
    const everyone = async () => {
      const [till, myCount, myTotal, recent] = await Promise.all([
        myTill(db, userId),
        sales.countDocuments(mine),
        db.sum('sales', mine, 'total'),
        db.all('sales', staff ? {} : { user_id: userId }, {
          sort: { created_at: -1, id: -1 }, limit: 10,
          projection: { id: 1, invoice_no: 1, created_at: 1, customer_name: 1, payment_method: 1, total: 1, prescription_id: 1, user_id: 1 },
        }),
      ])
      cards.my_till = till
      cards.my_sales_today = { invoices: myCount, total: myTotal }
      // Cashiers see only their own sales; supervisors see the latest across the pharmacy.
      await db.join(recent, [{ key: 'user_id', from: 'users', fields: { cashier_name: 'full_name' } }])
      lists.recent_sales = recent.map(({ user_id, ...x }) => x)
    }

    const staffPart = async () => {
      const settings = await getSettings(db)
      // Stock alerts. Stock counts only unexpired batches, as /reports/low-stock does.
      const nearDays = Number(settings.near_expiry_days) || 90
      const nearLimit = addDays(t, nearDays)
      const unpricedFilter = { active: 1, $or: [{ pack_price: 0 }, { pack_price: null }] }
      const [days, unpriced, inStock, reorder, nearCount, expiredCount, openReq, expiring] = await Promise.all([
        salesByDay(db, addDays(t, -6), t),
        products.countDocuments(unpricedFilter),
        batches.distinct('product_id', { qty_on_hand: { $gt: 0 }, expiry_date: { $gte: t } }),
        db.all('products', { active: 1, reorder_level: { $gt: 0 } }, {
          projection: { id: 1, name: 1, strength: 1, form: 1, pack_size: 1, reorder_level: 1 },
        }),
        batches.countDocuments({ qty_on_hand: { $gt: 0 }, expiry_date: { $gte: t, $lte: nearLimit } }),
        batches.countDocuments({ qty_on_hand: { $gt: 0 }, expiry_date: { $lt: t } }),
        db.col('issue_requests').countDocuments({ status: { $in: ['open', 'partial'] } }),
        db.all('batches', { qty_on_hand: { $gt: 0 }, expiry_date: { $gte: t, $lte: nearLimit } }, {
          sort: { expiry_date: 1, id: 1 }, limit: 10, projection: { id: 1, product_id: 1, batch_no: 1, expiry_date: 1, qty_on_hand: 1 },
        }),
      ])
      const [unpricedInStock, stock] = await Promise.all([
        // Items in stock without a price: only products that have stock can count.
        products.countDocuments({ ...unpricedFilter, _id: { $in: inStock } }),
        stockFor(db, reorder.map((x) => x.id), t),
        db.join(expiring, [{ key: 'product_id', from: 'products', fields: { product_name: 'name', strength: 'strength' } }]),
      ])
      const low = reorder.map((x) => ({ ...x, stock: stock.get(x.id) || 0 })).filter((x) => x.stock <= x.reorder_level)
        .sort((x, y) => x.stock - y.stock || String(x.name).localeCompare(String(y.name)))
      const td = days[6]
      cards.sales_today = { invoices: td.invoices, total: td.total, prescriptions: td.prescriptions, controlled: td.controlled }
      cards.alerts = {
        low_stock: low.length, near_expiry: nearCount, expired: expiredCount,
        unpriced_items: unpriced, unpriced_in_stock: unpricedInStock, near_expiry_days: nearDays,
      }
      cards.open_requisitions = openReq
      lists.expiring_soon = expiring.map((x) => ({ ...x, days_to_expiry: daysBetween(t, x.expiry_date) }))
      lists.low_stock = low.slice(0, 10)
      return days
    }

    const adminPart = async (daysPromise) => {
      const openTills = async () => {
        const open = await db.all('till_sessions', { status: 'open' }, { projection: { id: 1 } })
        const totals = await Promise.all(open.map((x) => tillTotals(db, x.id)))
        return { tills: open.length, expected_cash: totals.reduce((sum, x) => sum + (x?.expected_cash || 0), 0) }
      }
      const topToday = async () => {
        const top = (await db.col('sale_items').aggregate([
          { $match: tr },
          { $group: { _id: '$product_id', qty: { $sum: { $subtract: ['$qty', '$returned_qty'] } }, revenue: { $sum: '$line_total' } } },
          { $sort: { revenue: -1 } }, { $limit: 5 },
        ]).toArray()).map((x) => ({ id: x._id, qty: x.qty, revenue: x.revenue }))
        await db.join(top, [{ key: 'id', from: 'products', fields: { name: 'name', strength: 'strength' } }])
        return top.map(({ id, name, strength, qty, revenue }) => ({ id, name, strength, qty, revenue }))
      }
      const [days, tills, dues, sv, issueCount, issueCost, top] = await Promise.all([
        daysPromise,
        openTills(),
        supplierDues(db),
        batches.aggregate([
          { $match: { qty_on_hand: { $gt: 0 }, expiry_date: { $gte: t } } },
          { $group: { _id: null, cost: { $sum: { $multiply: ['$qty_on_hand', '$cost_price'] } }, retail: { $sum: { $multiply: ['$qty_on_hand', '$sale_price'] } } } },
        ]).toArray(),
        db.col('issues').countDocuments(tr),
        db.sum('issues', tr, 'total_cost'),
        topToday(),
      ])
      const td = days[6]
      const yd = days[5]
      cards.sales_yesterday = { invoices: yd.invoices, total: yd.total }
      cards.gross_profit_today = await grossProfit(db, t, td)
      cards.cash_in_open_tills = tills
      const all = [...dues.values()]
      cards.supplier_dues = {
        balance: all.reduce((sum, d) => sum + d.balance, 0),
        overdue: all.reduce((sum, d) => sum + d.overdue, 0),
        suppliers_overdue: all.filter((d) => d.overdue > 0).length,
      }
      cards.stock_value = { cost: sv[0]?.cost || 0, retail: sv[0]?.retail || 0 }
      cards.issues_today = { count: issueCount, cost: issueCost }
      charts.sales_7d = days.map((d) => ({ day: d.day, total: d.total, invoices: d.invoices }))
      lists.top_products_today = top
    }

    const ownerPart = async () => {
      const audit = await db.all('audit_log', {}, { sort: { id: -1 }, limit: 5 })
      await db.join(audit, [{ key: 'user_id', from: 'users', fields: { user_name: 'full_name' } }])
      lists.recent_audit = audit.map((row) => {
        let detail = row.detail
        try { detail = row.detail ? JSON.parse(row.detail) : null } catch { /* keep raw text */ }
        return { id: row.id, created_at: row.created_at, action: row.action, detail, user_name: row.user_name }
      })
    }

    const jobs = [everyone()]
    if (staff) {
      const days = staffPart()
      jobs.push(days)
      if (admin) jobs.push(adminPart(days))
    }
    if (admin && isOwner) jobs.push(ownerPart())
    await Promise.all(jobs)

    res.json({ role, is_owner: isOwner, date: t, cards, lists, charts })
  })

  return r
}
