import { Router } from '../lib/router.js'
import { requireRole } from '../auth.js'
import { today, nowStamp, getSettings } from '../db.js'
import { HttpError, badRequest, notFound, reqString, optString, reqInt, optInt, oneOf } from '../lib/http.js'

export const SCHEDULES = ['otc', 'rx', 'controlled']

// Sellable stock excludes expired batches. Adds stock, next_expiry, current_price, current_pack_price.
export const escapeRegex = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
export function stockStages(onDate) {
  return [
    {
      $lookup: {
        from: 'batches',
        let: { pid: '$id' },
        pipeline: [
          { $match: { $expr: { $and: [{ $eq: ['$product_id', '$$pid'] }, { $gte: ['$expiry_date', onDate] }] } } },
          { $sort: { expiry_date: 1, id: 1 } },
          { $project: { _id: 0, qty_on_hand: 1, expiry_date: 1, sale_price: 1, pack_price: 1 } },
        ],
        as: '_b',
      },
    },
    {
      $set: {
        stock: { $sum: '$_b.qty_on_hand' },
        _live: { $filter: { input: '$_b', cond: { $gt: ['$$this.qty_on_hand', 0] } } },
      },
    },
    {
      $set: {
        next_expiry: { $ifNull: [{ $first: '$_live.expiry_date' }, null] },
        current_price: { $ifNull: [{ $first: '$_live.sale_price' }, null] },
        current_pack_price: { $ifNull: [{ $first: '$_live.pack_price' }, null] },
      },
    },
    { $project: { _id: 0, _b: 0, _live: 0, name_lc: 0 } },
  ]
}

export async function productsWithStock(db, match, { sort = { name: 1 }, limit = 0, onDate = today() } = {}) {
  const pipeline = [{ $match: match }, { $sort: sort }]
  if (limit) pipeline.push({ $limit: limit })
  return db.col('products').aggregate([...pipeline, ...stockStages(onDate)]).toArray()
}

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
  const products = db.col('products')
  const PLAIN = { projection: { name_lc: 0 } }

  // ?q= searches name, generic, barcode. ?all=1 includes inactive.
  r.get('/', async (req, res) => {
    const q = (req.query.q || '').trim()
    const match = {}
    if (!req.query.all) match.active = 1
    if (q) {
      // Item codes (MultiTec ph1234) match by prefix, so "ph51" finds ph5152.
      const any = new RegExp(escapeRegex(q), 'i')
      match.$or = [{ name: any }, { generic_name: any }, { barcode: new RegExp('^' + escapeRegex(q), 'i') }]
    }
    // Large limits are for pick lists (purchase grid); a hospital pharmacy stocks several thousand items.
    const limit = Math.min(Number(req.query.limit) || 50, 20000)
    let rows
    if (q) {
      // An exact item code / barcode comes first.
      const exact = await productsWithStock(db, { ...match, barcode: q }, { limit: 1 })
      const rest = await productsWithStock(db, { ...match, barcode: { $ne: q } }, { limit })
      rows = [...exact, ...rest].slice(0, limit)
    } else {
      rows = await productsWithStock(db, match, { limit })
    }
    res.json(rows)
  })

  // Lightweight list for pick lists (purchase grid): no stock figures, only what a line needs.
  // Kept in memory until any product changes (several thousand items, asked for by every purchase screen).
  r.get('/pick', async (req, res) => {
    const all = Boolean(req.query.all)
    res.json(await db.cached('products', `pick:${all}`, 600000, () => products.find(all ? {} : { active: 1 }, {
      projection: { id: 1, name: 1, strength: 1, form: 1, barcode: 1, pack_size: 1, pack_price: 1, sale_price: 1, allow_loose: 1, packing: 1, active: 1 },
      sort: { name: 1 },
    }).toArray()))
  })

  // Exact barcode match, used by scanners.
  r.get('/barcode/:code', async (req, res) => {
    const [p] = await productsWithStock(db, { barcode: req.params.code, active: 1 }, { limit: 1 })
    if (!p) throw notFound('Product with that barcode')
    res.json(p)
  })

  r.get('/:id', async (req, res) => {
    const [p] = await productsWithStock(db, { _id: Number(req.params.id) }, { limit: 1 })
    if (!p) throw notFound('Product')
    p.batches = await db.col('batches').find({ product_id: p.id, qty_on_hand: { $gt: 0 } }, { sort: { expiry_date: 1, id: 1 } }).toArray()
    res.json(p)
  })

  const defaults = async () => ({ gst: Number((await getSettings(db)).default_gst_rate_bps) || 0 })

  const assertBarcodeFree = async (barcode, id = 0) => {
    if (barcode && (await products.findOne({ barcode, _id: { $ne: id } }))) {
      throw new HttpError(409, 'Another product already uses that barcode')
    }
  }

  const insert = (p) => db.insert('products', { ...p, name_lc: p.name.toLowerCase() })

  r.post('/', requireRole('admin', 'pharmacist'), async (req, res) => {
    const p = readProduct(req.body, await defaults())
    await assertBarcodeFree(p.barcode)
    const id = await insert(p)
    res.status(201).json(await products.findOne({ _id: id }, PLAIN))
  })

  r.put('/:id', requireRole('admin', 'pharmacist'), async (req, res) => {
    const id = Number(req.params.id)
    if (!(await products.findOne({ _id: id }))) throw notFound('Product')
    const p = readProduct(req.body, await defaults())
    await assertBarcodeFree(p.barcode, id)
    await products.updateOne({ _id: id }, { $set: { ...p, name_lc: p.name.toLowerCase() } })
    res.json(await products.findOne({ _id: id }, PLAIN))
  })

  // Bulk import from an item list (e.g. MultiTec export). Matches existing items by barcode/item
  // code, otherwise by exact name; updates them, creates the rest. Bad rows are reported, not fatal.
  r.post('/import', requireRole('admin', 'pharmacist'), async (req, res) => {
    const rows = req.body.rows
    if (!Array.isArray(rows) || rows.length === 0) throw badRequest('No rows to import')
    if (rows.length > 2000) throw badRequest('Import at most 2000 rows at a time')
    const d = await defaults()
    const result = { created: 0, updated: 0, errors: [] }
    // Read the matching products in two queries, then write in one batch.
    const parsed = rows.map((row, i) => {
      try {
        return { row, p: readImportRow(row, d) }
      } catch (err) {
        result.errors.push({ row: i + 1, message: err.message })
        return null
      }
    }).filter(Boolean)
    const codes = [...new Set(parsed.filter((x) => x.p.barcode).map((x) => x.p.barcode))]
    const names = [...new Set(parsed.filter((x) => !x.p.barcode).map((x) => x.p.name.toLowerCase()))]
    const byCode = new Map((await products.find({ barcode: { $in: codes } }).toArray()).map((p) => [p.barcode, p]))
    const byName = new Map()
    for (const p of await products.find({ name_lc: { $in: names } }, { sort: { id: 1 } }).toArray()) {
      if (!byName.has(p.name_lc)) byName.set(p.name_lc, p)
    }
    const ops = []
    const creates = []
    for (const { row, p } of parsed) {
        const existing = p.barcode ? byCode.get(p.barcode) : byName.get(p.name.toLowerCase())
        if (existing) {
          // Only overwrite what the file actually carries (e.g. keep a price set in the app).
          const has = (k) => row[k] !== undefined && row[k] !== null && String(row[k]).trim() !== ''
          const merged = { ...existing }
          for (const c of COLUMNS) if (has(c)) merged[c] = p[c]
          if (has('pack_price') || has('sale_price') || has('pack_size')) {
            merged.pack_price = has('pack_price') || has('sale_price') ? p.pack_price : existing.pack_price
            merged.sale_price = Math.round(merged.pack_price / merged.pack_size)
          }
          const set = Object.fromEntries(COLUMNS.map((c) => [c, merged[c] ?? null]))
          set.name_lc = String(set.name).toLowerCase()
          Object.assign(existing, set)
          // A row created earlier in this same file is simply amended before it is inserted.
          if (!existing._new) ops.push({ updateOne: { filter: { _id: existing.id }, update: { $set: set } } })
          result.updated++
        } else {
          const doc = { _new: true, created_at: nowStamp(), ...p, name_lc: p.name.toLowerCase() }
          creates.push(doc)
          if (p.barcode) byCode.set(p.barcode, doc)
          else byName.set(doc.name_lc, doc)
          result.created++
        }
    }
    if (creates.length) {
      let id = await db.reserveIds('products', creates.length)
      for (const { _new, ...doc } of creates) {
        ops.push({ insertOne: { document: { _id: id, id, ...doc } } })
        id++
      }
    }
    if (ops.length) await products.bulkWrite(ops, { ordered: false })
    res.json(result)
  })

  return r
}
