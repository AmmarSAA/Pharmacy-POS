// One-off history import: replays past trading days through the app's own routes (purchases,
// tills, sales, prescriptions, returns, ward issues, supplier payments, write-offs, day close) with
// the clock pinned to each moment, so stock, ledgers and reports stay consistent.
// Run in phases: { phase: 'setup', start } once, then { phase: 'days', from, to } in small chunks.
import bcrypt from 'bcryptjs'
import { setFixedClock, sqlNow } from '../db.js'
import { apiAs } from '../assistant/internal.js'

// Timestamped tables: rows created during an operation get that operation's time.
const STAMPED = [
  ['users', 'created_at'], ['suppliers', 'created_at'], ['purchases', 'created_at'], ['batches', 'created_at'],
  ['prescriptions', 'created_at'], ['sales', 'created_at'], ['returns', 'created_at'],
  ['stock_movements', 'created_at'], ['supplier_payments', 'created_at'], ['cash_movements', 'created_at'],
  ['audit_log', 'created_at'], ['departments', 'created_at'], ['issue_requests', 'created_at'],
  ['issues', 'created_at'], ['issue_returns', 'created_at'], ['day_closes', 'created_at'], ['till_sessions', 'opened_at'],
]

const STAFF = [
  ['imran.pharm', 'Muhammad Imran', 'pharmacist'],
  ['sana.pharm', 'Sana Iqbal', 'pharmacist'],
  ['bilal', 'Bilal Ahmed', 'cashier'],
  ['usman', 'Usman Ali', 'cashier'],
  ['ayesha', 'Ayesha Khan', 'cashier'],
]

// name, phone, address, due days, trade discount bps, contact, payment habit (share of due bills paid on time)
const SUPPLIERS = [
  ['Al-Shifa Pharma Distributors', '051-4435120', 'Blue Area, Islamabad', 30, 200, 'Tariq Mehmood', 0.9],
  ['Rehman Medical Agencies', '051-5512874', 'Raja Bazar, Rawalpindi', 15, 0, 'Abdul Rehman', 0.95],
  ['Crescent Pharma Traders', '042-37231190', 'Ichhra, Lahore', 30, 300, 'Kamran Shah', 0.7],
  ['Pak Health Distributors', '051-2276345', 'I-9 Industrial Area, Islamabad', 45, 250, 'Naveed Akhtar', 0.85],
  ['Medilink Surgical Co.', '051-5778012', 'Saddar, Rawalpindi', 21, 0, 'Shahid Iqbal', 0.6],
  ['Faisal Drug House', '051-4861220', 'G-9 Markaz, Islamabad', 0, 0, 'Faisal Nawaz', 1],
  ['Northern Medicine Company', '0992-334510', 'Mansehra Road, Abbottabad', 30, 200, 'Zubair Khan', 0.8],
]

const DEPARTMENTS = [
  ['Emergency', 'Dr. Hina Riaz', 'EMR'], ['Operation Theatre', 'Dr. Waqar Hussain', 'OT'], ['Medical Ward', 'Dr. Saima Javed', 'MW'],
  ['Surgical Ward', 'Dr. Adnan Qureshi', 'SW'], ['ICU', 'Dr. Farhan Malik', 'ICU'], ['Gynae & Obs', 'Dr. Rubina Shaheen', 'GYN'],
]
const NURSES = ['Staff Nurse Shazia', 'Staff Nurse Rehana', 'Charge Nurse Kiran', 'Staff Nurse Nasreen', 'Staff Nurse Uzma',
  'Male Nurse Asad', 'Staff Nurse Fozia', 'Charge Nurse Samina', 'OT Technician Jamil', 'Staff Nurse Mehwish']

const DOCTORS = [
  ['Dr. Asif Mahmood', '18734-P'], ['Dr. Saima Javed', '27610-P'], ['Dr. Adnan Qureshi', '31122-P'], ['Dr. Hina Riaz', '40518-P'],
  ['Dr. Farhan Malik', '22957-P'], ['Dr. Rubina Shaheen', '15403-P'], ['Dr. Waqar Hussain', '29874-P'], ['Dr. Nadia Anwar', '45210-P'],
  ['Dr. Imtiaz Ahmed', '12096-P'], ['Dr. Sobia Rafiq', '50331-P'],
]
const FIRST = ['Muhammad', 'Ahmed', 'Ali', 'Hassan', 'Zahid', 'Khalid', 'Rashid', 'Naeem', 'Shafiq', 'Arif', 'Javed', 'Saleem',
  'Fatima', 'Ayesha', 'Zainab', 'Rukhsana', 'Shabana', 'Nasreen', 'Parveen', 'Samina', 'Kausar', 'Bushra', 'Amna', 'Sadia']
const LAST = ['Khan', 'Ahmed', 'Hussain', 'Iqbal', 'Malik', 'Butt', 'Qureshi', 'Abbasi', 'Raja', 'Shah', 'Chaudhry', 'Awan',
  'Mughal', 'Bibi', 'Akhtar', 'Siddiqui', 'Mirza', 'Satti', 'Kayani', 'Janjua']
const RETURN_REASONS = ['Doctor changed the medicine', 'Patient discharged, not needed', 'Wrong strength bought',
  'Bought extra by mistake', 'Patient had a reaction, stopped by doctor', 'Duplicate purchase']

// Catalogue items (exact names from the item list): name, retail Rs per unit, counter weight, ward use, schedule.
const ITEMS = [
  ['PANADOL TAB 500MG (200S)', 3.2, 40, 2, 'otc'], ['PANADOL EXTRA TAB (100 S)', 5, 22, 0, 'otc'], ['PANADOL CF TAB (100 S)', 6, 14, 0, 'otc'],
  ['PANADOL SYRUP 100ML NET', 125, 10, 0, 'otc'], ['CALPOL PAED SYRUP 100ML', 130, 7, 0, 'otc'], ['CALPOL TAB (200 S)', 2.5, 8, 0, 'otc'],
  ['PONSTAN FORTE TAB', 7, 16, 0, 'otc'], ['PONSTAN TAB', 4, 6, 0, 'otc'], ['BRUFEN 400MG TAB', 6, 14, 0, 'otc'], ['BRUFEN DS SUSP', 160, 6, 0, 'otc'],
  ['ARINAC FORT TAB', 13, 10, 0, 'otc'], ['ARINAC TAB', 9, 6, 0, 'otc'], ['DISPRIN 100TAB', 2, 5, 0, 'otc'],
  ['SYNFLEX 550MG TAB', 22, 7, 0, 'otc'], ['DICLOBID 50MG TAB', 6, 5, 0, 'otc'], ['BUSCOPAN PLUS TAB', 13, 6, 0, 'otc'],
  ['SPASFON 80MG TAB', 14, 4, 0, 'otc'], ['MOTILIUM TAB', 5, 6, 0, 'otc'], ['GRAVINATE TAB', 3, 5, 0, 'otc'], ['MAXOLON 10MG TAB (100 S)', 2.5, 3, 1, 'otc'],
  ['RISEK 20MG CAP', 22, 12, 0, 'otc'], ['RISEK 40MG CAP', 37, 14, 0, 'otc'], ['NEXUM 40MG CAP', 45, 8, 0, 'otc'], ['ESSO 40MG CAP (14S)', 28, 5, 0, 'otc'],
  ['GAVISCON LIQUID 200ML', 520, 5, 0, 'otc'], ['MUCAINE 120ML SUSP', 270, 4, 0, 'otc'], ['DUPHALAC 120ML SYP', 420, 3, 0, 'otc'],
  ['DULCOLAX 5MG TAB', 4, 3, 0, 'otc'], ['ENTAMIZOLE DS TAB', 12, 5, 0, 'otc'], ['FLAGYL 400MG TAB', 4.5, 8, 1, 'otc'], ['FLAGYL SYP 90ML', 110, 4, 0, 'otc'],
  ['RIGIX 10 MG TAB(30S)', 9, 6, 0, 'otc'], ['ZYRTEC TAB 30S', 18, 3, 0, 'otc'], ['KESTINE 10MG TAB (HIGHNOON)', 21, 3, 0, 'otc'],
  ['XYNOSINE N DROPS 15ML', 115, 4, 0, 'otc'], ['VENTOLIN INHALER (200 DOSES)', 450, 5, 0, 'rx'], ['VENTOLIN NEBULES IMPORTED', 30, 3, 2, 'rx'],
  ['SURBEX Z TAB (30S)', 650, 4, 0, 'otc'], ['NEUROBION TAB', 8, 6, 0, 'otc'], ['FEFOL SP CAP 56S', 7, 4, 0, 'otc'],
  ['CALCIUM 600+VITAMIN D (S)', 9, 4, 0, 'otc'], ['OEM(ORS ORANGE)', 30, 6, 1, 'otc'], ['BETNOVATE N CREAM 10GM', 140, 4, 0, 'otc'],
  ['POLYFAX SKIN OINT 20GM', 260, 3, 1, 'otc'], ['PYODINE SOLU 60ML', 160, 2, 2, 'otc'], ['COTTON MIX 100GM', 120, 2, 2, 'otc'],
  // Antibiotics and chronic medicines (prescription)
  ['AUGMENTIN 625MG TAB 6S', 690, 9, 0, 'rx'], ['AUGMENTIN 375MG TAB 6S', 520, 3, 0, 'rx'], ['AUGMENTIN BD SYP 70ML', 470, 4, 0, 'rx'],
  ['VELOSEF 500MG CAP', 40, 5, 0, 'rx'], ['AMOXIL CAP 500MG (100 S)', 9, 5, 0, 'rx'], ['AMOXIL SYP 125MG 90ML', 120, 3, 0, 'rx'],
  ['AZOMAX 500MG TAB', 95, 7, 0, 'rx'], ['AZOMAX SYRUP 15ML', 210, 3, 0, 'rx'], ['CEBOSH 400MG CAP', 110, 4, 0, 'rx'],
  ['LEFLOX 500MG TAB', 35, 5, 0, 'rx'], ['CIPROXIN 500MG TAB', 50, 4, 0, 'rx'], ['CLARITEK 500MG TAB', 110, 3, 0, 'rx'],
  ['NOVIDAT 500MG TAB', 42, 3, 0, 'rx'], ['GLUCOPHAGE 500MG TAB', 3.5, 8, 0, 'rx'], ['GLUCOPHAGE 850MG TAB', 5.5, 5, 0, 'rx'],
  ['AMARYL 2MG TAB', 24, 5, 0, 'rx'], ['GETRYL 2MG TABS', 11, 4, 0, 'rx'], ['NORVASC 5MG TAB 30S', 23, 5, 0, 'rx'],
  ['SOFVASC 5MG TAB', 14, 4, 0, 'rx'], ['CONCOR 5MG TAB', 24, 5, 0, 'rx'], ['TENORMIN 50MG TAB', 15, 3, 0, 'rx'],
  ['LIPIGET 20MG TABS', 25, 5, 0, 'rx'], ['LOPRIN 75MG TAB', 1.5, 6, 0, 'rx'], ['LASIX 40MG TAB', 4, 3, 1, 'rx'],
  ['HUMULIN 70/30 MIX INJ', 1100, 3, 1, 'rx'], ['LANTUS SOLOSTAR 100 IU/ML', 2350, 1, 0, 'rx'], ['CLEXANE 40MG/0.4ML INJ', 830, 1, 3, 'rx'],
  // Mostly ward stock: injections, fluids, disposables
  ['CEFXONE 1G I.V INJ', 310, 2, 8, 'rx'], ['VELOSEF 1G INJ', 310, 1, 4, 'rx'], ['TAZOCIN 4.5G INJ', 2400, 0, 2, 'rx'],
  ['MERONEM 1G IV INJ', 3800, 0, 1, 'rx'], ['LEFLOX 500MG IV INJ', 380, 0, 3, 'rx'], ['FLAGYL 100ML INJ', 120, 1, 6, 'rx'],
  ['RISEK 40MG INJ INFUSION', 550, 1, 5, 'rx'], ['NEXUM IV 40MG INJ', 620, 0, 2, 'rx'], ['ONSET INJ', 85, 1, 5, 'rx'],
  ['ZOFRAN INJ 4MG', 120, 0, 2, 'rx'], ['MAXOLON INJ', 22, 0, 4, 'rx'], ['GRAVINATE INJ', 22, 0, 3, 'rx'],
  ['TORADOL 30MG IM/IV INJ', 85, 0, 5, 'rx'], ['DICLOBID 75MG INJ', 35, 1, 5, 'rx'], ['DECADRON 4MG 1ML INJ', 30, 0, 4, 'rx'],
  ['TRANSAMIN 500MG IM/IV INJ', 90, 0, 3, 'rx'], ['LASIX 2ML INJ', 25, 0, 3, 'rx'], ['NEUROBION 3ML INJ', 45, 1, 2, 'otc'],
  ['XYLOCAINE 2% 10ML INJ', 70, 0, 4, 'rx'], ['HEPARIN 5000IU 5ML INJ(LEO)', 1250, 0, 1, 'rx'], ['CALCIUM GLUCONATE INJECTION', 95, 0, 1, 'rx'],
  ['SPASFON 40MG INJ', 85, 0, 2, 'rx'],
  ['N/S 1000ML', 190, 2, 10, 'otc'], ['D/W 1000ML.', 185, 1, 6, 'otc'], ['D/S 1000ML', 195, 1, 6, 'otc'], ['MEDILACT 1000ML', 210, 1, 7, 'otc'],
  ['D/W 500ML', 150, 0, 3, 'otc'], ['DRIP SET MASTER', 60, 2, 8, 'otc'], ['CANULA MIX 20', 85, 2, 7, 'otc'], ['CANULA MIX 22', 85, 1, 6, 'otc'],
  ['CANULA MIX 18', 85, 0, 3, 'otc'], ['BD SYRINGE 3CC', 22, 3, 8, 'otc'], ['BD SYRINGES 5CC LUER LUCK', 25, 3, 8, 'otc'],
  ['EXAMINATION GLOVES MEDIUM', 12, 1, 8, 'otc'], ['URINE BAG JMS', 95, 0, 3, 'otc'],
  // Controlled
  ['TRAMAL 50MG CAP', 22, 2, 0, 'controlled'], ['TRAMAL INJ', 70, 0, 3, 'controlled'], ['XANAX 0.5MG TAB', 9, 2, 0, 'controlled'],
  ['ALP 0.5MG TAB', 6, 1, 0, 'controlled'], ['VALIUM TAB 5MG NET', 4, 1, 0, 'controlled'], ['VALIUM INJ 10MG', 55, 0, 2, 'controlled'],
  ['DORMICUM 5MG 5ML INJ', 160, 0, 2, 'controlled'], ['KINZ 10MG INJ', 95, 0, 2, 'controlled'], ['PENTAZOGON 30MG INJ (10S)', 75, 0, 2, 'controlled'],
]
// Items bought once with a short expiry, so the expiry reports and write-offs have something real.
// [days after the start the batch expires (range), days of stock bought]
const SHORT_EXPIRY = {
  'CALCIUM GLUCONATE INJECTION': [40, 55, 90], 'ZOFRAN INJ 4MG': [42, 58, 90], // expired in August, written off 1 Sep
  'DUPHALAC 120ML SYP': [83, 90, 120], 'POLYFAX SKIN OINT 20GM': [84, 91, 120], 'MUCAINE 120ML SUSP': [85, 90, 120], // expired, still on the shelf
  'FLAGYL SYP 90ML': [100, 125, 150], 'AMOXIL SYP 125MG 90ML': [105, 135, 150], 'BRUFEN DS SUSP': [110, 140, 150],
  'ONSET INJ': [120, 150, 150], 'AZOMAX SYRUP 15ML': [125, 165, 160], 'GAVISCON LIQUID 200ML': [130, 170, 160],
  'XYNOSINE N DROPS 15ML': [115, 150, 150], 'SURBEX Z TAB (30S)': [140, 175, 160],
}
const DENOMS = [5000, 1000, 500, 100, 50, 20, 10, 5, 2, 1]

// ── helpers ────────────────────────────────────────────────────────────────
function hashStr(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}
function rngFor(seed) {
  let a = hashStr(seed)
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const r = {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    chance: (p) => next() < p,
    weighted: (arr, w) => {
      const total = arr.reduce((s, x) => s + w(x), 0)
      let v = next() * total
      for (const x of arr) if ((v -= w(x)) < 0) return x
      return arr[arr.length - 1]
    },
  }
  return r
}
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10)
const monthEnd = (d, months) => {
  const x = new Date(Date.parse(d + 'T00:00:00Z'))
  return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + months + 1, 0)).toISOString().slice(0, 10)
}
const hms = (mins) => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}:00`
const notesFor = (paisa) => {
  let rs = Math.round(paisa / 100)
  const out = {}
  for (const d of DENOMS) {
    const n = Math.floor(rs / d)
    if (n) out[String(d)] = n
    rs -= n * d
  }
  return out
}
const person = (r) => `${r.pick(FIRST)} ${r.pick(LAST)}`
const cnic = (r) => `${r.pick(['37405', '37406', '61101', '35202', '13101', '37301'])}-${r.int(1000000, 9999999)}-${r.int(1, 9)}`
const phone = (r) => `03${r.pick(['00', '01', '05', '11', '13', '21', '33', '35', '45'])}-${r.int(1000000, 9999999)}`

export async function runHistory(db, app, body) {
  const log = { ops: 0, errors: {} }
  const fail = (what, e) => {
    const k = `${what}: ${e.message}`.slice(0, 160)
    log.errors[k] = (log.errors[k] || 0) + 1
  }

  // Run fn as if it were `stamp`; rows it creates are dated `stamp`.
  async function at(stamp, fn) {
    const before = STAMPED.map(([t]) => db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS m FROM ${t}`).get().m)
    setFixedClock(stamp)
    try {
      log.ops++
      return await fn()
    } finally {
      setFixedClock(null)
      STAMPED.forEach(([t, col], i) => db.prepare(`UPDATE ${t} SET ${col} = ? WHERE rowid > ?`).run(stamp, before[i]))
    }
  }

  const userByName = (u) => db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(u)
  const owner = db.prepare('SELECT * FROM users WHERE is_owner = 1 ORDER BY id LIMIT 1').get()
    || db.prepare("SELECT * FROM users WHERE role = 'admin' AND active = 1 ORDER BY id LIMIT 1").get()
  if (!owner) throw new Error('No owner account')
  const callers = new Map()
  const as = (user) => {
    if (!callers.has(user.id)) callers.set(user.id, apiAs(app, db, user))
    return callers.get(user.id)
  }

  const items = ITEMS.map(([name, unitRs, weight, ward, schedule]) => {
    const p = db.prepare('SELECT * FROM products WHERE name = ? AND active = 1 ORDER BY id LIMIT 1').get(name)
    return p && { p, name, unitRs, weight, ward, schedule, supplier: hashStr(p.manufacturer || name) % SUPPLIERS.length }
  }).filter(Boolean)

  const counterItems = items.filter((i) => i.weight > 0)
  const wardItems = items.filter((i) => i.ward > 0)
  const counterWeight = counterItems.reduce((s, i) => s + i.weight, 0)
  const wardWeight = wardItems.reduce((s, i) => s + i.ward, 0)

  const unitsPerSale = (ps) => (ps === 1 ? 1.25 : ps <= 30 ? 0.62 * ps + 2.8 : 13.5)
  const wardQty = (it) => {
    const ps = it.p.pack_size || 1
    if (/1000ML|500ML|DRIP SET|CANULA|URINE BAG/.test(it.name)) return [10, 30]
    if (/SYRINGE|GLOVES/.test(it.name)) return [30, 80]
    if (it.schedule === 'controlled') return [2, 6]
    if (it.unitRs * ps >= 1000) return [1, 4]
    if (ps > 30) return [20, 60]
    return [4, 15]
  }
  // Expected daily use, for opening stock before there is any history.
  const expectedDaily = (it) => {
    const counter = it.weight ? (52 * 1.85 * it.weight / counterWeight) * unitsPerSale(it.p.pack_size || 1) : 0
    const [lo, hi] = wardQty(it)
    const ward = it.ward ? (3 * 5 * it.ward / wardWeight) * (lo + hi) / 2 : 0
    return counter + ward
  }
  if (body.phase === 'setup') {
    const stamp = `${addDays(body.start, -5)} 11:20:00`
    await at(stamp, async () => {
      for (const [username, fullName, role] of STAFF) {
        if (userByName(username)) continue
        const hash = bcrypt.hashSync(crypto.randomUUID() + crypto.randomUUID(), 10)
        db.prepare('INSERT INTO users (username, full_name, password_hash, role, active) VALUES (?, ?, ?, ?, 1)')
          .run(username, fullName, hash, role)
      }
      const call = as(owner)
      for (const [name, ph, address, dueDays, , contact] of SUPPLIERS) {
        if (db.prepare('SELECT 1 FROM suppliers WHERE name = ?').get(name)) continue
        await call('POST', '/suppliers', { name, phone: ph, address, due_days: dueDays, contact_person: contact })
      }
      for (const [name, incharge] of DEPARTMENTS) {
        if (db.prepare('SELECT 1 FROM departments WHERE name = ?').get(name)) continue
        await call('POST', '/departments', { name, incharge })
      }
    })
    // Schedules, and reorder levels at about ten days of normal use.
    for (const it of items) {
      db.prepare('UPDATE products SET schedule = ?, reorder_level = ? WHERE id = ?')
        .run(it.schedule, Math.max(it.p.pack_size || 1, Math.ceil(expectedDaily(it) * 10)), it.p.id)
    }
    return { ...log, items: items.length, missing: ITEMS.length - items.length }
  }

  if (body.phase !== 'days') throw new Error('phase must be setup or days')
  const start = body.start
  const supplierRows = SUPPLIERS.map(([name]) => db.prepare('SELECT * FROM suppliers WHERE name = ?').get(name))
  if (supplierRows.some((s) => !s)) throw new Error('Run setup first')
  const staff = Object.fromEntries(STAFF.map(([u]) => [u, userByName(u)]))
  const depts = DEPARTMENTS.map(([name, , code]) => ({ ...db.prepare('SELECT * FROM departments WHERE name = ?').get(name), code }))
  const priceAt = (it, date) => {
    // About one item in seven went up ~8% halfway through the period.
    const up = hashStr(it.name) % 7 === 0 && date >= addDays(start, 45)
    return Math.round(it.unitRs * (up ? 1.08 : 1) * (it.p.pack_size || 1))
  }
  const stockOf = (pid, date) =>
    db.prepare('SELECT COALESCE(SUM(qty_on_hand), 0) AS q FROM batches WHERE product_id = ? AND expiry_date >= ?').get(pid, date).q
  const usedSince = (pid, since) =>
    -db.prepare(
      `SELECT COALESCE(SUM(m.change), 0) AS q FROM stock_movements m JOIN batches b ON b.id = m.batch_id
       WHERE b.product_id = ? AND m.change < 0 AND m.reason IN ('sale', 'issue') AND m.created_at >= ?`,
    ).get(pid, since).q

  async function purchase(date, time, buyer, supplierIdx, lines, r) {
    const s = supplierRows[supplierIdx]
    const spec = SUPPLIERS[supplierIdx]
    const cash = spec[3] === 0
    const letters = s.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase()
    const body = {
      supplier_id: s.id,
      invoice_no: `${letters}-${date.slice(2, 4)}${r.int(10000, 99999)}`,
      invoice_date: date,
      payment_type: cash ? 'cash' : 'credit',
      ...(cash ? { payment_method: 'cash' } : {}),
      items: lines.map(({ it, packs, short }) => {
        const ps = it.p.pack_size || 1
        const packPrice = priceAt(it, date)
        const costRatio = 0.85 * (0.97 + r.next() * 0.03)
        return {
          product_id: it.p.id,
          batch_no: `${String.fromCharCode(65 + r.int(0, 25))}${r.chance(0.5) ? String.fromCharCode(65 + r.int(0, 25)) : ''}${r.int(1000, 99999)}`,
          expiry_date: short ? addDays(start, r.int(short[0], short[1])) : monthEnd(date, r.int(14, 34)),
          packs,
          bonus_qty: packs >= 10 && r.chance(0.2) ? Math.floor(packs / 10) * ps : 0,
          discount_bps: spec[4],
          pack_cost: Math.round(packPrice * costRatio * 100),
          pack_price: packPrice * 100,
        }
      }),
    }
    await at(`${date} ${time}`, () => as(buyer)('POST', '/purchases', body)).catch((e) => fail('purchase', e))
  }

  async function restock(date, buyer, r, first) {
    const bySupplier = new Map()
    for (const it of items) {
      const ps = it.p.pack_size || 1
      let daily = expectedDaily(it)
      if (!first) {
        const days = Math.min(14, Math.max(1, Math.round((Date.parse(date) - Date.parse(start)) / 864e5)))
        const used = usedSince(it.p.id, addDays(date, -days))
        if (days >= 7) daily = Math.max(used / days, daily * 0.3)
      }
      const have = first ? 0 : stockOf(it.p.id, date)
      if (!first && SHORT_EXPIRY[it.name] && date < addDays(start, SHORT_EXPIRY[it.name][0]) && have > 0) continue
      const short = first ? SHORT_EXPIRY[it.name] : null
      const cover = short ? short[2] : first ? 35 : 28
      if (!first && have > daily * 9 + ps) continue
      const packs = Math.max(1, Math.ceil((daily * cover - have) / ps))
      if (!bySupplier.has(it.supplier)) bySupplier.set(it.supplier, [])
      bySupplier.get(it.supplier).push({ it, packs, short })
    }
    let minute = 8 * 60 + 15
    for (const [sIdx, lines] of bySupplier) {
      minute += r.int(8, 35)
      await purchase(date, hms(Math.min(minute, 13 * 60)), buyer, sIdx, lines, r)
    }
  }

  function cartFor(r) {
    const n = r.weighted([1, 2, 3, 4], (k) => [45, 30, 17, 8][k - 1])
    const lines = new Map()
    for (let i = 0; i < n; i++) {
      const it = r.weighted(counterItems, (x) => x.weight)
      const ps = it.p.pack_size || 1
      let qty
      if (ps === 1) qty = r.weighted([1, 2, 3], (k) => [80, 15, 5][k - 1])
      else if (ps <= 30) qty = r.chance(0.55) ? ps * (r.chance(0.15) ? 2 : 1) : Math.min(ps - 1, r.pick([5, 7, 10]))
      else qty = r.weighted([10, 20, 30, 5], (k) => ({ 10: 60, 20: 25, 30: 10, 5: 5 })[k])
      lines.set(it.p.id, { it, qty })
    }
    return [...lines.values()]
  }

  async function sell(date, minute, seller, r) {
    const cart = cartFor(r)
    if (!cart.length) return
    const rx = cart.some((l) => l.it.schedule !== 'otc')
    const controlled = cart.some((l) => l.it.schedule === 'controlled')
    const method = r.weighted(['cash', 'card', 'wallet'], (m) => ({ cash: 76, card: 14, wallet: 10 })[m])
    const discountBps = r.chance(seller.role === 'cashier' ? 0.1 : 0.05) ? (r.chance(0.7) ? 500 : 1000) : 0
    const est = cart.reduce((s, l) => s + (priceAt(l.it, date) * l.qty) / (l.it.p.pack_size || 1), 0) * (1 - discountBps / 10000)
    const body = {
      items: cart.map((l) => ({ product_id: l.it.p.id, qty: l.qty, discount_bps: discountBps })),
      payment_method: method,
    }
    if (method === 'cash' && r.chance(0.65)) {
      const step = est > 2000 ? 1000 : est > 400 ? 500 : 100
      body.amount_paid = Math.ceil((est + 2) / step) * step * 100
    }
    if (rx) {
      const [doc, pmdc] = r.pick(DOCTORS)
      body.prescription = {
        patient_name: person(r), prescriber_name: doc, rx_date: date,
        ...(r.chance(0.5) ? { patient_phone: phone(r) } : {}),
        ...(controlled ? { patient_cnic: cnic(r), prescriber_reg_no: pmdc } : r.chance(0.4) ? { prescriber_reg_no: pmdc } : {}),
      }
    }
    const call = as(controlled || rx ? seller.pharmacist : seller)
    await at(`${date} ${hms(minute)}`, async () => {
      try {
        await call('POST', '/sales', body)
      } catch (e) {
        // Out of stock on a line: the customer takes the rest.
        if (e.status !== 409 || body.items.length === 1) throw e
        const ok = body.items.filter((x) => stockOf(x.product_id, date) >= x.qty)
        if (!ok.length) throw e
        const keep = new Set(ok.map((x) => x.product_id))
        const left = cart.filter((l) => keep.has(l.it.p.id))
        await call('POST', '/sales', {
          ...body, amount_paid: undefined, items: ok,
          ...(left.some((l) => l.it.schedule !== 'otc') ? {} : { prescription: undefined }),
        })
      }
    }).catch((e) => fail('sale', e))
  }

  async function returnOne(date, minute, pharmacist, r) {
    const sale = db.prepare(
      `SELECT s.id FROM sales s WHERE s.created_at >= ? AND s.created_at < ? AND EXISTS
        (SELECT 1 FROM sale_items si WHERE si.sale_id = s.id AND si.returned_qty < si.qty) ORDER BY s.id LIMIT 1 OFFSET ?`,
    ).get(addDays(date, -5), `${date} ${hms(minute)}`, r.int(0, 150))
    if (!sale) return
    const items = db.prepare('SELECT * FROM sale_items WHERE sale_id = ? AND returned_qty < qty').all(sale.id)
    const si = r.pick(items)
    const left = si.qty - si.returned_qty
    const qty = left > 1 && r.chance(0.5) ? r.int(1, left - 1) : left
    await at(`${date} ${hms(minute)}`, () =>
      as(pharmacist)('POST', `/sales/${sale.id}/returns`, { items: [{ sale_item_id: si.id, qty }], reason: r.pick(RETURN_REASONS) }),
    ).catch((e) => fail('return', e))
  }

  async function wardRound(date, minute, pharmacist, dept, r) {
    const n = r.int(3, 7)
    const lines = new Map()
    for (let i = 0; i < n; i++) {
      const it = r.weighted(wardItems, (x) => x.ward)
      if (it.schedule === 'controlled' && !['OT', 'ICU', 'EMR'].includes(dept.code)) continue
      const [lo, hi] = wardQty(it)
      lines.set(it.p.id, { it, qty: r.int(lo, hi) })
    }
    if (!lines.size) return
    const call = as(pharmacist)
    const nurse = r.pick(NURSES)
    let request
    await at(`${date} ${hms(minute)}`, async () => {
      request = await call('POST', '/issue-requests', {
        department_id: dept.id, requested_by: nurse, ref_no: `IND-${dept.code}-${r.int(1000, 9999)}`,
        items: [...lines.values()].map((l) => ({ product_id: l.it.p.id, qty: l.qty })),
      })
    }).catch((e) => fail('requisition', e))
    if (!request) return
    const partial = r.chance(0.05)
    const issueItems = [...lines.values()]
      .map((l) => ({ product_id: l.it.p.id, qty: partial ? Math.max(1, Math.floor(l.qty * 0.6)) : l.qty }))
      .filter((x) => stockOf(x.product_id, date) >= x.qty)
    if (!issueItems.length) return
    await at(`${date} ${hms(minute + r.int(10, 40))}`, () =>
      call('POST', '/issues', { department_id: dept.id, request_id: request.id, received_by: nurse, items: issueItems }),
    ).catch((e) => fail('issue', e))
  }

  async function issueReturn(date, minute, pharmacist, r) {
    const row = db.prepare(
      `SELECT ii.id, ii.qty, ii.returned_qty FROM issue_items ii JOIN issues i ON i.id = ii.issue_id
       WHERE i.created_at >= ? AND i.created_at < ? AND ii.returned_qty < ii.qty ORDER BY ii.id LIMIT 1 OFFSET ?`,
    ).get(addDays(date, -3), `${date} 00:00:00`, r.int(0, 30))
    if (!row) return
    const left = row.qty - row.returned_qty
    const qty = Math.max(1, Math.floor(left * r.pick([0.2, 0.3, 0.5])))
    const issue = db.prepare('SELECT issue_id FROM issue_items WHERE id = ?').get(row.id)
    await at(`${date} ${hms(minute)}`, () =>
      as(pharmacist)('POST', `/issues/${issue.issue_id}/returns`, {
        items: [{ issue_item_id: row.id, qty }], reason: r.pick(['Unused, patient discharged', 'Patient shifted to another hospital', 'Excess indent returned']),
      }),
    ).catch((e) => fail('issue return', e))
  }

  async function paySuppliers(date, r) {
    let minute = 12 * 60 + 20
    for (const [i, s] of supplierRows.entries()) {
      const habit = SUPPLIERS[i][6]
      if (SUPPLIERS[i][3] === 0) continue
      const bills = db.prepare(
        `SELECT p.id, p.total - COALESCE((SELECT SUM(amount) FROM supplier_payments sp WHERE sp.purchase_id = p.id), 0) AS due
         FROM purchases p WHERE p.supplier_id = ? AND p.payment_type = 'credit' AND p.due_date <= ? ORDER BY p.due_date`,
      ).all(s.id, addDays(date, 3)).filter((b) => b.due > 0)
      for (const b of bills) {
        if (!r.chance(habit)) continue
        const method = r.chance(0.6) ? 'bank' : 'cheque'
        minute += r.int(3, 12)
        await at(`${date} ${hms(minute)}`, () =>
          as(owner)('POST', `/suppliers/${s.id}/payments`, {
            amount: b.due, method, purchase_id: b.id,
            reference: method === 'bank' ? `IBFT ${r.int(100000, 999999)}` : `CHQ ${String(r.int(1000, 99999)).padStart(6, '0')}`,
          }),
        ).catch((e) => fail('supplier payment', e))
      }
    }
  }

  async function writeOffs(date, pharmacist, r) {
    const expired = db.prepare('SELECT id, qty_on_hand FROM batches WHERE expiry_date < ? AND qty_on_hand > 0').all(addDays(date, -10))
    let minute = 9 * 60 + 30
    for (const b of expired) {
      minute += r.int(1, 4)
      await at(`${date} ${hms(minute)}`, () =>
        as(pharmacist)('POST', '/inventory/adjustments', {
          batch_id: b.id, change: -b.qty_on_hand, reason: 'expired', note: 'Expired, removed from shelf for return/destruction',
        }),
      ).catch((e) => fail('write-off', e))
    }
    // A breakage now and then.
    if (r.chance(0.6)) {
      const b = db.prepare(
        `SELECT b.id FROM batches b JOIN products p ON p.id = b.product_id WHERE b.qty_on_hand > 0 AND b.expiry_date >= ?
           AND (p.name LIKE '%SYP%' OR p.name LIKE '%SYRUP%' OR p.name LIKE '%1000ML%') ORDER BY b.id LIMIT 1 OFFSET ?`,
      ).get(date, r.int(0, 15))
      if (b) {
        await at(`${date} ${hms(minute + 20)}`, () =>
          as(pharmacist)('POST', '/inventory/adjustments', { batch_id: b.id, change: -1, reason: 'damaged', note: 'Bottle broken while shelving' }),
        ).catch((e) => fail('damaged', e))
      }
    }
  }

  async function tillOpen(date, minute, user, r) {
    await at(`${date} ${hms(minute)}`, () =>
      as(user)('POST', '/tills/open', { notes: { 1000: 3, 500: 2, 100: 8, 50: 4 } }),
    ).catch((e) => fail('till open', e))
    void r
  }
  async function tillClose(date, minute, user, r) {
    await at(`${date} ${hms(minute)}`, async () => {
      const cur = await as(user)('GET', '/tills/current')
      if (!cur.session) return
      let counted = cur.totals.expected_cash
      if (r.chance(0.1)) counted -= r.int(1, 10) * 1000
      else if (r.chance(0.05)) counted += r.int(1, 5) * 1000
      await as(user)('POST', '/tills/current/close', {
        notes: notesFor(Math.max(0, counted)),
        ...(counted !== cur.totals.expected_cash ? { note: counted < cur.totals.expected_cash ? 'Short, will check with cashier' : 'Excess found in drawer' } : {}),
      })
    }).catch((e) => fail('till close', e))
  }
  async function cashMove(date, minute, user, direction, amountRs, reason) {
    await at(`${date} ${hms(minute)}`, () =>
      as(user)('POST', '/tills/current/movements', { direction, amount: amountRs * 100, reason }),
    ).catch((e) => fail('cash movement', e))
  }

  const out = []
  for (let date = body.from; date <= body.to; date = addDays(date, 1)) {
    const r = rngFor(`pharmacy-history-${date}`)
    const dow = new Date(date + 'T00:00:00Z').getUTCDay()
    const first = date === start
    const dayIndex = Math.round((Date.parse(date) - Date.parse(start)) / 864e5)
    const morningCashier = dow === 0 ? staff.ayesha : staff.bilal
    const eveningCashier = dow === 2 ? staff.ayesha : staff.usman
    const morning = { cashier: morningCashier, pharmacist: staff['imran.pharm'] }
    const evening = { cashier: eveningCashier, pharmacist: staff['sana.pharm'] }
    for (const sh of [morning, evening]) {
      sh.cashier.pharmacist = sh.pharmacist
      sh.pharmacist.pharmacist = sh.pharmacist
    }

    if (first || dow === 1 || dow === 4) await restock(date, morning.pharmacist, r, first)
    if (date.endsWith('-01') && !first) await writeOffs(date, morning.pharmacist, r)

    // Opening the counters.
    await tillOpen(date, 8 * 60 + r.int(0, 8), morning.cashier, r)
    await tillOpen(date, 8 * 60 + r.int(9, 15), morning.pharmacist, r)

    const factor = [0.78, 1.15, 1.05, 1.0, 1.02, 0.86, 0.95][dow]
    const trend = 1 + dayIndex * 0.0018
    const total = Math.round(54 * factor * trend * (0.87 + r.next() * 0.26))
    const morningSales = Math.round(total * 0.58)
    const times = (n, from, to, peak) =>
      Array.from({ length: n }, () => {
        const a = from + r.next() * (to - from)
        const b = peak + (r.next() - 0.5) * (to - from) * 0.5
        return Math.round(Math.min(to, Math.max(from, r.chance(0.55) ? b : a)))
      }).sort((x, y) => x - y)

    const events = []
    for (const t of times(morningSales, 8 * 60 + 20, 14 * 60 + 50, 11 * 60 + 30)) {
      events.push([t, () => sell(date, t, r.chance(0.82) ? morning.cashier : morning.pharmacist, r)])
    }
    const nReturnsM = r.chance(0.55) ? 1 : 0
    for (let i = 0; i < nReturnsM; i++) { const t = r.int(10 * 60, 14 * 60); events.push([t, () => returnOne(date, t, morning.pharmacist, r)]) }
    if (r.chance(0.35)) { const t = r.int(10 * 60, 13 * 60); events.push([t, () => cashMove(date, t, morning.cashier, 'out', r.int(3, 8) * 100, 'Tea and refreshments for staff')]) }
    if (dow === 1) { const t = 8 * 60 + 25; events.push([t, () => cashMove(date, t, morning.cashier, 'in', 2000, 'Change (coins and small notes) from bank')]) }
    const wardRounds = dow === 0 ? 1 : r.int(2, 4)
    for (let i = 0; i < wardRounds; i++) {
      const dept = dow === 0 ? depts[0] : r.pick(depts)
      const t = r.int(9 * 60, 12 * 60 + 30)
      events.push([t, () => wardRound(date, t, morning.pharmacist, dept, r)])
    }
    if (r.chance(0.15)) { const t = r.int(9 * 60, 12 * 60); events.push([t, () => issueReturn(date, t, morning.pharmacist, r)]) }
    if (dow === 6) events.push([12 * 60 + 15, () => paySuppliers(date, r)])
    events.sort((a, b) => a[0] - b[0])
    for (const [, fn] of events) await fn()

    // Shift change.
    await tillOpen(date, 14 * 60 + 55 + r.int(0, 8), evening.cashier, r)
    await tillOpen(date, 15 * 60 + r.int(0, 8), evening.pharmacist, r)
    await tillClose(date, 15 * 60 + r.int(5, 15), morning.cashier, r)
    await tillClose(date, 15 * 60 + r.int(16, 25), morning.pharmacist, r)

    const ev2 = []
    for (const t of times(total - morningSales, 15 * 60 + 20, 22 * 60 + 20, 19 * 60 + 30)) {
      ev2.push([t, () => sell(date, t, r.chance(0.8) ? evening.cashier : evening.pharmacist, r)])
    }
    if (r.chance(0.45)) { const t = r.int(16 * 60, 21 * 60); ev2.push([t, () => returnOne(date, t, evening.pharmacist, r)]) }
    if (r.chance(0.2)) { const t = r.int(17 * 60, 21 * 60); ev2.push([t, () => cashMove(date, t, evening.cashier, 'out', r.int(25, 50) * 10, 'TCS courier charges')]) }
    if (r.chance(0.5)) { const t = r.int(16 * 60, 21 * 60); ev2.push([t, () => wardRound(date, t, evening.pharmacist, r.pick([depts[0], depts[4]]), r)]) }
    ev2.sort((a, b) => a[0] - b[0])
    for (const [, fn] of ev2) await fn()

    await tillClose(date, 22 * 60 + r.int(30, 40), evening.cashier, r)
    await tillClose(date, 22 * 60 + r.int(41, 50), evening.pharmacist, r)
    await at(`${date} 23:${String(r.int(5, 25)).padStart(2, '0')}:00`, () => as(owner)('POST', '/tills/day-close', { date }))
      .catch((e) => fail('day close', e))
    out.push(date)
  }
  return { ...log, days: out }
}

// Local "now" (for refusing to write the future).
export const localNow = (db) => db.prepare(`SELECT ${sqlNow()} AS t`).get().t
