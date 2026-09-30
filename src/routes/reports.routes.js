import { Router } from 'express'
import { requireRole } from '../auth.js'
import { today, getSettings } from '../db.js'
import { supplierDues } from '../lib/supplier-ledger.js'

function range(req) {
  const from = req.query.from || today()
  const to = req.query.to || from
  return { from, to }
}

export default function reportRoutes(db) {
  const r = Router()
  r.use(requireRole('admin', 'pharmacist'))

  // Sales summary for a date range, with payment and GST breakdowns.
  r.get('/summary', (req, res) => {
    const { from, to } = range(req)
    const p = { from, to }
    const sales = db.prepare(
      `SELECT COUNT(*) AS invoices, COALESCE(SUM(subtotal), 0) AS gross, COALESCE(SUM(discount), 0) AS discount,
         COALESCE(SUM(tax), 0) AS tax, COALESCE(SUM(round_off), 0) AS round_off, COALESCE(SUM(total), 0) AS total
       FROM sales WHERE date(created_at) BETWEEN :from AND :to`,
    ).get(p)
    const cost = db.prepare(
      `SELECT COALESCE(SUM(si.unit_cost * si.qty), 0) AS cost FROM sale_items si JOIN sales s ON s.id = si.sale_id
       WHERE date(s.created_at) BETWEEN :from AND :to`,
    ).get(p).cost
    const returns = db.prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(refund_total), 0) AS total,
         COALESCE((SELECT SUM(ri.tax) FROM return_items ri JOIN returns r2 ON r2.id = ri.return_id
                   WHERE date(r2.created_at) BETWEEN :from AND :to), 0) AS tax
       FROM returns WHERE date(created_at) BETWEEN :from AND :to`,
    ).get(p)
    const returnedCost = db.prepare(
      `SELECT COALESCE(SUM(si.unit_cost * ri.qty), 0) AS cost FROM return_items ri
       JOIN returns r2 ON r2.id = ri.return_id JOIN sale_items si ON si.id = ri.sale_item_id
       WHERE date(r2.created_at) BETWEEN :from AND :to`,
    ).get(p).cost
    const byPayment = db.prepare(
      `SELECT payment_method, COUNT(*) AS invoices, SUM(total) AS total FROM sales
       WHERE date(created_at) BETWEEN :from AND :to GROUP BY payment_method`,
    ).all(p)
    const byGstRate = db.prepare(
      `SELECT si.gst_rate_bps, SUM(si.line_total) AS sales, SUM(si.tax) AS tax FROM sale_items si
       JOIN sales s ON s.id = si.sale_id WHERE date(s.created_at) BETWEEN :from AND :to
       GROUP BY si.gst_rate_bps ORDER BY si.gst_rate_bps`,
    ).all(p)
    const byUser = db.prepare(
      `SELECT u.full_name, COUNT(*) AS invoices, SUM(s.total) AS total FROM sales s JOIN users u ON u.id = s.user_id
       WHERE date(s.created_at) BETWEEN :from AND :to GROUP BY u.id ORDER BY total DESC`,
    ).all(p)
    const byDay = db.prepare(
      `SELECT date(created_at) AS day, COUNT(*) AS invoices, SUM(total) AS total FROM sales
       WHERE date(created_at) BETWEEN :from AND :to GROUP BY day ORDER BY day`,
    ).all(p)
    const netSales = sales.total - returns.total
    res.json({
      from, to, sales, returns, byPayment, byGstRate, byUser, byDay,
      net_sales: netSales,
      net_tax: sales.tax - returns.tax,
      // Gross profit on goods (excludes GST): revenue net of tax minus cost of goods sold.
      gross_profit: netSales - (sales.tax - returns.tax) - (cost - returnedCost),
      // Cash expected in the drawer from this range.
      cash_in_drawer: (byPayment.find((b) => b.payment_method === 'cash')?.total || 0) - returns.total,
    })
  })

  r.get('/top-products', (req, res) => {
    const { from, to } = range(req)
    res.json(
      db.prepare(
        `SELECT p.id, p.name, p.strength, SUM(si.qty - si.returned_qty) AS qty,
           SUM(si.line_total) AS revenue, SUM(si.line_total - si.tax - si.unit_cost * si.qty) AS profit
         FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN products p ON p.id = si.product_id
         WHERE date(s.created_at) BETWEEN ? AND ? GROUP BY p.id ORDER BY revenue DESC LIMIT 50`,
      ).all(from, to),
    )
  })

  r.get('/low-stock', (req, res) => {
    res.json(
      db.prepare(
        `SELECT p.id, p.name, p.strength, p.form, p.reorder_level,
           COALESCE((SELECT SUM(qty_on_hand) FROM batches b WHERE b.product_id = p.id AND b.expiry_date >= :today), 0) AS stock
         FROM products p WHERE p.active = 1 AND p.reorder_level > 0
         AND stock <= p.reorder_level ORDER BY stock, p.name`,
      ).all({ today: today() }),
    )
  })

  r.get('/stock-valuation', (req, res) => {
    const t = today()
    const rows = db.prepare(
      `SELECT p.id, p.name, p.strength, SUM(b.qty_on_hand) AS qty,
         SUM(b.qty_on_hand * b.cost_price) AS cost_value, SUM(b.qty_on_hand * b.sale_price) AS retail_value
       FROM batches b JOIN products p ON p.id = b.product_id
       WHERE b.qty_on_hand > 0 AND b.expiry_date >= ? GROUP BY p.id ORDER BY cost_value DESC`,
    ).all(t)
    const expired = db.prepare(
      'SELECT COALESCE(SUM(qty_on_hand * cost_price), 0) AS v FROM batches WHERE qty_on_hand > 0 AND expiry_date < ?',
    ).get(t).v
    res.json({
      rows,
      cost_value: rows.reduce((s, r) => s + r.cost_value, 0),
      retail_value: rows.reduce((s, r) => s + r.retail_value, 0),
      expired_cost_value: expired,
    })
  })

  // Controlled-drug register: every movement of a controlled product with running batch balance
  // and, for sales, the patient and prescriber on record.
  r.get('/controlled-register', (req, res) => {
    const { from, to } = range(req)
    const params = { from, to }
    let extra = ''
    if (req.query.product_id) {
      extra = 'AND m.product_id = :pid'
      params.pid = Number(req.query.product_id)
    }
    res.json(
      db.prepare(
        `SELECT m.id, m.created_at, m.reason, m.change, m.balance, m.note, p.name AS product_name, p.strength,
           b.batch_no, b.expiry_date, u.full_name AS user_name,
           s.invoice_no, rx.patient_name, rx.patient_cnic, rx.prescriber_name, rx.prescriber_reg_no,
           su.name AS supplier_name, pu.invoice_no AS supplier_invoice
         FROM stock_movements m
         JOIN products p ON p.id = m.product_id JOIN batches b ON b.id = m.batch_id JOIN users u ON u.id = m.user_id
         LEFT JOIN sales s ON m.reason = 'sale' AND s.id = m.ref_id
         LEFT JOIN prescriptions rx ON rx.id = s.prescription_id
         LEFT JOIN purchases pu ON m.reason = 'purchase' AND pu.id = m.ref_id
         LEFT JOIN suppliers su ON su.id = pu.supplier_id
         WHERE p.schedule = 'controlled' AND date(m.created_at) BETWEEN :from AND :to ${extra}
         ORDER BY m.id`,
      ).all(params),
    )
  })

  r.get('/expiry', (req, res) => {
    const days = Number(req.query.days) || Number(getSettings(db).near_expiry_days) || 90
    res.json(
      db.prepare(
        `SELECT b.*, p.name AS product_name, p.strength, (b.qty_on_hand * b.cost_price) AS cost_value,
           CAST(julianday(b.expiry_date) - julianday(:today) AS INTEGER) AS days_to_expiry
         FROM batches b JOIN products p ON p.id = b.product_id
         WHERE b.qty_on_hand > 0 AND b.expiry_date <= date(:today, :window)
         ORDER BY b.expiry_date`,
      ).all({ today: today(), window: `+${days} days` }),
    )
  })

  // Supplier dues with ageing by days past due. Payments settle the oldest bills first.
  // ?owing=1 leaves out suppliers with a zero balance.
  r.get('/supplier-dues', (req, res) => {
    const rows = [...supplierDues(db).values()]
      .filter((d) => req.query.owing !== '1' || d.balance !== 0)
      .sort((a, b) => b.overdue - a.overdue || b.balance - a.balance || a.name.localeCompare(b.name))
    res.json(rows)
  })

  return r
}
