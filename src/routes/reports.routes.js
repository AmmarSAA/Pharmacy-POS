import { Router } from '../lib/router.js'
import { requireRole } from '../auth.js'
import { today, getSettings } from '../db.js'
import { supplierDues, addDays, daysBetween } from '../lib/supplier-ledger.js'

function range(req) {
  const from = req.query.from || today()
  const to = req.query.to || from
  return { from, to }
}
// created_at is 'YYYY-MM-DD HH:MM:SS'; '~' sorts after any time, so this covers whole days.
export const between = (from, to) => ({ created_at: { $gte: from, $lt: `${to}~` } })

export default function reportRoutes(db) {
  const r = Router()
  r.use(requireRole('admin', 'pharmacist'))
  const agg = (name, pipeline) => db.col(name).aggregate(pipeline).toArray()
  const one = async (name, pipeline) => (await agg(name, pipeline))[0] || {}

  // Sales summary for a date range, with payment and GST breakdowns.
  r.get('/summary', async (req, res) => {
    const { from, to } = range(req)
    const when = between(from, to)
    const s = await one('sales', [{ $match: when }, { $group: {
      _id: null, invoices: { $sum: 1 }, gross: { $sum: '$subtotal' }, discount: { $sum: '$discount' },
      tax: { $sum: '$tax' }, round_off: { $sum: '$round_off' }, total: { $sum: '$total' },
    } }])
    const sales = { invoices: s.invoices || 0, gross: s.gross || 0, discount: s.discount || 0, tax: s.tax || 0, round_off: s.round_off || 0, total: s.total || 0 }
    const cost = (await one('sale_items', [{ $match: when }, { $group: { _id: null, v: { $sum: { $multiply: ['$unit_cost', '$qty'] } } } }])).v || 0
    const ret = await one('returns', [{ $match: when }, { $group: { _id: null, count: { $sum: 1 }, total: { $sum: '$refund_total' } } }])
    const ri = await one('return_items', [{ $match: when }, { $group: {
      _id: null, tax: { $sum: '$tax' }, cost: { $sum: { $multiply: ['$unit_cost', '$qty'] } },
    } }])
    const returns = { count: ret.count || 0, total: ret.total || 0, tax: ri.tax || 0 }
    const returnedCost = ri.cost || 0
    const byPayment = (await agg('sales', [{ $match: when }, { $group: { _id: '$payment_method', invoices: { $sum: 1 }, total: { $sum: '$total' } } }]))
      .map((x) => ({ payment_method: x._id, invoices: x.invoices, total: x.total }))
    const byGstRate = (await agg('sale_items', [{ $match: when }, { $group: { _id: '$gst_rate_bps', sales: { $sum: '$line_total' }, tax: { $sum: '$tax' } } }, { $sort: { _id: 1 } }]))
      .map((x) => ({ gst_rate_bps: x._id, sales: x.sales, tax: x.tax }))
    const byUser = await db.join((await agg('sales', [{ $match: when }, { $group: { _id: '$user_id', invoices: { $sum: 1 }, total: { $sum: '$total' } } }, { $sort: { total: -1 } }]))
      .map((x) => ({ user_id: x._id, invoices: x.invoices, total: x.total })), [{ key: 'user_id', from: 'users', fields: { full_name: 'full_name' } }])
    const byDay = (await agg('sales', [{ $match: when }, { $group: { _id: { $substrBytes: ['$created_at', 0, 10] }, invoices: { $sum: 1 }, total: { $sum: '$total' } } }, { $sort: { _id: 1 } }]))
      .map((x) => ({ day: x._id, invoices: x.invoices, total: x.total }))
    const netSales = sales.total - returns.total
    res.json({
      from, to, sales, returns, byPayment, byGstRate,
      byUser: byUser.map(({ user_id, ...u }) => u),
      byDay,
      net_sales: netSales,
      net_tax: sales.tax - returns.tax,
      // Gross profit on goods (excludes GST): revenue net of tax minus cost of goods sold.
      gross_profit: netSales - (sales.tax - returns.tax) - (cost - returnedCost),
      // Cash expected in the drawer from this range.
      cash_in_drawer: (byPayment.find((b) => b.payment_method === 'cash')?.total || 0) - returns.total,
    })
  })

  r.get('/top-products', async (req, res) => {
    const { from, to } = range(req)
    const rows = (await agg('sale_items', [
      { $match: between(from, to) },
      { $group: {
        _id: '$product_id',
        qty: { $sum: { $subtract: ['$qty', '$returned_qty'] } },
        revenue: { $sum: '$line_total' },
        profit: { $sum: { $subtract: [{ $subtract: ['$line_total', '$tax'] }, { $multiply: ['$unit_cost', '$qty'] }] } },
      } },
      { $sort: { revenue: -1 } }, { $limit: 50 },
    ])).map((x) => ({ id: x._id, qty: x.qty, revenue: x.revenue, profit: x.profit }))
    await db.join(rows, [{ key: 'id', from: 'products', fields: { name: 'name', strength: 'strength' } }])
    res.json(rows.map(({ id, name, strength, qty, revenue, profit }) => ({ id, name, strength, qty, revenue, profit })))
  })

  r.get('/low-stock', async (req, res) => {
    const t = today()
    const rows = await agg('products', [
      { $match: { active: 1, reorder_level: { $gt: 0 } } },
      { $lookup: {
        from: 'batches', let: { pid: '$id' },
        pipeline: [
          { $match: { $expr: { $and: [{ $eq: ['$product_id', '$$pid'] }, { $gte: ['$expiry_date', t] }] } } },
          { $group: { _id: null, q: { $sum: '$qty_on_hand' } } },
        ],
        as: 'b',
      } },
      { $set: { stock: { $ifNull: [{ $first: '$b.q' }, 0] } } },
      { $match: { $expr: { $lte: ['$stock', '$reorder_level'] } } },
      { $sort: { stock: 1, name: 1 } },
      { $project: { _id: 0, id: 1, name: 1, strength: 1, form: 1, reorder_level: 1, stock: 1 } },
    ])
    res.json(rows)
  })

  r.get('/stock-valuation', async (req, res) => {
    const t = today()
    const rows = (await agg('batches', [
      { $match: { qty_on_hand: { $gt: 0 }, expiry_date: { $gte: t } } },
      { $group: {
        _id: '$product_id', qty: { $sum: '$qty_on_hand' },
        cost_value: { $sum: { $multiply: ['$qty_on_hand', '$cost_price'] } },
        retail_value: { $sum: { $multiply: ['$qty_on_hand', '$sale_price'] } },
      } },
      { $sort: { cost_value: -1 } },
    ])).map((x) => ({ id: x._id, qty: x.qty, cost_value: x.cost_value, retail_value: x.retail_value }))
    await db.join(rows, [{ key: 'id', from: 'products', fields: { name: 'name', strength: 'strength' } }])
    const expired = (await one('batches', [
      { $match: { qty_on_hand: { $gt: 0 }, expiry_date: { $lt: t } } },
      { $group: { _id: null, v: { $sum: { $multiply: ['$qty_on_hand', '$cost_price'] } } } },
    ])).v || 0
    res.json({
      rows: rows.map(({ id, name, strength, qty, cost_value, retail_value }) => ({ id, name, strength, qty, cost_value, retail_value })),
      cost_value: rows.reduce((s, r) => s + r.cost_value, 0),
      retail_value: rows.reduce((s, r) => s + r.retail_value, 0),
      expired_cost_value: expired,
    })
  })

  // Controlled-drug register: every movement of a controlled product with running batch balance
  // and, for sales, the patient and prescriber on record.
  r.get('/controlled-register', async (req, res) => {
    const { from, to } = range(req)
    const controlled = await db.col('products').distinct('id', { schedule: 'controlled' })
    const filter = { ...between(from, to), product_id: { $in: controlled } }
    if (req.query.product_id) filter.product_id = { $in: controlled.filter((id) => id === Number(req.query.product_id)) }
    const rows = await db.all('stock_movements', filter, { sort: { id: 1 } })
    await db.join(rows, [
      { key: 'product_id', from: 'products', fields: { product_name: 'name', strength: 'strength' } },
      { key: 'batch_id', from: 'batches', fields: { batch_no: 'batch_no', expiry_date: 'expiry_date' } },
      { key: 'user_id', from: 'users', fields: { user_name: 'full_name' } },
    ])
    const ref = (reason) => rows.map((m) => ({ ...m, _ref: m.reason === reason ? m.ref_id : null }))
    const sales = await db.join(ref('sale'), [{ key: '_ref', from: 'sales', fields: { invoice_no: 'invoice_no', _rx: 'prescription_id' } }])
    await db.join(sales, [{ key: '_rx', from: 'prescriptions', fields: {
      patient_name: 'patient_name', patient_cnic: 'patient_cnic', prescriber_name: 'prescriber_name', prescriber_reg_no: 'prescriber_reg_no',
    } }])
    const purchases = await db.join(ref('purchase'), [{ key: '_ref', from: 'purchases', fields: { supplier_invoice: 'invoice_no', _sup: 'supplier_id' } }])
    await db.join(purchases, [{ key: '_sup', from: 'suppliers', fields: { supplier_name: 'name' } }])
    const issues = await db.join(ref('issue'), [{ key: '_ref', from: 'issues', fields: { _dept: 'department_id' } }])
    const issueReturns = await db.join(ref('issue_return'), [{ key: '_ref', from: 'issue_returns', fields: { _iss: 'issue_id' } }])
    await db.join(issueReturns, [{ key: '_iss', from: 'issues', fields: { _dept: 'department_id' } }])
    const deptRows = rows.map((m, i) => ({ _dept: m.reason === 'issue' ? issues[i]._dept : m.reason === 'issue_return' ? issueReturns[i]._dept : null }))
    await db.join(deptRows, [{ key: '_dept', from: 'departments', fields: { department_name: 'name' } }])
    res.json(rows.map((m, i) => ({
      id: m.id, created_at: m.created_at, reason: m.reason, change: m.change, balance: m.balance, note: m.note,
      product_name: m.product_name, strength: m.strength, batch_no: m.batch_no, expiry_date: m.expiry_date, user_name: m.user_name,
      invoice_no: sales[i].invoice_no, patient_name: sales[i].patient_name, patient_cnic: sales[i].patient_cnic,
      prescriber_name: sales[i].prescriber_name, prescriber_reg_no: sales[i].prescriber_reg_no,
      supplier_name: purchases[i].supplier_name, supplier_invoice: purchases[i].supplier_invoice,
      department_name: deptRows[i].department_name,
    })))
  })

  // Stock issued to departments, valued at cost. Without department_id: one row per department;
  // with it: one row per product.
  r.get('/department-usage', async (req, res) => {
    const { from, to } = range(req)
    if (req.query.department_id) {
      const dept = Number(req.query.department_id)
      const rows = (await agg('issue_items', [
        { $match: { ...between(from, to), department_id: dept } },
        { $group: {
          _id: '$product_id', qty_issued: { $sum: '$qty' }, qty_returned: { $sum: '$returned_qty' },
          line_cost: { $sum: '$line_cost' }, returned_cost: { $sum: { $multiply: ['$unit_cost', '$returned_qty'] } },
        } },
      ])).map((x) => ({ product_id: x._id, qty_issued: x.qty_issued, qty_returned: x.qty_returned, net_cost: x.line_cost - x.returned_cost }))
      await db.join(rows, [{ key: 'product_id', from: 'products', fields: { name: 'name' } }])
      rows.sort((a, b) => String(a.name).localeCompare(String(b.name)))
      return res.json(rows.map(({ product_id, name, qty_issued, qty_returned, net_cost }) => ({ product_id, name, qty_issued, qty_returned, net_cost })))
    }
    const issued = (await agg('issues', [
      { $match: between(from, to) },
      { $group: { _id: '$department_id', issues: { $sum: 1 }, issued_cost: { $sum: '$total_cost' } } },
    ])).map((x) => ({ department_id: x._id, issues: x.issues, issued_cost: x.issued_cost }))
    const returnedRows = (await agg('issue_returns', [
      { $match: between(from, to) },
      { $group: { _id: '$department_id', cost: { $sum: '$total_cost' } } },
    ])).map((x) => ({ id: x._id, cost: x.cost }))
    const returned = new Map(returnedRows.map((x) => [x.id, x.cost]))
    // Departments with only returns in the range still show up.
    for (const x of returnedRows) {
      if (!issued.some((d) => d.department_id === x.id)) issued.push({ department_id: x.id, issues: 0, issued_cost: 0 })
    }
    await db.join(issued, [{ key: 'department_id', from: 'departments', fields: { name: 'name' } }])
    const rows = issued.map((d) => {
      const returned_cost = returned.get(d.department_id) || 0
      return { department_id: d.department_id, name: d.name, issues: d.issues, issued_cost: d.issued_cost, returned_cost, net_cost: d.issued_cost - returned_cost }
    })
    res.json(rows.sort((a, b) => String(a.name).localeCompare(String(b.name))))
  })

  r.get('/expiry', async (req, res) => {
    const t = today()
    const days = Number(req.query.days) || Number((await getSettings(db)).near_expiry_days) || 90
    const rows = await db.all('batches', { qty_on_hand: { $gt: 0 }, expiry_date: { $lte: addDays(t, days) } }, { sort: { expiry_date: 1 } })
    await db.join(rows, [{ key: 'product_id', from: 'products', fields: { product_name: 'name', strength: 'strength' } }])
    res.json(rows.map((b) => ({ ...b, cost_value: b.qty_on_hand * b.cost_price, days_to_expiry: daysBetween(t, b.expiry_date) })))
  })

  // Supplier dues with ageing by days past due. Payments settle the oldest bills first.
  // ?owing=1 leaves out suppliers with a zero balance.
  r.get('/supplier-dues', async (req, res) => {
    const rows = [...(await supplierDues(db)).values()]
      .filter((d) => req.query.owing !== '1' || d.balance !== 0)
      .sort((a, b) => b.overdue - a.overdue || b.balance - a.balance || a.name.localeCompare(b.name))
    res.json(rows)
  })

  return r
}
