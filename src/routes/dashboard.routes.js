import { Router } from 'express'
import { today, getSettings } from '../db.js'
import { openTillFor, tillTotals } from '../lib/till.js'
import { supplierDues, addDays } from '../lib/supplier-ledger.js'

// Role-based home dashboard. See docs/API-CONTRACT.md (Round 3).
// cashier: own till and sales only. pharmacist: + store sales, stock alerts, requisitions.
// admin: + profit, cash in tills, supplier dues, stock value, 7-day chart. owner: + recent audit.

// Sales are filtered on created_at ranges ('YYYY-MM-DD' <= created_at < next day) so the index is used;
// this is the same as date(created_at) = day.
const dayRange = (from, to) => ({ from, next: addDays(to, 1) })

function myTill(db, userId) {
  const till = openTillFor(db, userId)
  return till ? { session: till, totals: tillTotals(db, till.id) } : null
}

// Per-day sales for [from, to] with zero days filled in.
function salesByDay(db, from, to) {
  const rows = db.prepare(
    `SELECT substr(s.created_at, 1, 10) AS day, COUNT(*) AS invoices, COALESCE(SUM(s.total), 0) AS total,
       COALESCE(SUM(s.tax), 0) AS tax, COUNT(s.prescription_id) AS prescriptions,
       SUM(EXISTS (SELECT 1 FROM sale_items si JOIN products p ON p.id = si.product_id
                   WHERE si.sale_id = s.id AND p.schedule = 'controlled')) AS controlled
     FROM sales s WHERE s.created_at >= :from AND s.created_at < :next GROUP BY day`,
  ).all(dayRange(from, to))
  const byDay = new Map(rows.map((r) => [r.day, r]))
  const out = []
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const r = byDay.get(d)
    out.push({ day: d, invoices: r?.invoices || 0, total: r?.total || 0, tax: r?.tax || 0,
      prescriptions: r?.prescriptions || 0, controlled: r?.controlled || 0 })
  }
  return out
}

// Gross profit on goods for one day, same formula as /reports/summary (excludes GST).
function grossProfit(db, day, sales) {
  const p = dayRange(day, day)
  const cost = db.prepare(
    `SELECT COALESCE(SUM(si.unit_cost * si.qty), 0) AS v FROM sale_items si JOIN sales s ON s.id = si.sale_id
     WHERE s.created_at >= :from AND s.created_at < :next`,
  ).get(p).v
  const ret = db.prepare(
    `SELECT COALESCE(SUM(ri.tax), 0) AS tax, COALESCE(SUM(si.unit_cost * ri.qty), 0) AS cost
     FROM return_items ri JOIN returns r ON r.id = ri.return_id JOIN sale_items si ON si.id = ri.sale_item_id
     WHERE r.created_at >= :from AND r.created_at < :next`,
  ).get(p)
  const refunds = db.prepare('SELECT COALESCE(SUM(refund_total), 0) AS v FROM returns WHERE created_at >= :from AND created_at < :next').get(p).v
  return (sales.total - refunds) - (sales.tax - ret.tax) - (cost - ret.cost)
}

export default function dashboardRoutes(db) {
  const r = Router()

  r.get('/', (req, res) => {
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
    cards.my_till = myTill(db, userId)
    cards.my_sales_today = db.prepare(
      `SELECT COUNT(*) AS invoices, COALESCE(SUM(total), 0) AS total FROM sales
       WHERE user_id = :uid AND created_at >= :from AND created_at < :next`,
    ).get({ ...tr, uid: userId })
    // Cashiers see only their own sales; supervisors see the latest across the pharmacy.
    lists.recent_sales = db.prepare(
      `SELECT s.id, s.invoice_no, s.created_at, s.customer_name, s.payment_method, s.total, s.prescription_id,
         u.full_name AS cashier_name
       FROM sales s JOIN users u ON u.id = s.user_id ${staff ? '' : 'WHERE s.user_id = ?'} ORDER BY s.created_at DESC, s.id DESC LIMIT 10`,
    ).all(...(staff ? [] : [userId]))

    if (staff) {
      const days = salesByDay(db, addDays(t, -6), t)
      const td = days[6]
      const yd = days[5]
      cards.sales_today = { invoices: td.invoices, total: td.total, prescriptions: td.prescriptions, controlled: td.controlled }

      // Stock alerts. Stock counts only unexpired batches, as /reports/low-stock does.
      const nearDays = Number(getSettings(db).near_expiry_days) || 90
      const ep = { today: t, near: `+${nearDays} days` }
      const stockCte = `WITH st AS (SELECT product_id, SUM(qty_on_hand) AS stock FROM batches
        WHERE expiry_date >= :today AND qty_on_hand > 0 GROUP BY product_id)`
      const prod = db.prepare(
        `${stockCte} SELECT
           COALESCE(SUM(COALESCE(p.pack_price, 0) = 0), 0) AS unpriced,
           COALESCE(SUM(COALESCE(p.pack_price, 0) = 0 AND COALESCE(st.stock, 0) > 0), 0) AS unpriced_in_stock,
           COALESCE(SUM(p.reorder_level > 0 AND COALESCE(st.stock, 0) <= p.reorder_level), 0) AS low_stock
         FROM products p LEFT JOIN st ON st.product_id = p.id WHERE p.active = 1`,
      ).get({ today: t })
      const exp = db.prepare(
        `SELECT COALESCE(SUM(expiry_date >= :today AND expiry_date <= date(:today, :near)), 0) AS near_expiry,
           COALESCE(SUM(expiry_date < :today), 0) AS expired
         FROM batches WHERE qty_on_hand > 0`,
      ).get(ep)
      cards.alerts = {
        low_stock: prod.low_stock, near_expiry: exp.near_expiry, expired: exp.expired,
        unpriced_items: prod.unpriced, unpriced_in_stock: prod.unpriced_in_stock, near_expiry_days: nearDays,
      }
      cards.open_requisitions = db.prepare("SELECT COUNT(*) AS v FROM issue_requests WHERE status IN ('open', 'partial')").get().v
      lists.expiring_soon = db.prepare(
        `SELECT b.id, b.product_id, p.name AS product_name, p.strength, b.batch_no, b.expiry_date, b.qty_on_hand,
           CAST(julianday(b.expiry_date) - julianday(:today) AS INTEGER) AS days_to_expiry
         FROM batches b JOIN products p ON p.id = b.product_id
         WHERE b.qty_on_hand > 0 AND b.expiry_date >= :today AND b.expiry_date <= date(:today, :near)
         ORDER BY b.expiry_date, p.name LIMIT 10`,
      ).all(ep)
      lists.low_stock = db.prepare(
        `${stockCte} SELECT p.id, p.name, p.strength, p.form, p.pack_size, p.reorder_level, COALESCE(st.stock, 0) AS stock
         FROM products p LEFT JOIN st ON st.product_id = p.id
         WHERE p.active = 1 AND p.reorder_level > 0 AND COALESCE(st.stock, 0) <= p.reorder_level
         ORDER BY stock, p.name LIMIT 10`,
      ).all({ today: t })

      if (admin) {
        cards.sales_yesterday = { invoices: yd.invoices, total: yd.total }
        cards.gross_profit_today = grossProfit(db, t, td)
        const open = db.prepare("SELECT id FROM till_sessions WHERE status = 'open'").all()
        cards.cash_in_open_tills = {
          tills: open.length,
          expected_cash: open.reduce((s, x) => s + (tillTotals(db, x.id)?.expected_cash || 0), 0),
        }
        const dues = [...supplierDues(db).values()]
        cards.supplier_dues = {
          balance: dues.reduce((s, d) => s + d.balance, 0),
          overdue: dues.reduce((s, d) => s + d.overdue, 0),
          suppliers_overdue: dues.filter((d) => d.overdue > 0).length,
        }
        cards.stock_value = db.prepare(
          `SELECT COALESCE(SUM(qty_on_hand * cost_price), 0) AS cost, COALESCE(SUM(qty_on_hand * sale_price), 0) AS retail
           FROM batches WHERE qty_on_hand > 0 AND expiry_date >= ?`,
        ).get(t)
        cards.issues_today = db.prepare(
          'SELECT COUNT(*) AS count, COALESCE(SUM(total_cost), 0) AS cost FROM issues WHERE created_at >= :from AND created_at < :next',
        ).get(tr)
        charts.sales_7d = days.map((d) => ({ day: d.day, total: d.total, invoices: d.invoices }))
        lists.top_products_today = db.prepare(
          `SELECT p.id, p.name, p.strength, SUM(si.qty - si.returned_qty) AS qty, SUM(si.line_total) AS revenue
           FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN products p ON p.id = si.product_id
           WHERE s.created_at >= :from AND s.created_at < :next GROUP BY p.id ORDER BY revenue DESC LIMIT 5`,
        ).all(tr)
      }
    }

    if (admin && isOwner) {
      lists.recent_audit = db.prepare(
        `SELECT a.id, a.created_at, a.action, a.detail, u.full_name AS user_name
         FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 5`,
      ).all().map((row) => {
        let detail = row.detail
        try { detail = row.detail ? JSON.parse(row.detail) : null } catch { /* keep raw text */ }
        return { ...row, detail }
      })
    }

    res.json({ role, is_owner: isOwner, date: t, cards, lists, charts })
  })

  return r
}
