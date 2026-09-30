import { Router } from 'express'
import { requireRole } from '../auth.js'
import { today, getSettings } from '../db.js'
import { transaction } from '../db.js'
import { HttpError, badRequest, notFound, reqString, optString, reqInt, optInt, oneOf } from '../lib/http.js'

export const SCHEDULES = ['otc', 'rx', 'controlled']

// Sellable stock excludes expired batches.
const STOCK_SQL = `
  SELECT p.*,
    COALESCE((SELECT SUM(qty_on_hand) FROM batches b WHERE b.product_id = p.id AND b.expiry_date >= :today), 0) AS stock,
    (SELECT MIN(expiry_date) FROM batches b WHERE b.product_id = p.id AND b.qty_on_hand > 0 AND b.expiry_date >= :today) AS next_expiry,
    (SELECT sale_price FROM batches b WHERE b.product_id = p.id AND b.qty_on_hand > 0 AND b.expiry_date >= :today
       ORDER BY expiry_date, id LIMIT 1) AS current_price,
    (SELECT pack_price FROM batches b WHERE b.product_id = p.id AND b.qty_on_hand > 0 AND b.expiry_date >= :today
       ORDER BY expiry_date, id LIMIT 1) AS current_pack_price
  FROM products p`

const COLUMNS = ['name', 'generic_name', 'barcode', 'manufacturer', 'form', 'strength', 'category', 'pack_size',
  'schedule', 'gst_rate_bps', 'reorder_level', 'sale_price', 'pack_price', 'packing', 'allow_loose', 'shelf_location', 'active']

// Accepts the pack price (preferred) or the per-unit price and keeps both in step.
function prices(body, packSize) {
  if (body.pack_price !== undefined && body.pack_price !== null && body.pack_price !== '') {
    const packPrice = reqInt(body, 'pack_price', { min: 0, label: 'Pack price' })
    return { pack_price: packPrice, sale_price: Math.round(packPrice / packSize) }
  }
  const unit = reqInt(body, 'sale_price', { min: 0, label: 'Sale price' })
  return { pack_price: unit * packSize, sale_price: unit }
}

function readProduct(body, defaults) {
  const packSize = optInt(body, 'pack_size', 1, { min: 1, max: 100000, label: 'Units per pack' })
  return {
    name: reqString(body, 'name', 'Name'),
    generic_name: optString(body, 'generic_name'),
    barcode: optString(body, 'barcode'),
    manufacturer: optString(body, 'manufacturer'),
    form: optString(body, 'form'),
    strength: optString(body, 'strength'),
    category: optString(body, 'category'),
    pack_size: packSize,
    schedule: oneOf(body.schedule || 'otc', SCHEDULES, 'Schedule'),
    gst_rate_bps: optInt(body, 'gst_rate_bps', defaults.gst, { min: 0, max: 10000, label: 'GST rate' }),
    reorder_level: optInt(body, 'reorder_level', 0, { min: 0, label: 'Reorder level' }),
    ...prices(body, packSize),
    packing: optString(body, 'packing'),
    allow_loose: body.allow_loose === undefined ? 1 : body.allow_loose ? 1 : 0,
    shelf_location: optString(body, 'shelf_location'),
    active: body.active === undefined ? 1 : body.active ? 1 : 0,
  }
}

// Import rows use MultiTec-style loose data: only name is required.
function readImportRow(row, defaults) {
  const clean = { ...row }
  for (const k of Object.keys(clean)) if (typeof clean[k] === 'string') clean[k] = clean[k].trim()
  if (clean.pack_price === undefined && clean.sale_price === undefined) clean.pack_price = 0
  if (clean.schedule) clean.schedule = String(clean.schedule).toLowerCase()
  return readProduct(clean, defaults)
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

  const insert = (p) =>
    db.prepare(`INSERT INTO products (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map((c) => ':' + c).join(', ')})`).run(p)

  r.post('/', requireRole('admin', 'pharmacist'), (req, res) => {
    const p = readProduct(req.body, defaults())
    assertBarcodeFree(p.barcode)
    const { lastInsertRowid } = insert(p)
    res.status(201).json(db.prepare('SELECT * FROM products WHERE id = ?').get(lastInsertRowid))
  })

  r.put('/:id', requireRole('admin', 'pharmacist'), (req, res) => {
    const id = Number(req.params.id)
    if (!db.prepare('SELECT 1 FROM products WHERE id = ?').get(id)) throw notFound('Product')
    const p = readProduct(req.body, defaults())
    assertBarcodeFree(p.barcode, id)
    db.prepare(`UPDATE products SET ${COLUMNS.map((c) => `${c} = :${c}`).join(', ')} WHERE id = :id`).run({ ...p, id })
    res.json(db.prepare('SELECT * FROM products WHERE id = ?').get(id))
  })

  // Bulk import from an item list (e.g. MultiTec export). Matches existing items by barcode/item
  // code, otherwise by exact name; updates them, creates the rest. Bad rows are reported, not fatal.
  r.post('/import', requireRole('admin', 'pharmacist'), (req, res) => {
    const rows = req.body.rows
    if (!Array.isArray(rows) || rows.length === 0) throw badRequest('No rows to import')
    if (rows.length > 2000) throw badRequest('Import at most 2000 rows at a time')
    const d = defaults()
    const result = { created: 0, updated: 0, errors: [] }
    transaction(db, () => {
      rows.forEach((row, i) => {
        let p
        try {
          p = readImportRow(row, d)
        } catch (err) {
          result.errors.push({ row: i + 1, message: err.message })
          return
        }
        const existing =
          (p.barcode && db.prepare('SELECT * FROM products WHERE barcode = ?').get(p.barcode)) ||
          (!p.barcode && db.prepare('SELECT * FROM products WHERE name = ? COLLATE NOCASE').get(p.name))
        if (existing) {
          // Only overwrite what the file actually carries (e.g. keep a price set in the app).
          const has = (k) => row[k] !== undefined && row[k] !== null && String(row[k]).trim() !== ''
          const merged = { ...existing }
          for (const c of COLUMNS) if (has(c)) merged[c] = p[c]
          if (has('pack_price') || has('sale_price') || has('pack_size')) {
            merged.pack_price = has('pack_price') || has('sale_price') ? p.pack_price : existing.pack_price
            merged.sale_price = Math.round(merged.pack_price / merged.pack_size)
          }
          db.prepare(`UPDATE products SET ${COLUMNS.map((c) => `${c} = :${c}`).join(', ')} WHERE id = :id`)
            .run(Object.fromEntries([...COLUMNS.map((c) => [c, merged[c]]), ['id', existing.id]]))
          result.updated++
        } else {
          insert(p)
          result.created++
        }
      })
    })
    res.json(result)
  })

  return r
}
