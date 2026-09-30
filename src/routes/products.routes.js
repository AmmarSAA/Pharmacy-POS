import { Router } from 'express'
import { requireRole } from '../auth.js'
import { today, getSettings } from '../db.js'
import { HttpError, notFound, reqString, optString, reqInt, optInt, oneOf } from '../lib/http.js'

export const SCHEDULES = ['otc', 'rx', 'controlled']

// Sellable stock excludes expired batches.
const STOCK_SQL = `
  SELECT p.*,
    COALESCE((SELECT SUM(qty_on_hand) FROM batches b WHERE b.product_id = p.id AND b.expiry_date >= :today), 0) AS stock,
    (SELECT MIN(expiry_date) FROM batches b WHERE b.product_id = p.id AND b.qty_on_hand > 0 AND b.expiry_date >= :today) AS next_expiry,
    (SELECT sale_price FROM batches b WHERE b.product_id = p.id AND b.qty_on_hand > 0 AND b.expiry_date >= :today
       ORDER BY expiry_date, id LIMIT 1) AS current_price
  FROM products p`

function readProduct(body, defaults) {
  const barcode = optString(body, 'barcode')
  return {
    name: reqString(body, 'name', 'Name'),
    generic_name: optString(body, 'generic_name'),
    barcode,
    manufacturer: optString(body, 'manufacturer'),
    form: optString(body, 'form'),
    strength: optString(body, 'strength'),
    category: optString(body, 'category'),
    pack_size: optInt(body, 'pack_size', 1, { min: 1, label: 'Pack size' }),
    schedule: oneOf(body.schedule || 'otc', SCHEDULES, 'Schedule'),
    gst_rate_bps: optInt(body, 'gst_rate_bps', defaults.gst, { min: 0, max: 10000, label: 'GST rate' }),
    reorder_level: optInt(body, 'reorder_level', 0, { min: 0, label: 'Reorder level' }),
    sale_price: reqInt(body, 'sale_price', { min: 0, label: 'Sale price' }),
    active: body.active === undefined ? 1 : body.active ? 1 : 0,
  }
}

export default function productRoutes(db) {
  const r = Router()

  // ?q= searches name, generic, barcode. ?all=1 includes inactive.
  r.get('/', (req, res) => {
    const q = (req.query.q || '').trim()
    const where = []
    const params = { today: today() }
    if (!req.query.all) where.push('p.active = 1')
    if (q) {
      where.push('(p.name LIKE :q OR p.generic_name LIKE :q OR p.barcode = :exact)')
      params.q = `%${q}%`
      params.exact = q
    }
    const limit = Math.min(Number(req.query.limit) || 50, 500)
    const sql = `${STOCK_SQL} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY (p.barcode = :exact2) DESC, p.name LIMIT ${limit}`
    params.exact2 = q || null
    res.json(db.prepare(sql).all(params))
  })

  // Exact barcode match, used by scanners.
  r.get('/barcode/:code', (req, res) => {
    const p = db.prepare(`${STOCK_SQL} WHERE p.barcode = :code AND p.active = 1`).get({ today: today(), code: req.params.code })
    if (!p) throw notFound('Product with that barcode')
    res.json(p)
  })

  r.get('/:id', (req, res) => {
    const p = db.prepare(`${STOCK_SQL} WHERE p.id = :id`).get({ today: today(), id: Number(req.params.id) })
    if (!p) throw notFound('Product')
    p.batches = db
      .prepare('SELECT * FROM batches WHERE product_id = ? AND qty_on_hand > 0 ORDER BY expiry_date, id')
      .all(p.id)
    res.json(p)
  })

  const defaults = () => ({ gst: Number(getSettings(db).default_gst_rate_bps) || 0 })

  const assertBarcodeFree = (barcode, id = 0) => {
    if (barcode && db.prepare('SELECT 1 FROM products WHERE barcode = ? AND id != ?').get(barcode, id)) {
      throw new HttpError(409, 'Another product already uses that barcode')
    }
  }

  r.post('/', requireRole('admin', 'pharmacist'), (req, res) => {
    const p = readProduct(req.body, defaults())
    assertBarcodeFree(p.barcode)
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO products (name, generic_name, barcode, manufacturer, form, strength, category, pack_size,
           schedule, gst_rate_bps, reorder_level, sale_price, active)
         VALUES (:name, :generic_name, :barcode, :manufacturer, :form, :strength, :category, :pack_size,
           :schedule, :gst_rate_bps, :reorder_level, :sale_price, :active)`,
      )
      .run(p)
    res.status(201).json(db.prepare('SELECT * FROM products WHERE id = ?').get(lastInsertRowid))
  })

  r.put('/:id', requireRole('admin', 'pharmacist'), (req, res) => {
    const id = Number(req.params.id)
    if (!db.prepare('SELECT 1 FROM products WHERE id = ?').get(id)) throw notFound('Product')
    const p = readProduct(req.body, defaults())
    assertBarcodeFree(p.barcode, id)
    db.prepare(
      `UPDATE products SET name = :name, generic_name = :generic_name, barcode = :barcode, manufacturer = :manufacturer,
         form = :form, strength = :strength, category = :category, pack_size = :pack_size, schedule = :schedule,
         gst_rate_bps = :gst_rate_bps, reorder_level = :reorder_level, sale_price = :sale_price, active = :active
       WHERE id = :id`,
    ).run({ ...p, id })
    res.json(db.prepare('SELECT * FROM products WHERE id = ?').get(id))
  })

  return r
}
