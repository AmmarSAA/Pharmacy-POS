// Pharmacy POS front end. Plain ES modules, no build step.
// Money from the API is integer paisa; everything shown to people is rupees.
import { mountAssistant, assistantOwnerSection } from './assistant.js'

const $ = (sel, root = document) => root.querySelector(sel)
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)]

const state = { user: null, settings: {} }

// ---------- helpers ----------

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c])

const rs = (paisa) =>
  'Rs ' + (Number(paisa || 0) / 100).toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const toPaisa = (rupees) => Math.round(parseFloat(String(rupees).replace(/,/g, '')) * 100)
const toRupees = (paisa) => (Number(paisa || 0) / 100).toFixed(2)
const pct = (bps) => `${Number(bps || 0) / 100}%`
const today = () => {
  const d = new Date()
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
}
const can = (...roles) => roles.includes(state.user?.role)
const productLabel = (p) => [p.name, p.strength, p.form].filter(Boolean).join(' · ')
const schedBadge = (s) =>
  s === 'otc' ? '' : `<span class="badge ${s}">${s === 'rx' ? 'Rx' : 'CONTROLLED'}</span>`

async function api(method, path, body) {
  const res = await fetch('/api' + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  })
  const data = await res.json().catch(() => ({}))
  if (res.status === 401 && !path.startsWith('/auth/')) {
    state.user = null
    renderAuth()
    throw new Error(data.message || 'Please sign in')
  }
  if (!res.ok) throw new Error(data.message || `Request failed (${res.status})`)
  return data
}
const get = (p) => api('GET', p)
const post = (p, b) => api('POST', p, b)
const put = (p, b) => api('PUT', p, b)
const patch = (p, b) => api('PATCH', p, b)

function toast(msg, isError = false) {
  const el = document.createElement('div')
  el.textContent = msg
  if (isError) el.className = 'err'
  $('#toast').append(el)
  setTimeout(() => el.remove(), isError ? 5000 : 2500)
}

// Wraps an async handler so failures show as a toast instead of vanishing.
const guard = (fn) => async (...args) => {
  try {
    await fn(...args)
  } catch (e) {
    toast(e.message, true)
  }
}

function modal(html, { wide = false, onClose } = {}) {
  const bg = document.createElement('div')
  bg.className = 'modal-bg'
  bg.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">${html}</div>`
  const close = () => {
    bg.remove()
    document.removeEventListener('keydown', onKey)
    onClose?.()
  }
  const onKey = (e) => e.key === 'Escape' && close()
  document.addEventListener('keydown', onKey)
  bg.addEventListener('mousedown', (e) => e.target === bg && close())
  $('#modal-root').append(bg)
  $$('[data-close]', bg).forEach((b) => b.addEventListener('click', close))
  $('input, select, textarea', bg)?.focus()
  return { el: bg, close }
}

function formData(form) {
  const out = {}
  for (const el of form.elements) {
    if (!el.name) continue
    out[el.name] = el.type === 'checkbox' ? el.checked : el.value
  }
  return out
}

function printHtml(html, cls = '') {
  const area = $('#print-area')
  area.className = cls
  area.innerHTML = html
  window.print()
}

// ---------- packs, notes, CSV ----------

// Amount for `units` when a full pack of `packSize` units costs `packPrice` (same math as the server).
const packAmount = (units, packPrice, packSize) => Math.round((units * (packPrice || 0)) / (packSize || 1))
const packPriceOf = (p) => p.current_pack_price ?? p.pack_price ?? (p.current_price ?? p.sale_price ?? 0) * (p.pack_size || 1)
// "3 packs + 4" for stock levels.
const packsText = (units, packSize) => {
  const ps = packSize || 1
  if (ps <= 1) return String(units)
  const packs = Math.floor(units / ps)
  const loose = units % ps
  return `${packs} pack${packs === 1 ? '' : 's'}${loose ? ` + ${loose}` : ''}`
}
// "2 × 10 + 3" for receipts and sale lines.
const qtyText = (units, packSize) => {
  const ps = packSize || 1
  if (ps <= 1) return String(units)
  const packs = Math.floor(units / ps)
  const loose = units % ps
  if (!packs) return String(loose)
  return `${packs} × ${ps}${loose ? ` + ${loose}` : ''}`
}
// Rupee input to paisa; blank or invalid gives null.
const paisaOrNull = (v) => {
  const s = String(v ?? '').trim()
  if (!s) return null
  const n = toPaisa(s)
  return Number.isFinite(n) ? n : null
}
const pctText = (n) => (Number.isFinite(n) ? `${n.toFixed(1)}%` : '—')
const parseJson = (v) => {
  if (!v) return {}
  if (typeof v !== 'string') return v
  try {
    return JSON.parse(v)
  } catch {
    return {}
  }
}

// Note denominations in rupees from settings, largest first.
const denominations = () => String(state.settings.cash_denominations || '5000,1000,500,100,50,20,10,5,2,1')
  .split(',').map((x) => Number(x.trim())).filter((x) => x > 0).sort((a, b) => b - a)

// Note-count grid: count inputs per denomination and a live total. Returns html and a reader.
function noteGridHtml(id) {
  return `<div class="notes-grid" id="${id}">
    ${denominations().map((d) => `<label class="note-row"><span class="num">Rs ${d.toLocaleString('en-PK')} ×</span>
      <input type="number" min="0" step="1" inputmode="numeric" data-note="${d}" aria-label="Count of Rs ${d}">
      <span class="num muted" data-sub="${d}"></span></label>`).join('')}
    <div class="note-total"><span>Total</span><b class="num" data-total>${rs(0)}</b></div>
  </div>`
}
function readNotes(root) {
  const notes = {}
  let total = 0
  for (const el of $$('[data-note]', root)) {
    const n = Math.max(0, Math.floor(Number(el.value) || 0))
    if (!n) continue
    notes[el.dataset.note] = n
    total += Number(el.dataset.note) * n * 100
  }
  return { notes, total }
}
// Wires live subtotals; calls onChange(total) on every edit. Enter moves to the next count.
function bindNoteGrid(root, onChange) {
  const update = () => {
    for (const el of $$('[data-note]', root)) {
      const n = Math.max(0, Math.floor(Number(el.value) || 0))
      $(`[data-sub="${el.dataset.note}"]`, root).textContent = n ? rs(Number(el.dataset.note) * n * 100) : ''
    }
    const { total } = readNotes(root)
    $('[data-total]', root).textContent = rs(total)
    onChange?.(total)
  }
  root.addEventListener('input', update)
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !e.target.dataset.note) return
    e.preventDefault()
    const inputs = $$('[data-note]', root)
    const next = inputs[inputs.indexOf(e.target) + 1]
    if (next) next.focus()
    else root.closest('form')?.querySelector('button.primary')?.focus()
  })
  update()
}
function notesTableHtml(notes) {
  const entries = Object.entries(parseJson(notes)).filter(([, n]) => n > 0).sort((a, b) => b[0] - a[0])
  if (!entries.length) return ''
  return `<table>${entries.map(([d, n]) => `<tr><td>Rs ${esc(d)} × ${esc(n)}</td><td class="num">${toRupees(d * n * 100)}</td></tr>`).join('')}</table>`
}

// CSV / tab-separated parser with quoted fields ("a, b", "say ""hi""", embedded newlines).
function parseDelimited(text, delim) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  let i = 0
  const src = text.replace(/^﻿/, '')
  while (i < src.length) {
    const c = src[i]
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i += 2; continue }
      if (c === '"') { quoted = false; i++; continue }
      field += c
      i++
      continue
    }
    if (c === '"' && field === '') { quoted = true; i++; continue }
    if (c === delim) { row.push(field); field = ''; i++; continue }
    if (c === '\r' || c === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      i += c === '\r' && src[i + 1] === '\n' ? 2 : 1
      continue
    }
    field += c
    i++
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row) }
  return rows.filter((r) => r.some((v) => v.trim() !== ''))
}

// ---------- auth ----------

async function boot() {
  try {
    const { user } = await api('GET', '/auth/me')
    state.user = user
    await loadSettings()
    renderShell()
  } catch {
    renderAuth()
  }
}

async function loadSettings() {
  state.settings = await get('/settings')
}

async function renderAuth() {
  const { needsSetup, setupTokenRequired } = await get('/auth/status').catch(() => ({ needsSetup: false }))
  $('#modal-root').innerHTML = ''
  $('#app').innerHTML = needsSetup
    ? `<div class="auth"><form class="panel" id="auth-form">
        <h1>Set up your pharmacy</h1>
        <p class="muted">Create the owner (admin) account. You can add pharmacists and cashiers afterwards.</p>
        ${setupTokenRequired ? '<label class="field">Setup token (from the server configuration)<input name="setup_token" type="password" required autocomplete="off"></label>' : ''}
        <label class="field">Pharmacy name<input name="pharmacy_name" required></label>
        <label class="field">Your full name<input name="full_name" required></label>
        <label class="field">Username<input name="username" required autocomplete="username"></label>
        <label class="field">Password (8+ characters)<input name="password" type="password" minlength="8" required autocomplete="new-password"></label>
        <button class="primary">Create account</button>
      </form></div>`
    : `<div class="auth"><form class="panel" id="auth-form">
        <h1>Sign in</h1>
        <label class="field">Username<input name="username" required autocomplete="username"></label>
        <label class="field">Password<input name="password" type="password" required autocomplete="current-password"></label>
        <button class="primary">Sign in</button>
      </form></div>`
  $('#auth-form input').focus()
  $('#auth-form').addEventListener('submit', guard(async (e) => {
    e.preventDefault()
    const { user } = await post(needsSetup ? '/auth/setup' : '/auth/login', formData(e.target))
    state.user = user
    await loadSettings()
    location.hash = '#/pos'
    renderShell()
  }))
}

// ---------- shell & routing ----------

const ROUTES = [
  { path: 'pos', label: 'Point of sale', view: posView },
  { path: 'till', label: 'Till', view: tillView },
  { path: 'sales', label: 'Sales & returns', view: salesView },
  { path: 'products', label: 'Products', view: productsView },
  { path: 'stock', label: 'Stock & expiry', view: stockView },
  { path: 'purchases', label: 'Purchases', view: purchasesView, roles: ['admin', 'pharmacist'] },
  { path: 'suppliers', label: 'Suppliers', view: suppliersView, roles: ['admin', 'pharmacist'] },
  { path: 'reports', label: 'Reports', view: reportsView, roles: ['admin', 'pharmacist'] },
  { path: 'issues', label: 'Issues', view: issuesView, roles: ['admin', 'pharmacist'] },
  { path: 'users', label: 'Users', view: usersView, roles: ['admin'] },
  { path: 'owner', label: 'Owner', view: ownerView, ownerOnly: true },
  { path: 'settings', label: 'Settings', view: settingsView },
]
const allowed = () => ROUTES.filter((r) => (!r.roles || can(...r.roles)) && (!r.ownerOnly || state.user?.is_owner))
let teardown = null

function renderShell() {
  $('#app').innerHTML = `<div class="shell">
    <nav class="side">
      <div class="brand">${esc(state.settings.pharmacy_name)}</div>
      ${allowed().map((r) => `<a href="#/${r.path}" data-path="${r.path}">${r.label}</a>`).join('')}
      <div class="who">${esc(state.user.full_name)}<br><span>${esc(state.user.role)}${state.user.is_owner ? ' · owner' : ''}</span><br>
        <button class="link" id="logout">Sign out</button></div>
    </nav>
    <main id="view"></main>
  </div>`
  $('#logout').addEventListener('click', guard(async () => {
    await post('/auth/logout')
    state.user = null
    renderAuth()
  }))
  mountAssistant(assistantContext())
  route()
}

// What the assistant module (public/assistant.js) may use from the app.
function assistantContext() {
  return { state, api, get, post, toast, esc, rs, modal, guard }
}

function route() {
  if (!state.user || !$('#view')) return
  const path = location.hash.replace(/^#\//, '').split('?')[0] || 'pos'
  const r = allowed().find((x) => x.path === path) || allowed()[0]
  $$('nav.side a').forEach((a) => a.classList.toggle('active', a.dataset.path === r.path))
  teardown?.()
  teardown = null
  $('#modal-root').innerHTML = ''
  const view = $('#view')
  view.innerHTML = ''
  Promise.resolve(r.view(view)).then((t) => (teardown = typeof t === 'function' ? t : null)).catch((e) => toast(e.message, true))
}
window.addEventListener('hashchange', route)

// ---------- receipt ----------

function receiptLine(i) {
  const ps = i.pack_size || 1
  // Pack price from the line itself (unit_price is rounded per unit).
  const packPrice = i.pack_price ?? Math.round(((i.line_total + (i.discount || 0)) * ps) / i.qty)
  // Show the pack price only when at least one full pack was sold; loose-only lines show per unit.
  const each = ps > 1 && i.qty >= ps ? `${toRupees(packPrice)}/pk` : toRupees(i.unit_price)
  return `
    <tr><td colspan="3">${esc(i.product_name)} ${esc(i.strength || '')}${i.schedule !== 'otc' ? ' (Rx)' : ''}</td></tr>
    <tr><td>&nbsp; ${esc(qtyText(i.qty, ps))} @ ${each}${i.discount ? ` -${pct(i.discount_bps)}` : ''}</td>
      <td style="font-size:10px">B:${esc(i.batch_no)} E:${esc(String(i.expiry_date || '').slice(0, 7))}</td>
      <td class="num">${toRupees(i.line_total)}</td></tr>`
}

function receiptHtml(sale) {
  const s = state.settings
  const rows = sale.items.map(receiptLine).join('')
  const refunded = sale.returns?.reduce((t, r) => t + r.refund_total, 0) || 0
  return `<div class="receipt">
    <div class="c big">${esc(s.pharmacy_name)}</div>
    ${s.address ? `<div class="c">${esc(s.address)}</div>` : ''}
    ${s.phone ? `<div class="c">Ph: ${esc(s.phone)}</div>` : ''}
    ${s.drug_license_no ? `<div class="c">DSL: ${esc(s.drug_license_no)}</div>` : ''}
    ${s.ntn ? `<div class="c">NTN: ${esc(s.ntn)}${s.strn ? ` STRN: ${esc(s.strn)}` : ''}</div>` : ''}
    <hr>
    <div>Invoice: ${esc(sale.invoice_no)}</div>
    <div>Date: ${esc(sale.created_at)}</div>
    <div>Cashier: ${esc(sale.cashier_name)}</div>
    ${sale.customer_name ? `<div>Customer: ${esc(sale.customer_name)}</div>` : ''}
    ${sale.prescription ? `<div>Rx by: ${esc(sale.prescription.prescriber_name)}${sale.prescription.prescriber_reg_no ? ` (${esc(sale.prescription.prescriber_reg_no)})` : ''}</div>` : ''}
    <hr>
    <table>${rows}</table>
    <hr>
    <table>
      <tr><td>Subtotal</td><td class="num">${toRupees(sale.subtotal)}</td></tr>
      ${sale.discount ? `<tr><td>Discount</td><td class="num">-${toRupees(sale.discount)}</td></tr>` : ''}
      ${sale.round_off ? `<tr><td>Round off</td><td class="num">${toRupees(sale.round_off)}</td></tr>` : ''}
      <tr class="big"><td>TOTAL</td><td class="num">Rs ${toRupees(sale.total)}</td></tr>
      ${sale.tax ? `<tr><td>Incl. GST</td><td class="num">${toRupees(sale.tax)}</td></tr>` : ''}
      <tr><td>Paid (${esc(sale.payment_method)})</td><td class="num">${toRupees(sale.amount_paid)}</td></tr>
      ${sale.change_due ? `<tr><td>Change</td><td class="num">${toRupees(sale.change_due)}</td></tr>` : ''}
      ${refunded ? `<tr><td>Refunded</td><td class="num">-${toRupees(refunded)}</td></tr>` : ''}
    </table>
    <hr>
    <div class="c">${esc(s.receipt_footer)}</div>
    <div class="c">Thank you — get well soon</div>
  </div>`
}

// ---------- point of sale ----------

const DEFAULT_DISCOUNT_BPS = { cashier: 1000, pharmacist: 2500, admin: 10000 }
// Highest discount (in percent) a role may give, from the owner's policy settings.
const discountCapPct = (role) => {
  const bps = Number(state.settings[`max_discount_${role}_bps`] ?? DEFAULT_DISCOUNT_BPS[role] ?? 0)
  return (Number.isFinite(bps) ? bps : 0) / 100
}
const REFUND_LABELS = { cash: 'Cash', card: 'Card', wallet: 'Wallet' }
const canLoose = (p) => (p.pack_size || 1) > 1 && p.allow_loose !== 0
const lineUnits = (l) => l.packs * (l.product.pack_size || 1) + l.loose
const lineGross = (l) => packAmount(lineUnits(l), packPriceOf(l.product), l.product.pack_size)

// Till state for the signed-in user: { session, totals } or { unavailable } when the API can't tell.
async function fetchCurrentTill() {
  try {
    return await get('/tills/current')
  } catch (e) {
    return { session: null, unavailable: true, error: e.message }
  }
}
const tillBlocks = (till) => state.settings.require_open_till === '1' && till && !till.unavailable && !till.session

function posView(view) {
  const rxDefaults = () => ({ patient_name: '', patient_phone: '', patient_cnic: '', prescriber_name: '', prescriber_reg_no: '', rx_date: today(), notes: '' })
  const pos = { cart: [], results: [], hl: 0, method: 'cash', paid: '', customer: '', phone: '', rx: rxDefaults(), busy: false, till: null }
  const maxDiscount = discountCapPct(state.user.role)

  view.innerHTML = `<div class="pos">
    <div class="stack">
      <div id="till-banner"></div>
      <div class="search-box">
        <input id="q" placeholder="Scan barcode or search medicine / generic name   (F2)" autocomplete="off">
        <div class="results" id="results" hidden></div>
      </div>
      <div class="panel" id="cart"></div>
    </div>
    <div class="stack" id="side"></div>
  </div>`

  const q = $('#q', view)
  let timer = null
  let searchSeq = 0

  async function loadTill() {
    pos.till = await fetchCurrentTill()
    renderTillBanner()
    renderSide()
  }

  function renderTillBanner() {
    const box = $('#till-banner', view)
    if (!box || !view.contains(q)) return
    box.innerHTML = tillBlocks(pos.till)
      ? `<div class="banner"><div><b>Your till is closed.</b> Open it with the cash in the drawer before selling.</div>
          <button class="primary" id="open-till">Open till</button></div>`
      : ''
    $('#open-till', box)?.addEventListener('click', () => openTillDialog(loadTill))
  }

  function tillStatusHtml() {
    const t = pos.till
    if (!t) return '<div class="till-status muted">Checking till…</div>'
    if (t.unavailable) return '<div class="till-status muted">Till status unavailable</div>'
    if (!t.session) return `<div class="till-status muted">Till closed · <a href="#/till">Till</a></div>`
    return `<div class="till-status"><span class="badge ok">Till open</span> since ${esc(String(t.session.opened_at || '').slice(11, 16))}
      · expected cash <b>${rs(t.totals?.expected_cash)}</b> · <a href="#/till">Till</a></div>`
  }

  async function search(text) {
    const seq = ++searchSeq
    const list = text ? await get(`/products?q=${encodeURIComponent(text)}&limit=20`) : []
    if (seq !== searchSeq) return null
    pos.results = list
    pos.hl = 0
    renderResults()
    return list
  }

  function renderResults() {
    const box = $('#results', view)
    box.hidden = pos.results.length === 0 || !q.value.trim()
    box.innerHTML = pos.results.map((p, i) => `
      <button data-i="${i}" class="${i === pos.hl ? 'hl' : ''}">
        <div style="flex:1"><div class="name">${esc(productLabel(p))} ${schedBadge(p.schedule)}</div>
          <div class="muted">${esc(p.generic_name || '')}${p.manufacturer ? ' · ' + esc(p.manufacturer) : ''}${p.shelf_location ? ' · shelf ' + esc(p.shelf_location) : ''}</div></div>
        <div class="num"><div>${rs(packPriceOf(p))}${(p.pack_size || 1) > 1 ? `<span class="muted">/${esc(p.packing || 'pack')} of ${p.pack_size}</span>` : ''}</div>
          <div class="muted">${p.stock > 0 ? `${esc(packsText(p.stock, p.pack_size))} in stock` : '<span class="badge expired">Out of stock</span>'}</div></div>
      </button>`).join('')
  }

  // Adds one pack (or one loose unit when default_sale_unit is 'unit' and the item sells loose).
  function addToCart(p) {
    if (p.stock <= 0) return toast(`${p.name} is out of stock`, true)
    const byUnit = state.settings.default_sale_unit === 'unit' && canLoose(p)
    const ps = p.pack_size || 1
    let line = pos.cart.find((l) => l.product.id === p.id)
    const isNew = !line
    if (!line) line = { product: p, packs: 0, loose: 0, discount: 0 }
    const next = byUnit ? { packs: line.packs, loose: line.loose + 1 } : { packs: line.packs + 1, loose: line.loose }
    if (next.loose >= ps && ps > 1) { next.packs += Math.floor(next.loose / ps); next.loose %= ps }
    const units = next.packs * ps + next.loose
    if (units > p.stock) return toast(`Only ${packsText(p.stock, ps)} of ${p.name} in stock`, true)
    Object.assign(line, next)
    if (isNew) pos.cart.push(line)
    q.value = ''
    pos.results = []
    renderResults()
    render()
    q.focus()
  }

  const totals = () => {
    let subtotal = 0
    let discount = 0
    for (const l of pos.cart) {
      const gross = lineGross(l)
      subtotal += gross
      discount += Math.round((gross * l.discount) / 100)
    }
    const net = subtotal - discount
    const total = state.settings.round_to_rupee === '1' ? Math.round(net / 100) * 100 : net
    return { subtotal, discount, total, roundOff: total - net }
  }
  const needsRx = () => pos.cart.some((l) => l.product.schedule !== 'otc')
  const needsControlled = () => pos.cart.some((l) => l.product.schedule === 'controlled')

  function cartRow(l, i) {
    const p = l.product
    const ps = p.pack_size || 1
    const gross = lineGross(l)
    return `<tr>
      <td>${esc(productLabel(p))} ${schedBadge(p.schedule)}
        <div class="muted">${esc(packsText(p.stock, ps))} in stock${ps > 1 ? ` · ${esc(p.packing || 'pack')} of ${ps}` : ''}${p.next_expiry ? ` · exp ${esc(p.next_expiry)}` : ''}</div></td>
      <td class="num">${rs(packPriceOf(p))}</td>
      <td><input type="number" min="0" value="${l.packs}" data-packs="${i}" aria-label="Packs" class="qty"></td>
      <td>${canLoose(p) ? `<input type="number" min="0" max="${ps - 1}" value="${l.loose}" data-loose="${i}" aria-label="Loose units" class="qty">` : '<span class="muted">—</span>'}</td>
      <td><input type="number" min="0" max="${maxDiscount}" step="0.5" value="${l.discount}" data-disc="${i}" aria-label="Discount percent" class="qty"></td>
      <td class="num">${rs(gross - Math.round((gross * l.discount) / 100))}</td>
      <td><button class="link danger" data-rm="${i}" aria-label="Remove">✕</button></td>
    </tr>`
  }

  function render() {
    const cart = $('#cart', view)
    cart.innerHTML = pos.cart.length === 0
      ? '<div class="cart-empty">Cart is empty. Scan a barcode or search to add medicines.</div>'
      : `<div class="table-wrap"><table class="cart-table">
          <thead><tr><th>Item</th><th class="num">Pack price</th><th>Packs</th><th>Loose</th><th>Disc %</th><th class="num">Total</th><th></th></tr></thead>
          <tbody>${pos.cart.map(cartRow).join('')}</tbody></table></div>`
    renderSide()
  }

  function renderSide() {
    const t = totals()
    const paid = pos.paid === '' ? t.total : toPaisa(pos.paid) || 0
    const change = paid - t.total
    const side = $('#side', view)
    if (!side || !view.contains(q)) return
    const rx = pos.rx
    const blocked = tillBlocks(pos.till)
    side.innerHTML = `
      ${tillStatusHtml()}
      <div class="panel totals">
        <div><span>Subtotal</span><span class="num">${rs(t.subtotal)}</span></div>
        ${t.discount ? `<div><span>Discount</span><span class="num">-${rs(t.discount)}</span></div>` : ''}
        ${t.roundOff ? `<div><span>Round off</span><span class="num">${rs(t.roundOff)}</span></div>` : ''}
        <div class="grand"><span>Total</span><span class="num">${rs(t.total)}</span></div>
        <div class="muted" style="font-size:12px">Prices include GST. Final amounts are priced per batch on the receipt.</div>
      </div>
      ${needsRx() ? `<form class="rx-panel stack" id="rx">
        <h3>Prescription ${needsControlled() ? '— controlled drug' : ''}</h3>
        <label class="field">Patient name *<input name="patient_name" value="${esc(rx.patient_name)}" required></label>
        <div class="row">
          <label class="field" style="flex:1">Patient phone<input name="patient_phone" value="${esc(rx.patient_phone)}"></label>
          <label class="field" style="flex:1">Patient CNIC ${needsControlled() ? '*' : ''}<input name="patient_cnic" value="${esc(rx.patient_cnic)}" placeholder="00000-0000000-0"></label>
        </div>
        <label class="field">Prescriber (doctor) *<input name="prescriber_name" value="${esc(rx.prescriber_name)}"></label>
        <div class="row">
          <label class="field" style="flex:1">PMDC reg. no ${needsControlled() ? '*' : ''}<input name="prescriber_reg_no" value="${esc(rx.prescriber_reg_no)}"></label>
          <label class="field" style="flex:1">Rx date<input type="date" name="rx_date" value="${esc(rx.rx_date)}"></label>
        </div>
        ${needsControlled() && state.user.role === 'cashier' ? '<div class="alert">A pharmacist must complete sales of controlled drugs.</div>' : ''}
      </form>` : ''}
      <div class="panel stack">
        <div class="row">
          <label class="field" style="flex:1">Customer<input id="cust" value="${esc(pos.customer)}" placeholder="Optional"></label>
          <label class="field" style="flex:1">Phone<input id="phone" value="${esc(pos.phone)}" placeholder="Optional"></label>
        </div>
        <div class="pay-methods">
          ${['cash', 'card', 'wallet'].map((m) => `<button type="button" data-method="${m}" class="${pos.method === m ? 'sel' : ''}">${{ cash: 'Cash', card: 'Card', wallet: 'JazzCash / Easypaisa' }[m]}</button>`).join('')}
        </div>
        ${pos.method === 'cash' ? `
          <div class="row">
            <label class="field" style="flex:1">Cash received<input id="paid" inputmode="decimal" value="${esc(pos.paid)}" placeholder="${toRupees(t.total)}"></label>
            <div class="spacer"></div>
            <div class="num"><div class="muted">Change</div><div style="font-size:20px;font-weight:700;${change < 0 ? 'color:var(--danger)' : ''}">${rs(change)}</div></div>
          </div>` : ''}
        <button class="primary checkout" id="checkout" ${pos.cart.length === 0 || pos.busy || blocked ? 'disabled' : ''}>Complete sale <span class="kbd">F9</span></button>
        ${blocked ? '<div class="alert">Open your till to complete sales.</div>' : ''}
        ${pos.cart.length ? '<button id="clear" class="link danger">Clear cart</button>' : ''}
      </div>`

    $('#rx', side)?.addEventListener('input', (e) => (pos.rx[e.target.name] = e.target.value))
    $('#cust', side).addEventListener('input', (e) => (pos.customer = e.target.value))
    $('#phone', side).addEventListener('input', (e) => (pos.phone = e.target.value))
    $$('[data-method]', side).forEach((b) => b.addEventListener('click', () => {
      pos.method = b.dataset.method
      renderSide()
    }))
    const paidInput = $('#paid', side)
    paidInput?.addEventListener('input', (e) => {
      pos.paid = e.target.value
      const cursor = e.target.selectionStart
      renderSide()
      const again = $('#paid', side)
      again.focus()
      again.setSelectionRange(cursor, cursor)
    })
    paidInput?.addEventListener('keydown', (e) => e.key === 'Enter' && checkout())
    $('#checkout', side).addEventListener('click', checkout)
    $('#clear', side)?.addEventListener('click', reset)
  }

  function reset() {
    Object.assign(pos, { cart: [], method: 'cash', paid: '', customer: '', phone: '', rx: rxDefaults() })
    render()
    q.focus()
  }

  const checkout = guard(async () => {
    if (!pos.cart.length || pos.busy) return
    if (tillBlocks(pos.till)) return toast('Open your till before selling', true)
    const t = totals()
    const body = {
      items: pos.cart.map((l) => ({ product_id: l.product.id, packs: l.packs, loose: l.loose, discount_bps: Math.round(l.discount * 100) })),
      payment_method: pos.method,
      customer_name: pos.customer,
      customer_phone: pos.phone,
    }
    if (pos.method === 'cash') body.amount_paid = pos.paid === '' ? t.total : toPaisa(pos.paid)
    if (needsRx()) body.prescription = pos.rx
    pos.busy = true
    renderSide()
    try {
      const sale = await post('/sales', body)
      reset()
      // Server priced by batch and may round differently; cash tendered must still cover it.
      const m = modal(`
        <h2>Sale complete — ${esc(sale.invoice_no)}</h2>
        ${sale.change_due ? `<p style="font-size:22px">Change due: <b>${rs(sale.change_due)}</b></p>` : ''}
        <div style="background:#fff;border:1px solid var(--border);border-radius:6px;padding:8px;max-height:50vh;overflow:auto">${receiptHtml(sale)}</div>
        <div class="actions"><button id="print">Print receipt</button><button class="primary" data-close>New sale (Enter)</button></div>`,
      { onClose: () => q.focus() })
      $('#print', m.el).addEventListener('click', () => printHtml(receiptHtml(sale)))
      $('[data-close]', m.el).focus()
    } finally {
      pos.busy = false
      loadTill()
    }
  })

  // Packs/loose edits: loose overflow rolls into packs; zero or over-stock reverts.
  function setQty(line, packs, loose) {
    const ps = line.product.pack_size || 1
    let p = Math.max(0, Math.floor(packs) || 0)
    let lo = canLoose(line.product) ? Math.max(0, Math.floor(loose) || 0) : 0
    if (ps > 1 && lo >= ps) { p += Math.floor(lo / ps); lo %= ps }
    const units = p * ps + lo
    if (units < 1) return toast('Quantity must be at least 1 — use ✕ to remove the line', true)
    if (units > line.product.stock) return toast(`Only ${packsText(line.product.stock, ps)} in stock`, true)
    line.packs = p
    line.loose = lo
  }

  q.addEventListener('input', () => {
    clearTimeout(timer)
    timer = setTimeout(() => search(q.value.trim()).catch((e) => toast(e.message, true)), 150)
  })
  q.addEventListener('keydown', guard(async (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const n = pos.results.length
      if (n) pos.hl = (pos.hl + (e.key === 'ArrowDown' ? 1 : n - 1)) % n
      renderResults()
    } else if (e.key === 'Escape') {
      q.value = ''
      pos.results = []
      renderResults()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const text = q.value.trim()
      if (!text) return
      clearTimeout(timer)
      // Barcode scanners type the code and press Enter: prefer an exact barcode match.
      const list = (await search(text)) || pos.results
      const exact = list.find((p) => p.barcode === text)
      const pick = exact || list[pos.hl] || (list.length === 1 ? list[0] : null)
      if (pick) addToCart(pick)
      else toast(`No product matches "${text}"`, true)
    }
  }))
  $('#results', view).addEventListener('click', (e) => {
    const b = e.target.closest('button[data-i]')
    if (b) addToCart(pos.results[Number(b.dataset.i)])
  })
  $('#cart', view).addEventListener('change', (e) => {
    const { packs, loose, disc } = e.target.dataset
    const idx = packs ?? loose ?? disc
    if (idx === undefined) return
    const line = pos.cart[idx]
    if (packs !== undefined) setQty(line, Number(e.target.value), line.loose)
    if (loose !== undefined) setQty(line, line.packs, Number(e.target.value))
    if (disc !== undefined) {
      const v = Math.max(0, Number(e.target.value) || 0)
      if (v > maxDiscount) toast(`Your maximum discount is ${maxDiscount}%`, true)
      line.discount = Math.min(v, maxDiscount)
    }
    render()
  })
  $('#cart', view).addEventListener('keydown', (e) => {
    // Leaving the input fires its change event, which re-renders the cart.
    if (e.key === 'Enter' && e.target.matches('input')) q.focus()
  })
  $('#cart', view).addEventListener('click', (e) => {
    const b = e.target.closest('[data-rm]')
    if (!b) return
    pos.cart.splice(Number(b.dataset.rm), 1)
    render()
  })

  const onKey = (e) => {
    if ($('.modal-bg')) return
    if (e.key === 'F2') {
      e.preventDefault()
      q.focus()
    }
    if (e.key === 'F9') {
      e.preventDefault()
      checkout()
    }
  }
  document.addEventListener('keydown', onKey)
  render()
  loadTill()
  q.focus()
  return () => document.removeEventListener('keydown', onKey)
}

// ---------- sales & returns ----------

async function salesView(view) {
  const f = { from: today(), to: today(), q: '' }
  view.innerHTML = `<div class="stack">
    <div class="row"><h1>Sales & returns</h1><div class="spacer"></div>
      <input type="date" id="from" value="${f.from}" aria-label="From"> – <input type="date" id="to" value="${f.to}" aria-label="To">
      <input id="sq" placeholder="Invoice, customer or phone"></div>
    <div class="panel table-wrap" id="list"></div></div>`

  async function load() {
    const rows = await get(`/sales?from=${f.from}&to=${f.to}&q=${encodeURIComponent(f.q)}`)
    $('#list', view).innerHTML = rows.length === 0
      ? '<p class="muted">No sales in this period.</p>'
      : `<table><thead><tr><th>Invoice</th><th>Time</th><th>Customer</th><th>Cashier</th><th>Payment</th><th class="num">Total</th><th class="num">Refunded</th></tr></thead>
        <tbody>${rows.map((s) => `<tr class="clickable" data-id="${s.id}">
          <td>${esc(s.invoice_no)} ${s.prescription_id ? '<span class="badge rx">Rx</span>' : ''}</td><td>${esc(s.created_at)}</td>
          <td>${esc(s.customer_name || '')}</td><td>${esc(s.cashier_name)}</td><td>${esc(s.payment_method)}</td>
          <td class="num">${rs(s.total)}</td><td class="num">${s.refunded ? rs(s.refunded) : ''}</td></tr>`).join('')}</tbody></table>`
  }
  $('#from', view).addEventListener('change', (e) => { f.from = e.target.value; load().catch((x) => toast(x.message, true)) })
  $('#to', view).addEventListener('change', (e) => { f.to = e.target.value; load().catch((x) => toast(x.message, true)) })
  let t
  $('#sq', view).addEventListener('input', (e) => {
    f.q = e.target.value
    clearTimeout(t)
    t = setTimeout(() => load().catch((x) => toast(x.message, true)), 250)
  })
  $('#list', view).addEventListener('click', guard(async (e) => {
    const tr = e.target.closest('tr[data-id]')
    if (tr) openSale(Number(tr.dataset.id), load)
  }))
  await load()
}

async function openSale(id, onChange) {
  const sale = await get(`/sales/${id}`)
  const canReturn = can('admin', 'pharmacist')
  const returnable = sale.items.filter((i) => i.qty > i.returned_qty)
  const toOriginal = state.settings.refund_card_sales === 'original' && ['card', 'wallet'].includes(sale.payment_method)
  const m = modal(`
    <div class="row"><h2>${esc(sale.invoice_no)}</h2><div class="spacer"></div><button id="print">Print receipt</button></div>
    ${sale.prescription ? `<p class="muted">Rx: ${esc(sale.prescription.patient_name)}${sale.prescription.patient_cnic ? ` (${esc(sale.prescription.patient_cnic)})` : ''}
      — ${esc(sale.prescription.prescriber_name)}${sale.prescription.prescriber_reg_no ? `, ${esc(sale.prescription.prescriber_reg_no)}` : ''}</p>` : ''}
    <form id="ret"><div class="table-wrap"><table>
      <thead><tr><th>Item</th><th>Batch</th><th class="num">Qty</th><th class="num">Line total</th>${canReturn ? '<th>Return (units)</th>' : ''}</tr></thead>
      <tbody>${sale.items.map((i) => `<tr>
        <td>${esc(i.product_name)} ${esc(i.strength || '')} ${schedBadge(i.schedule)}</td>
        <td>${esc(i.batch_no)} <span class="muted">${esc(i.expiry_date)}</span></td>
        <td class="num">${esc(qtyText(i.qty, i.pack_size))}${i.returned_qty ? ` <span class="muted">(${i.returned_qty} units returned)</span>` : ''}</td>
        <td class="num">${rs(i.line_total)}</td>
        ${canReturn ? `<td>${i.qty > i.returned_qty ? `<input type="number" min="0" max="${i.qty - i.returned_qty}" value="0" name="r${i.id}" aria-label="Return quantity (units)">` : ''}</td>` : ''}
      </tr>`).join('')}</tbody></table></div>
      <p class="num">Total ${rs(sale.total)} · ${esc(sale.payment_method)} · ${esc(sale.created_at)} · ${esc(sale.cashier_name)}</p>
      ${sale.returns.length ? `<h3>Returns</h3><ul>${sale.returns.map((r) => `<li>${esc(r.created_at)} — ${rs(r.refund_total)} (${esc(REFUND_LABELS[r.refund_method] || 'Cash')}) by ${esc(r.user_name)}: ${esc(r.reason)}</li>`).join('')}</ul>` : ''}
      ${canReturn && returnable.length ? `<div class="row"><label class="field" style="flex:1">Return reason<input name="reason" placeholder="e.g. wrong item, unopened"></label>
        <label class="row" style="font-size:13px"><input type="checkbox" name="restock" checked> Put back in stock</label></div>
        <p class="muted" style="font-size:13px" id="refund-note">${toOriginal ? `Refund goes back to ${esc(sale.payment_method === 'wallet' ? 'the wallet' : 'the card')} (no till needed).` : 'Refund is paid in cash from your till drawer.'}</p>` : ''}
      <div class="actions"><button type="button" data-close>Close</button>${canReturn && returnable.length ? '<button class="primary">Process return</button>' : ''}</div>
    </form>`, { wide: true })
  $('#print', m.el).addEventListener('click', () => printHtml(receiptHtml(sale)))
  $('#ret', m.el).addEventListener('submit', guard(async (e) => {
    e.preventDefault()
    const d = formData(e.target)
    const items = sale.items
      .map((i) => ({ sale_item_id: i.id, qty: Number(d[`r${i.id}`] || 0), restock: d.restock }))
      .filter((i) => i.qty > 0)
    if (!items.length) return toast('Enter a quantity to return', true)
    const updated = await post(`/sales/${id}/returns`, { items, reason: d.reason })
    const refund = updated.returns.at(-1).refund_total
    m.close()
    toast(`Return recorded. Refund ${rs(refund)}`)
    onChange?.()
  }))
}

// ---------- products ----------

const PACKINGS = ['Strip', 'Box', 'Bottle', 'Tube', 'Vial', 'Sachet']
const packingText = (p) => ((p.pack_size || 1) > 1 || p.packing ? `${esc(p.packing || 'Pack')}${(p.pack_size || 1) > 1 ? ` of ${p.pack_size}` : ''}` : '')

async function productsView(view) {
  const editable = can('admin', 'pharmacist')
  view.innerHTML = `<div class="stack">
    <div class="row"><h1>Products</h1><div class="spacer"></div>
      <input id="pq" placeholder="Search name, generic or barcode">
      <label class="row" style="font-size:13px"><input type="checkbox" id="inactive"> Show inactive</label>
      ${editable ? '<button id="import">Import items</button><button class="primary" id="add">Add product</button>' : ''}</div>
    <div class="panel table-wrap" id="list"></div></div>`
  const load = async () => {
    const qv = encodeURIComponent($('#pq', view).value.trim())
    const rows = await get(`/products?q=${qv}&limit=500${$('#inactive', view).checked ? '&all=1' : ''}`)
    const more = rows.length === 500 ? '<p class="muted" style="font-size:13px">Showing the first 500 items. Search to find others.</p>' : ''
    $('#list', view).innerHTML = rows.length === 0 ? '<p class="muted">No products yet.</p>' : more + `<table>
      <thead><tr><th>Name</th><th>Generic</th><th>Barcode</th><th>Packing</th><th class="num">Pack price</th><th class="num">GST</th><th class="num">Stock</th><th>Next expiry</th></tr></thead>
      <tbody>${rows.map((p) => `<tr class="${editable ? 'clickable' : ''}" data-id="${p.id}">
        <td>${esc(productLabel(p))} ${schedBadge(p.schedule)} ${p.active ? '' : '<span class="muted">(inactive)</span>'}
          ${p.shelf_location ? `<div class="muted" style="font-size:12px">Shelf ${esc(p.shelf_location)}</div>` : ''}</td>
        <td>${esc(p.generic_name || '')}</td><td>${esc(p.barcode || '')}</td><td>${packingText(p)}</td>
        <td class="num">${rs(packPriceOf(p))}</td><td class="num">${pct(p.gst_rate_bps)}</td>
        <td class="num">${esc(packsText(p.stock, p.pack_size))}${p.reorder_level && p.stock <= p.reorder_level ? ' <span class="badge near">Low</span>' : ''}</td>
        <td>${esc(p.next_expiry || '')}</td></tr>`).join('')}</tbody></table>`
  }
  let t
  $('#pq', view).addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => load().catch((e) => toast(e.message, true)), 200) })
  $('#inactive', view).addEventListener('change', guard(load))
  $('#add', view)?.addEventListener('click', () => productForm(null, load))
  $('#import', view)?.addEventListener('click', () => importDialog(load))
  $('#list', view).addEventListener('click', guard(async (e) => {
    const tr = e.target.closest('tr[data-id]')
    if (tr && editable) productForm(await get(`/products/${tr.dataset.id}`), load)
  }))
  await load()
}

function productForm(p, onSaved) {
  const v = p || { schedule: 'otc', pack_size: 1, gst_rate_bps: Number(state.settings.default_gst_rate_bps) || 0, reorder_level: 0, pack_price: 0, allow_loose: 1, active: 1 }
  const packPrice = v.pack_price ?? (v.sale_price || 0) * (v.pack_size || 1)
  const m = modal(`<form id="pf">
    <h2>${p ? 'Edit product' : 'Add product'}</h2>
    <div class="grid">
      <label class="field">Brand name *<input name="name" value="${esc(v.name)}" required></label>
      <label class="field">Generic name<input name="generic_name" value="${esc(v.generic_name)}"></label>
      <label class="field">Strength<input name="strength" value="${esc(v.strength)}" placeholder="500mg"></label>
      <label class="field">Form<input name="form" value="${esc(v.form)}" placeholder="Tablet" list="forms"></label>
      <label class="field">Manufacturer<input name="manufacturer" value="${esc(v.manufacturer)}"></label>
      <label class="field">Category<input name="category" value="${esc(v.category)}"></label>
      <label class="field">Barcode / item code<input name="barcode" value="${esc(v.barcode)}"></label>
      <label class="field">Packing<input name="packing" value="${esc(v.packing)}" list="packings" placeholder="Strip"></label>
      <label class="field">Units per pack<input name="pack_size" type="number" min="1" value="${esc(v.pack_size || 1)}"></label>
      <label class="field">Pack price (Rs, incl. GST) *<input name="pack_price" inputmode="decimal" value="${toRupees(packPrice)}" required></label>
      <label class="field">Schedule
        <select name="schedule">
          <option value="otc" ${v.schedule === 'otc' ? 'selected' : ''}>OTC (no prescription)</option>
          <option value="rx" ${v.schedule === 'rx' ? 'selected' : ''}>Prescription only</option>
          <option value="controlled" ${v.schedule === 'controlled' ? 'selected' : ''}>Controlled / narcotic</option>
        </select></label>
      <label class="field">GST %<input name="gst" type="number" min="0" max="100" step="0.01" value="${Number(v.gst_rate_bps) / 100}"></label>
      <label class="field">Reorder level (units)<input name="reorder_level" type="number" min="0" value="${esc(v.reorder_level)}"></label>
      <label class="field">Shelf location<input name="shelf_location" value="${esc(v.shelf_location)}" placeholder="A-3"></label>
    </div>
    <datalist id="forms">${['Tablet', 'Capsule', 'Syrup', 'Suspension', 'Injection', 'Drops', 'Cream', 'Ointment', 'Inhaler', 'Sachet', 'Suppository'].map((f) => `<option value="${f}">`).join('')}</datalist>
    <datalist id="packings">${PACKINGS.map((f) => `<option value="${f}">`).join('')}</datalist>
    <p class="muted" style="font-size:13px" id="unit-price"></p>
    <label class="row" style="margin-top:10px"><input type="checkbox" name="allow_loose" ${v.allow_loose !== 0 ? 'checked' : ''}> Can be sold loose (single units)</label>
    <label class="row" style="margin-top:6px"><input type="checkbox" name="active" ${v.active ? 'checked' : ''}> Active (available for sale)</label>
    <p class="muted" style="font-size:13px">Stock is added through Purchases, which records batch numbers and expiry dates.</p>
    <div class="actions"><button type="button" data-close>Cancel</button><button class="primary">Save</button></div>
  </form>`, { wide: true })
  const form = $('#pf', m.el)
  const showUnit = () => {
    const ps = Number(form.pack_size.value) || 1
    const pp = paisaOrNull(form.pack_price.value)
    $('#unit-price', m.el).textContent = ps > 1 && pp !== null ? `Per unit: ${rs(Math.round(pp / ps))} (loose units are priced pro rata)` : ''
  }
  form.addEventListener('input', showUnit)
  showUnit()
  form.addEventListener('submit', guard(async (e) => {
    e.preventDefault()
    const d = formData(e.target)
    const body = { ...d, pack_size: Number(d.pack_size) || 1, pack_price: paisaOrNull(d.pack_price), gst_rate_bps: Math.round(Number(d.gst || 0) * 100) }
    delete body.gst
    if (body.pack_price === null || body.pack_price < 0) throw new Error('Enter a valid pack price')
    if (p) await put(`/products/${p.id}`, body)
    else await post('/products', body)
    m.close()
    toast('Product saved')
    onSaved()
  }))
}

// ---------- item import (paste from Excel or CSV) ----------

// MultiTec / Excel header names, compared lower-case with spaces and punctuation removed.
const IMPORT_HEADERS = {
  barcode: ['barcode', 'itemcode', 'code'],
  name: ['itemname', 'name'],
  manufacturer: ['manufacturer', 'company'],
  pack_size: ['packunit', 'punit', 'packsize', 'unitsperpack'],
  category: ['category'],
  generic_name: ['generic', 'genericname'],
  pack_price: ['saleprice', 'packprice', 'mrp'],
  form: ['form'],
  strength: ['strength'],
  schedule: ['schedule'],
}
const headerKey = (h) => {
  const k = String(h).toLowerCase().replace(/[^a-z0-9]/g, '')
  return Object.keys(IMPORT_HEADERS).find((f) => IMPORT_HEADERS[f].includes(k)) || null
}

// Turns pasted/CSV text into import rows. Money columns are rupees in the file, paisa to the API.
function parseImport(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] || ''
  const delim = firstLine.includes('\t') ? '\t' : firstLine.includes(';') && !firstLine.includes(',') ? ';' : ','
  const [header = [], ...data] = parseDelimited(text, delim)
  const keys = header.map(headerKey)
  const unmapped = header.filter((h, i) => !keys[i] && h.trim())
  const rows = data.map((cells) => {
    const row = {}
    keys.forEach((k, i) => {
      const v = String(cells[i] ?? '').trim()
      if (!k || v === '') return
      if (k === 'pack_price') {
        const n = paisaOrNull(v.replace(/^rs\.?\s*/i, ''))
        if (n !== null) row.pack_price = n
      } else if (k === 'pack_size') {
        const n = parseInt(v, 10)
        if (n > 0) row.pack_size = n
      } else {
        row[k] = v
      }
    })
    return row
  }).filter((r) => Object.keys(r).length)
  return { header, keys, unmapped, rows }
}

function importPreviewHtml(parsed) {
  const { rows, unmapped, keys } = parsed
  if (!rows.length) return '<p class="muted">No data rows found. The first row must be the column headers.</p>'
  const cols = Object.keys(IMPORT_HEADERS).filter((k) => keys.includes(k))
  return `<p><b>${rows.length}</b> row${rows.length === 1 ? '' : 's'} ready. Columns used: ${cols.map(esc).join(', ') || 'none'}.
      ${unmapped.length ? `<br><span class="muted">Ignored columns: ${unmapped.map(esc).join(', ')}</span>` : ''}
      ${cols.includes('name') ? '' : '<br><span style="color:var(--danger)">No item name column found (Item Name / Name).</span>'}</p>
    <div class="table-wrap" style="max-height:300px;overflow:auto"><table>
      <thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
      <tbody>${rows.slice(0, 20).map((r) => `<tr>${cols.map((c) => `<td class="${c === 'pack_price' || c === 'pack_size' ? 'num' : ''}">${c === 'pack_price' ? (r[c] !== undefined ? rs(r[c]) : '') : esc(r[c] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody>
    </table></div>
    ${rows.length > 20 ? `<p class="muted">Showing the first 20 of ${rows.length} rows.</p>` : ''}`
}

function importDialog(onDone) {
  let parsed = { rows: [] }
  const m = modal(`<div class="stack">
    <h2>Import items</h2>
    <p class="muted" style="font-size:13px">Copy the item list in Excel (including the header row) and paste it below, or choose a .csv file.
      Recognised columns: Barcode / Item Code, Item Name, Manufacturer / Company, PackUnit / P/Unit, Category, Generic, Sale Price / MRP (Rs per pack), Form, Strength, Schedule.
      Existing items are matched by barcode, otherwise by exact name, and updated.</p>
    <textarea id="imp-text" rows="6" placeholder="Paste rows from Excel here" style="width:100%;font-family:ui-monospace,monospace;font-size:12px"></textarea>
    <div class="row"><label class="field">Or choose a CSV file<input type="file" id="imp-file" accept=".csv,.txt,text/csv"></label></div>
    <div id="imp-preview"></div>
    <div id="imp-result"></div>
    <div class="actions"><button type="button" data-close>Close</button><button class="primary" id="imp-go" disabled>Import</button></div>
  </div>`, { wide: true })
  const preview = () => {
    const text = $('#imp-text', m.el).value
    parsed = text.trim() ? parseImport(text) : { rows: [] }
    $('#imp-preview', m.el).innerHTML = text.trim() ? importPreviewHtml(parsed) : ''
    $('#imp-go', m.el).disabled = !parsed.rows.length
  }
  $('#imp-text', m.el).addEventListener('input', preview)
  $('#imp-file', m.el).addEventListener('change', guard(async (e) => {
    const file = e.target.files[0]
    if (!file) return
    $('#imp-text', m.el).value = await file.text()
    preview()
  }))
  $('#imp-go', m.el).addEventListener('click', guard(async (e) => {
    const btn = e.target
    btn.disabled = true
    const out = $('#imp-result', m.el)
    const result = { created: 0, updated: 0, errors: [] }
    const CHUNK = 1000
    try {
      for (let i = 0; i < parsed.rows.length; i += CHUNK) {
        out.innerHTML = `<p class="muted">Importing rows ${i + 1}–${Math.min(i + CHUNK, parsed.rows.length)} of ${parsed.rows.length}…</p>`
        const r = await post('/products/import', { rows: parsed.rows.slice(i, i + CHUNK) })
        result.created += r.created
        result.updated += r.updated
        result.errors.push(...(r.errors || []).map((x) => ({ ...x, row: x.row + i })))
      }
    } finally {
      btn.disabled = false
      out.innerHTML = importResultHtml(result)
    }
    toast(`Import done: ${result.created} created, ${result.updated} updated`)
    onDone?.()
  }))
}

const importResultHtml = (r) => `<div class="panel">
  <b>${r.created}</b> created · <b>${r.updated}</b> updated · <b>${r.errors.length}</b> error${r.errors.length === 1 ? '' : 's'}
  ${r.errors.length ? `<ul style="max-height:160px;overflow:auto;font-size:13px">${r.errors.slice(0, 200).map((x) => `<li>Row ${esc(x.row)}: ${esc(x.message)}</li>`).join('')}</ul>` : ''}
</div>`

// ---------- stock & expiry ----------

async function stockView(view) {
  const editable = can('admin', 'pharmacist')
  let status = 'all'
  view.innerHTML = `<div class="stack">
    <div class="row"><h1>Stock & expiry</h1></div>
    <div class="tabs" id="tabs">
      <button data-s="all" class="sel">All batches</button><button data-s="near">Expiring soon</button><button data-s="expired">Expired</button>
      ${editable ? '<button data-s="moves">Stock movements</button>' : ''}
    </div>
    <div class="panel table-wrap" id="list"></div></div>`

  async function load() {
    const list = $('#list', view)
    if (status === 'moves') {
      const rows = await get('/inventory/movements')
      list.innerHTML = `<table><thead><tr><th>When</th><th>Product</th><th>Batch</th><th>Reason</th><th class="num">Change</th><th class="num">Balance</th><th>By</th><th>Note</th></tr></thead>
        <tbody>${rows.map((m) => `<tr><td>${esc(m.created_at)}</td><td>${esc(m.product_name)}</td><td>${esc(m.batch_no)}</td><td>${esc(m.reason)}</td>
          <td class="num">${m.change > 0 ? '+' : ''}${m.change}</td><td class="num">${m.balance}</td><td>${esc(m.user_name)}</td><td>${esc(m.note || '')}</td></tr>`).join('')}</tbody></table>`
      return
    }
    const rows = await get(`/inventory/batches${status === 'all' ? '' : `?status=${status}`}`)
    list.innerHTML = rows.length === 0 ? '<p class="muted">Nothing here.</p>' : `<table>
      <thead><tr><th>Product</th><th>Batch</th><th>Expiry</th><th class="num">Qty</th><th class="num">MRP</th>${editable ? '<th class="num">Cost</th><th></th>' : ''}</tr></thead>
      <tbody>${rows.map((b) => `<tr>
        <td>${esc(b.product_name)} ${schedBadge(b.schedule)}</td><td>${esc(b.batch_no)}</td>
        <td>${esc(b.expiry_date)} <span class="badge ${b.expiry_status}">${b.expiry_status === 'expired' ? 'Expired' : b.expiry_status === 'near' ? `${b.days_to_expiry}d left` : 'OK'}</span></td>
        <td class="num">${b.qty_on_hand}</td><td class="num">${rs(b.sale_price)}</td>
        ${editable ? `<td class="num">${rs(b.cost_price)}</td><td><button class="link" data-adj="${b.id}" data-name="${esc(b.product_name)} / ${esc(b.batch_no)}" data-expired="${b.expiry_status === 'expired' ? 1 : ''}" data-qty="${b.qty_on_hand}">Adjust</button></td>` : ''}
      </tr>`).join('')}</tbody></table>`
  }

  $('#tabs', view).addEventListener('click', guard(async (e) => {
    const b = e.target.closest('button[data-s]')
    if (!b) return
    status = b.dataset.s
    $$('#tabs button', view).forEach((x) => x.classList.toggle('sel', x === b))
    await load()
  }))
  $('#list', view).addEventListener('click', (e) => {
    const b = e.target.closest('[data-adj]')
    if (!b) return
    const m = modal(`<form id="af"><h2>Adjust stock</h2><p>${esc(b.dataset.name)} — ${b.dataset.qty} on hand</p>
      <div class="grid">
        <label class="field">Reason<select name="reason">
          <option value="expired" ${b.dataset.expired ? 'selected' : ''}>Expired write-off</option>
          <option value="damaged">Damaged / broken</option>
          <option value="adjustment" ${b.dataset.expired ? '' : 'selected'}>Stock count correction</option></select></label>
        <label class="field">Change (use minus to remove)<input name="change" type="number" required value="${b.dataset.expired ? -b.dataset.qty : ''}"></label>
      </div>
      <label class="field" style="margin-top:10px">Note<input name="note" placeholder="Required for count corrections"></label>
      <div class="actions"><button type="button" data-close>Cancel</button><button class="primary">Save</button></div></form>`)
    $('#af', m.el).addEventListener('submit', guard(async (ev) => {
      ev.preventDefault()
      await post('/inventory/adjustments', { ...formData(ev.target), batch_id: Number(b.dataset.adj) })
      m.close()
      toast('Stock updated')
      await load()
    }))
  })
  await load()
}

// ---------- purchases ----------

async function purchasesView(view) {
  view.innerHTML = `<div class="stack">
    <div class="row"><h1>Purchases</h1><div class="spacer"></div><button class="primary" id="add">New purchase</button></div>
    <div class="panel table-wrap" id="list"></div></div>`
  const load = async () => {
    const rows = await get('/purchases')
    $('#list', view).innerHTML = rows.length === 0 ? '<p class="muted">No purchases yet. Use “New purchase” when a delivery arrives.</p>' : `<table>
      <thead><tr><th>#</th><th>Date</th><th>Supplier</th><th>Invoice</th><th>Payment</th><th>Due</th><th class="num">Lines</th><th class="num">Total</th><th>Received by</th></tr></thead>
      <tbody>${rows.map((p) => `<tr class="clickable" data-id="${p.id}"><td>${p.id}</td><td>${esc(p.created_at)}</td><td>${esc(p.supplier_name)}</td>
        <td>${esc(p.invoice_no || '')}</td><td>${esc(p.payment_type || 'credit')}</td><td>${esc(p.due_date || '')}</td>
        <td class="num">${p.item_count}</td><td class="num">${rs(p.total)}</td><td>${esc(p.received_by)}</td></tr>`).join('')}</tbody></table>`
  }
  $('#add', view).addEventListener('click', guard(() => purchaseForm(load)))
  $('#list', view).addEventListener('click', guard(async (e) => {
    const tr = e.target.closest('tr[data-id]')
    if (tr) purchaseDetail(await get(`/purchases/${tr.dataset.id}`))
  }))
  await load()
}

function purchaseDetail(p) {
  const line = (i) => {
    const ps = i.pack_size || 1
    const packs = i.packs ?? (ps > 1 ? Math.floor(i.qty / ps) : i.qty)
    const loose = i.loose_qty ?? (ps > 1 ? i.qty % ps : 0)
    return `<tr><td>${esc(i.product_name)}</td><td>${esc(i.batch_no)}</td><td>${esc(i.expiry_date)}</td>
      <td class="num">${ps}</td><td class="num">${packs}</td><td class="num">${loose || ''}</td><td class="num">${i.bonus_qty || ''}</td>
      <td class="num">${i.pack_cost != null ? rs(i.pack_cost) : rs(i.cost_price * ps)}</td><td class="num">${i.discount_bps ? pct(i.discount_bps) : ''}</td>
      <td class="num">${i.pack_price != null ? rs(i.pack_price) : ''}</td><td class="num">${rs(i.line_total)}</td></tr>`
  }
  modal(`<h2>Purchase #${p.id} — ${esc(p.supplier_name)}</h2>
    <p class="muted">Invoice ${esc(p.invoice_no || '—')} ${p.invoice_date ? `dated ${esc(p.invoice_date)}` : ''} · received ${esc(p.created_at)} by ${esc(p.received_by)}<br>
      ${p.payment_type === 'cash' ? 'Paid in cash' : `Credit${p.due_date ? ` · due ${esc(p.due_date)}` : ''}`}</p>
    <div class="table-wrap"><table><thead><tr><th>Product</th><th>Batch</th><th>Expiry</th><th class="num">P/Unit</th><th class="num">Packs</th><th class="num">Loose</th><th class="num">Bonus</th>
      <th class="num">Pack cost</th><th class="num">Disc</th><th class="num">Sale/pack</th><th class="num">Total</th></tr></thead>
    <tbody>${p.items.map(line).join('')}</tbody></table></div>
    <div class="totals" style="max-width:320px;margin-left:auto">
      ${p.gross ? `<div><span>Gross</span><span class="num">${rs(p.gross)}</span></div>` : ''}
      ${p.discount ? `<div><span>Discount</span><span class="num">-${rs(p.discount)}</span></div>` : ''}
      <div class="grand"><span>Net total</span><span class="num">${rs(p.total)}</span></div></div>
    <div class="actions"><button data-close>Close</button></div>`, { wide: true })
}

const PURCHASE_COLS = ['Product', 'Batch', 'Expiry', 'P/Unit', 'Packs', 'Loose', 'Bonus', 'Pack cost Rs', 'Disc %', 'Net cost/pack', 'Sale price/pack Rs', 'Margin %', 'Mark-up %', 'Line total', '']

const purchaseRowHtml = () => `<tr>
  <td><input name="product" list="plist" placeholder="Type to search" class="w-prod" aria-label="Product"></td>
  <td><input name="batch_no" class="w-batch" aria-label="Batch"></td>
  <td><input name="expiry_date" type="date" class="w-date" aria-label="Expiry"></td>
  <td class="num" data-ps>—</td>
  <td><input name="packs" type="number" min="0" class="w-n" aria-label="Packs"></td>
  <td><input name="loose_qty" type="number" min="0" class="w-n" aria-label="Loose units"></td>
  <td><input name="bonus_qty" type="number" min="0" class="w-n" aria-label="Bonus units"></td>
  <td><input name="pack_cost" inputmode="decimal" class="w-money" aria-label="Pack cost"></td>
  <td><input name="disc" inputmode="decimal" class="w-n" aria-label="Discount percent"></td>
  <td class="num" data-net></td>
  <td><input name="pack_price" inputmode="decimal" class="w-money" aria-label="Sale price per pack"></td>
  <td><input name="margin" inputmode="decimal" class="w-n" aria-label="Margin percent"></td>
  <td><input name="markup" inputmode="decimal" class="w-n" aria-label="Mark-up percent"></td>
  <td class="num" data-total></td>
  <td><button type="button" class="link danger" data-rm aria-label="Remove line" tabindex="-1">✕</button></td></tr>`

// Recomputes one grid row. `source` is the input just edited, so it is not overwritten.
function calcPurchaseRow(tr, product, source) {
  const val = (n) => $(`[name=${n}]`, tr).value.trim()
  const setVal = (n, v) => { if (source !== n) $(`[name=${n}]`, tr).value = v }
  const ps = product?.pack_size || 1
  const packs = Math.max(0, Math.floor(Number(val('packs')) || 0))
  const loose = Math.max(0, Math.floor(Number(val('loose_qty')) || 0))
  const bonus = Math.max(0, Math.floor(Number(val('bonus_qty')) || 0))
  const packCost = paisaOrNull(val('pack_cost')) || 0
  const bps = Math.round((Number(val('disc')) || 0) * 100)
  const units = packs * ps + loose
  const gross = packAmount(units, packCost, ps)
  const discount = Math.round((gross * bps) / 10000)
  const netPack = packCost - Math.round((packCost * bps) / 10000)
  const margin = Number(val('margin'))
  const markup = Number(val('markup'))
  if (source === 'margin' && val('margin') !== '' && margin < 100) {
    tr.dataset.auto = ''
    setVal('pack_price', toRupees(Math.round(netPack / (1 - margin / 100))))
  } else if (source === 'markup' && val('markup') !== '') {
    tr.dataset.auto = ''
    setVal('pack_price', toRupees(Math.round(netPack * (1 + markup / 100))))
  } else if (source === 'pack_price') {
    tr.dataset.auto = val('pack_price') ? '' : '1'
  }
  if ((tr.dataset.auto || !val('pack_price')) && netPack > 0 && source !== 'pack_price') {
    const mBps = Number(state.settings.default_margin_bps ?? 1500)
    tr.dataset.auto = '1'
    $('[name=pack_price]', tr).value = toRupees(mBps >= 10000 ? netPack : Math.round((netPack * 10000) / (10000 - mBps)))
  }
  const sale = paisaOrNull(val('pack_price'))
  if (sale && netPack) {
    setVal('margin', ((sale - netPack) / sale * 100).toFixed(1))
    setVal('markup', ((sale - netPack) / netPack * 100).toFixed(1))
  } else {
    setVal('margin', '')
    setVal('markup', '')
  }
  $('[data-net]', tr).textContent = packCost ? toRupees(netPack) : ''
  $('[data-total]', tr).textContent = units && packCost ? toRupees(gross - discount) : ''
  return { packs, loose, bonus, units, gross, discount, net: gross - discount }
}

async function purchaseForm(onSaved) {
  const [suppliers, products] = await Promise.all([get('/suppliers'), get('/products/pick')])
  const active = suppliers.filter((s) => s.active !== 0)
  if (!active.length) {
    toast('Add a supplier first', true)
    location.hash = '#/suppliers'
    return
  }
  const optLabel = (p) => `${productLabel(p)} #${p.id}`
  const byLabel = new Map(products.map((p) => [optLabel(p), p]))
  // Exact pick from the list; otherwise a scanned barcode/item code, or a name only one item matches.
  const productOf = (tr) => {
    const input = $('[name=product]', tr)
    const text = input.value.trim()
    if (!text) return null
    if (byLabel.has(text)) return byLabel.get(text)
    const t = text.toLowerCase()
    const found = products.find((p) => (p.barcode || '').toLowerCase() === t) ||
      [products.filter((p) => p.name.toLowerCase() === t),
        products.filter((p) => p.name.toLowerCase().startsWith(t)),
        products.filter((p) => productLabel(p).toLowerCase().includes(t))].find((list) => list.length === 1)?.[0]
    if (found) input.value = optLabel(found)
    return found || null
  }
  const m = modal(`<form id="pf" autocomplete="off">
    <div class="row"><h2>New purchase</h2><div class="spacer"></div><span class="muted" style="font-size:12px"><span class="kbd">Enter</span> next field · <span class="kbd">Ctrl+I</span> add row</span></div>
    <div class="grid">
      <label class="field">Supplier *<select name="supplier_id">${active.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select>
        <span id="sup-info" class="muted" style="font-size:12px"></span></label>
      <label class="field">Supplier invoice no<input name="invoice_no"></label>
      <label class="field">Invoice date<input name="invoice_date" type="date" value="${today()}"></label>
      <label class="field">Payment type<select name="payment_type"><option value="credit">Credit</option><option value="cash">Cash</option></select>
        <span id="due-info" class="muted" style="font-size:12px"></span></label>
      <label class="field" id="pm-field" hidden>Paid from<select name="payment_method"><option value="cash">Cash (office)</option><option value="till">My till</option><option value="bank">Bank</option></select></label>
    </div>
    <datalist id="plist">${products.map((p) => `<option value="${esc(optLabel(p))}">`).join('')}</datalist>
    <div class="table-wrap purchase-grid" style="margin-top:12px"><table>
      <thead><tr>${PURCHASE_COLS.map((c, i) => `<th class="${i >= 3 && i !== 10 ? 'num' : ''}">${esc(c)}</th>`).join('')}</tr></thead>
      <tbody id="lines">${purchaseRowHtml()}</tbody></table></div>
    <button type="button" class="link" id="addline">+ Add row</button>
    <div class="purchase-foot" id="pfoot"></div>
    <p class="muted" style="font-size:13px">Packs and pack prices as on the supplier bill; loose and bonus are single units. Blank sale price uses the product's pack price, or cost + ${pct(state.settings.default_margin_bps ?? 1500)} margin.</p>
    <div class="actions"><button type="button" data-close>Cancel</button><button class="primary">Save & add to stock</button></div>
  </form>`, { wide: true })
  $('.modal', m.el).classList.add('xl')
  const form = $('#pf', m.el)
  const tbody = $('#lines', m.el)

  const supplierInfo = () => {
    const s = active.find((x) => x.id === Number(form.supplier_id.value)) || {}
    $('#sup-info', m.el).textContent = [`Terms ${s.due_days || 0} days`, s.balance != null ? `balance ${rs(s.balance)}` : '', s.overdue ? `overdue ${rs(s.overdue)}` : ''].filter(Boolean).join(' · ')
    const cash = form.payment_type.value === 'cash'
    $('#pm-field', m.el).hidden = !cash
    const d = new Date(form.invoice_date.value || today())
    d.setDate(d.getDate() + (s.due_days || 0))
    $('#due-info', m.el).textContent = cash ? 'Payment is recorded now' : `Due ${d.toISOString().slice(0, 10)}`
  }

  const recalcAll = (tr, source) => {
    if (tr) calcPurchaseRow(tr, productOf(tr), source)
    const sum = { packs: 0, units: 0, bonus: 0, gross: 0, discount: 0, net: 0, lines: 0 }
    for (const row of $$('tr', tbody)) {
      const p = productOf(row)
      if (!p) continue
      const r = calcPurchaseRow(row, p, row === tr ? source : 'none')
      sum.lines++
      for (const k of ['packs', 'units', 'bonus', 'gross', 'discount', 'net']) sum[k] += r[k]
    }
    $('#pfoot', m.el).innerHTML = `<span>Lines <b>${sum.lines}</b></span><span>Packs <b>${sum.packs}</b></span><span>Units <b>${sum.units}</b></span>
      <span>Bonus <b>${sum.bonus}</b></span><span>Gross <b>${rs(sum.gross)}</b></span><span>Discount <b>${rs(sum.discount)}</b></span>
      <span class="grand">Net total <b>${rs(sum.net)}</b></span>`
  }

  const onProduct = (tr) => {
    const p = productOf(tr)
    const ps = p?.pack_size || 1
    $('[data-ps]', tr).textContent = p ? ps : '—'
    const loose = $('[name=loose_qty]', tr)
    loose.disabled = ps <= 1
    if (ps <= 1) loose.value = ''
    const price = $('[name=pack_price]', tr)
    if (p && (p.pack_price || 0) > 0) {
      price.value = toRupees(p.pack_price)
      tr.dataset.auto = ''
    } else if (p) {
      price.value = ''
      tr.dataset.auto = '1'
    }
  }

  const addRow = () => {
    tbody.insertAdjacentHTML('beforeend', purchaseRowHtml())
    $('tr:last-child [name=product]', tbody).focus()
  }
  $('#addline', m.el).addEventListener('click', addRow)
  tbody.addEventListener('click', (e) => {
    if (!e.target.closest('[data-rm]')) return
    if (tbody.children.length > 1) e.target.closest('tr').remove()
    else e.target.closest('tr').outerHTML = purchaseRowHtml()
    recalcAll()
  })
  tbody.addEventListener('input', (e) => {
    const tr = e.target.closest('tr')
    if (e.target.name === 'product') onProduct(tr)
    recalcAll(tr, e.target.name)
  })
  // Keep typed prices tidy once the user leaves the cell.
  tbody.addEventListener('focusout', (e) => {
    const n = e.target.name
    if ((n === 'pack_cost' || n === 'pack_price') && paisaOrNull(e.target.value) !== null) e.target.value = toRupees(paisaOrNull(e.target.value))
  })
  form.addEventListener('change', (e) => {
    if (['supplier_id', 'payment_type', 'invoice_date'].includes(e.target.name)) supplierInfo()
  })
  // MultiTec-style keys: Enter moves to the next field, Ctrl+I adds a row.
  form.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key.toLowerCase() === 'i') {
      e.preventDefault()
      addRow()
      return
    }
    if (e.key !== 'Enter' || !e.target.matches('input, select')) return
    e.preventDefault()
    const fields = $$('input:not([disabled]):not([type=hidden]), select', form).filter((x) => !x.closest('[hidden]'))
    const next = fields[fields.indexOf(e.target) + 1]
    if (next) next.focus()
    else addRow()
  })

  form.addEventListener('submit', guard(async (e) => {
    e.preventDefault()
    const items = []
    $$('tr', tbody).forEach((tr, i) => {
      const val = (n) => $(`[name=${n}]`, tr).value.trim()
      const p = productOf(tr)
      const touched = ['product', 'batch_no', 'packs', 'pack_cost'].some((n) => val(n))
      if (!touched) return
      if (!p) throw new Error(`Row ${i + 1}: choose a product from the list`)
      const r = calcPurchaseRow(tr, p, 'none')
      if (!r.units && !r.bonus) throw new Error(`Row ${i + 1}: enter packs or loose units`)
      const packCost = paisaOrNull(val('pack_cost'))
      if (packCost === null) throw new Error(`Row ${i + 1}: enter the pack cost`)
      const salePrice = paisaOrNull(val('pack_price'))
      items.push({
        product_id: p.id, batch_no: val('batch_no'), expiry_date: val('expiry_date'),
        packs: r.packs, loose_qty: r.loose, bonus_qty: r.bonus, pack_cost: packCost,
        discount_bps: Math.round((Number(val('disc')) || 0) * 100),
        ...(salePrice ? { pack_price: salePrice } : {}),
      })
    })
    if (!items.length) throw new Error('Add at least one item')
    const d = formData(form)
    await post('/purchases', {
      supplier_id: Number(d.supplier_id), invoice_no: d.invoice_no, invoice_date: d.invoice_date,
      payment_type: d.payment_type, ...(d.payment_type === 'cash' ? { payment_method: d.payment_method } : {}), items,
    })
    m.close()
    toast('Stock received')
    onSaved()
  }))
  supplierInfo()
  recalcAll()
}

// ---------- suppliers ----------

const hashParam = (k) => new URLSearchParams(location.hash.split('?')[1] || '').get(k)

async function suppliersView(view) {
  const id = Number(hashParam('id'))
  if (id) return supplierLedgerView(view, id)
  view.innerHTML = `<div class="stack">
    <div class="row"><h1>Suppliers</h1><div class="spacer"></div>
      <label class="row" style="font-size:13px"><input type="checkbox" id="inactive"> Show inactive</label>
      <button class="primary" id="add">Add supplier</button></div>
    <div class="panel table-wrap" id="list"></div></div>`
  let rows = []
  const load = async () => {
    rows = await get('/suppliers')
    const shown = $('#inactive', view).checked ? rows : rows.filter((s) => s.active !== 0)
    const total = (k) => shown.reduce((t, s) => t + (s[k] || 0), 0)
    $('#list', view).innerHTML = shown.length === 0 ? '<p class="muted">No suppliers yet.</p>' : `<table>
      <thead><tr><th>Name</th><th>Contact</th><th>Phone</th><th class="num">Terms</th><th class="num">Balance</th><th class="num">Overdue</th></tr></thead>
      <tbody>${shown.map((s) => `<tr class="clickable ${s.overdue > 0 ? 'overdue' : ''}" data-id="${s.id}">
        <td>${esc(s.name)} ${s.active === 0 ? '<span class="muted">(inactive)</span>' : ''}</td><td>${esc(s.contact_person || '')}</td><td>${esc(s.phone || '')}</td>
        <td class="num">${s.due_days ? `${esc(s.due_days)} days` : 'Cash'}</td>
        <td class="num">${s.balance != null ? rs(s.balance) : ''}</td>
        <td class="num">${s.overdue > 0 ? `<b>${rs(s.overdue)}</b>` : ''}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td colspan="4">Total owed</td><td class="num">${rs(total('balance'))}</td><td class="num">${rs(total('overdue'))}</td></tr></tfoot></table>`
  }
  $('#add', view).addEventListener('click', () => supplierForm(null, load))
  $('#inactive', view).addEventListener('change', guard(load))
  $('#list', view).addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]')
    if (tr) location.hash = `#/suppliers?id=${tr.dataset.id}`
  })
  await load()
}

function supplierForm(s, onSaved) {
  const v = s || { active: 1, due_days: 0, opening_balance: 0 }
  const m = modal(`<form id="sf"><h2>${s ? 'Edit' : 'Add'} supplier</h2><div class="grid">
    <label class="field">Name *<input name="name" value="${esc(v.name)}" required></label>
    <label class="field">Contact person<input name="contact_person" value="${esc(v.contact_person)}"></label>
    <label class="field">Phone<input name="phone" value="${esc(v.phone)}"></label>
    <label class="field">Email<input name="email" type="email" value="${esc(v.email)}"></label>
    <label class="field">Address<input name="address" value="${esc(v.address)}"></label>
    <label class="field">NTN<input name="ntn" value="${esc(v.ntn)}"></label>
    <label class="field">Drug licence no<input name="drug_license_no" value="${esc(v.drug_license_no)}"></label>
    <label class="field">Credit terms (due days)<input name="due_days" type="number" min="0" value="${esc(v.due_days ?? 0)}"></label>
    <label class="field">Opening balance owed (Rs)<input name="opening_balance" inputmode="decimal" value="${toRupees(v.opening_balance)}"></label>
    <label class="field">Opening balance date<input name="opening_date" type="date" value="${esc(v.opening_date || '')}"></label></div>
    <label class="row" style="margin-top:10px"><input type="checkbox" name="active" ${v.active !== 0 ? 'checked' : ''}> Active</label>
    <div class="actions"><button type="button" data-close>Cancel</button><button class="primary">Save</button></div></form>`, { wide: true })
  $('#sf', m.el).addEventListener('submit', guard(async (e) => {
    e.preventDefault()
    const d = formData(e.target)
    const opening = d.opening_balance.trim() === '' ? 0 : paisaOrNull(d.opening_balance)
    if (opening === null) throw new Error('Enter a valid opening balance')
    const body = { ...d, due_days: Number(d.due_days) || 0, opening_balance: opening, opening_date: d.opening_date || null }
    if (s) await put(`/suppliers/${s.id}`, body)
    else await post('/suppliers', body)
    m.close()
    toast('Supplier saved')
    await onSaved()
  }))
}

function paymentDialog(supplier, onSaved) {
  const m = modal(`<form id="payf"><h2>Record payment — ${esc(supplier.name)}</h2>
    ${supplier.balance != null ? `<p class="muted">Currently owed ${rs(supplier.balance)}</p>` : ''}
    <div class="grid">
      <label class="field">Amount (Rs) *<input name="amount" inputmode="decimal" required></label>
      <label class="field">Method<select name="method">
        <option value="cash">Cash (office)</option><option value="bank">Bank transfer</option><option value="cheque">Cheque</option><option value="till">From my till</option></select></label>
      <label class="field">Reference (cheque / transfer no)<input name="reference"></label>
      <label class="field">Date<input name="paid_on" type="date" value="${today()}"></label></div>
    <label class="field" style="margin-top:10px">Note<input name="note"></label>
    <div class="actions"><button type="button" data-close>Cancel</button><button class="primary">Save payment</button></div></form>`)
  $('#payf', m.el).addEventListener('submit', guard(async (e) => {
    e.preventDefault()
    const d = formData(e.target)
    const amount = paisaOrNull(d.amount)
    if (!amount || amount <= 0) throw new Error('Enter the amount paid')
    await post(`/suppliers/${supplier.id}/payments`, { ...d, amount })
    m.close()
    toast(`Payment of ${rs(amount)} recorded`)
    await onSaved()
  }))
}

const LEDGER_TYPES = { opening: 'Opening', purchase: 'Purchase', payment: 'Payment' }

async function supplierLedgerView(view, id) {
  const f = { from: '', to: today() }
  view.innerHTML = `<div class="stack">
    <div class="row"><a href="#/suppliers" class="link">← Suppliers</a></div>
    <div class="row"><h1 id="sname">Supplier</h1><div class="spacer"></div>
      <button id="edit">Edit</button><button id="pay" class="primary">Record payment</button></div>
    <div class="cards" id="scards"></div>
    <div class="row">
      <label class="field">From<input type="date" id="from" value="${f.from}"></label>
      <label class="field">To<input type="date" id="to" value="${f.to}"></label>
      <div class="spacer"></div><button id="print">Print ledger</button></div>
    <div class="panel table-wrap" id="ledger"></div></div>`
  let supplier = null
  let data = null
  const load = async () => {
    const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString()
    const [list, ledger] = await Promise.all([get('/suppliers'), get(`/suppliers/${id}/ledger${qs ? `?${qs}` : ''}`)])
    data = ledger
    supplier = { ...ledger.supplier, ...(list.find((s) => s.id === id) || {}) }
    $('#sname', view).textContent = supplier.name
    const card = (label, value) => `<div class="card"><div class="label">${label}</div><div class="value">${value}</div></div>`
    $('#scards', view).innerHTML = card('Balance owed', rs(supplier.balance ?? ledger.balance)) +
      card('Overdue', supplier.overdue ? `<span style="color:var(--danger)">${rs(supplier.overdue)}</span>` : rs(0)) +
      card('Terms', supplier.due_days ? `${esc(supplier.due_days)} days` : 'Cash') +
      card('Contact', `<span style="font-size:14px">${esc(supplier.contact_person || '—')}<br>${esc(supplier.phone || '')}</span>`)
    $('#ledger', view).innerHTML = ledgerTableHtml(ledger)
  }
  const reload = () => load().catch((e) => toast(e.message, true))
  $('#from', view).addEventListener('change', (e) => { f.from = e.target.value; reload() })
  $('#to', view).addEventListener('change', (e) => { f.to = e.target.value; reload() })
  $('#edit', view).addEventListener('click', () => supplier && supplierForm(supplier, load))
  $('#pay', view).addEventListener('click', () => supplier && paymentDialog(supplier, load))
  $('#print', view).addEventListener('click', () => data && printHtml(`<h2>${esc(state.settings.pharmacy_name)}</h2>
    <h3>Supplier ledger — ${esc(supplier.name)}</h3>
    <p>${f.from ? `From ${esc(f.from)} ` : ''}${f.to ? `to ${esc(f.to)}` : ''} · Terms ${esc(supplier.due_days || 0)} days · Balance owed ${rs(data.balance)}</p>
    ${ledgerTableHtml(data)}<p>Printed ${esc(new Date().toLocaleString())} by ${esc(state.user.full_name)}</p>`, 'report'))
  await load()
}

function ledgerTableHtml(ledger) {
  const entries = ledger.entries || []
  const sum = (k) => entries.reduce((t, e) => t + (e[k] || 0), 0)
  return `<table>
    <thead><tr><th>Date</th><th>Type</th><th>Ref</th><th>Description</th><th class="num">Billed</th><th class="num">Paid</th><th class="num">Balance</th></tr></thead>
    <tbody>${entries.length ? entries.map((e) => `<tr>
      <td>${esc(e.date)}</td><td>${esc(LEDGER_TYPES[e.type] || e.type)}</td><td>${esc(e.ref || '')}</td><td>${esc(e.description || '')}</td>
      <td class="num">${e.debit ? rs(e.debit) : ''}</td><td class="num">${e.credit ? rs(e.credit) : ''}</td><td class="num">${rs(e.balance)}</td></tr>`).join('')
      : '<tr><td colspan="7" class="muted">No entries in this period.</td></tr>'}</tbody>
    <tfoot><tr><td colspan="4">Totals</td><td class="num">${rs(sum('debit'))}</td><td class="num">${rs(sum('credit'))}</td><td class="num">${rs(ledger.balance)}</td></tr></tfoot>
  </table>`
}

// ---------- reports ----------

async function reportsView(view) {
  const f = { from: today(), to: today(), tab: 'summary' }
  view.innerHTML = `<div class="stack">
    <div class="row"><h1>Reports</h1><div class="spacer"></div>
      <input type="date" id="from" value="${f.from}" aria-label="From"> – <input type="date" id="to" value="${f.to}" aria-label="To">
      <button id="print">Print</button></div>
    <div class="tabs" id="tabs">
      ${[['summary', 'Sales summary'], ['top', 'Top products'], ['low', 'Low stock'], ['expiry', 'Expiry'], ['valuation', 'Stock value'], ['controlled', 'Controlled drug register'], ['dues', 'Supplier dues'], ['deptusage', 'Department usage']]
        .map(([k, l]) => `<button data-t="${k}" class="${k === f.tab ? 'sel' : ''}">${l}</button>`).join('')}
    </div>
    <div id="out"></div></div>`
  const out = $('#out', view)
  const table = (head, rows) => `<div class="panel table-wrap"><table><thead><tr>${head.map((h) => `<th class="${h.startsWith('#') ? 'num' : ''}">${esc(h.replace(/^#/, ''))}</th>`).join('')}</tr></thead>
    <tbody>${rows.length ? rows.join('') : `<tr><td colspan="${head.length}" class="muted">Nothing to show.</td></tr>`}</tbody></table></div>`
  const card = (label, value) => `<div class="card"><div class="label">${label}</div><div class="value">${value}</div></div>`
  let title = ''

  async function load() {
    const range = `from=${f.from}&to=${f.to}`
    const period = f.from === f.to ? f.from : `${f.from} to ${f.to}`
    if (f.tab === 'summary') {
      const s = await get(`/reports/summary?${range}`)
      title = `Sales summary ${period}`
      out.innerHTML = `<div class="stack">
        <div class="cards">${card('Invoices', s.sales.invoices)}${card('Net sales', rs(s.net_sales))}${card('Discounts', rs(s.sales.discount))}
          ${card('Returns', `${rs(s.returns.total)} <span class="muted" style="font-size:13px">(${s.returns.count})</span>`)}
          ${card('GST collected', rs(s.net_tax))}${card('Gross profit', rs(s.gross_profit))}${card('Cash in drawer', rs(s.cash_in_drawer))}</div>
        <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(280px,1fr))">
          <div><h3>By payment method</h3>${table(['Method', '#Invoices', '#Total'], s.byPayment.map((b) => `<tr><td>${esc(b.payment_method)}</td><td class="num">${b.invoices}</td><td class="num">${rs(b.total)}</td></tr>`))}</div>
          <div><h3>GST by rate</h3>${table(['Rate', '#Sales (incl.)', '#GST'], s.byGstRate.map((g) => `<tr><td>${pct(g.gst_rate_bps)}</td><td class="num">${rs(g.sales)}</td><td class="num">${rs(g.tax)}</td></tr>`))}</div>
          <div><h3>By staff</h3>${table(['Name', '#Invoices', '#Total'], s.byUser.map((u) => `<tr><td>${esc(u.full_name)}</td><td class="num">${u.invoices}</td><td class="num">${rs(u.total)}</td></tr>`))}</div>
        </div>
        ${s.byDay.length > 1 ? `<div><h3>By day</h3>${table(['Day', '#Invoices', '#Total'], s.byDay.map((d) => `<tr><td>${d.day}</td><td class="num">${d.invoices}</td><td class="num">${rs(d.total)}</td></tr>`))}</div>` : ''}
        <p class="muted" style="font-size:13px">Returns are counted on the day they were processed. Gross profit excludes GST.</p></div>`
    } else if (f.tab === 'top') {
      const rows = await get(`/reports/top-products?${range}`)
      title = `Top products ${period}`
      out.innerHTML = table(['Product', '#Units', '#Revenue', '#Profit'], rows.map((r) => `<tr><td>${esc(r.name)} ${esc(r.strength || '')}</td><td class="num">${r.qty}</td><td class="num">${rs(r.revenue)}</td><td class="num">${rs(r.profit)}</td></tr>`))
    } else if (f.tab === 'low') {
      const rows = await get('/reports/low-stock')
      title = 'Low stock / reorder list'
      out.innerHTML = table(['Product', 'Form', '#In stock', '#Reorder level'], rows.map((r) => `<tr><td>${esc(r.name)} ${esc(r.strength || '')}</td><td>${esc(r.form || '')}</td><td class="num">${r.stock}</td><td class="num">${r.reorder_level}</td></tr>`))
    } else if (f.tab === 'expiry') {
      const rows = await get('/reports/expiry')
      title = `Expired and expiring within ${state.settings.near_expiry_days} days`
      out.innerHTML = table(['Product', 'Batch', 'Expiry', '#Days', '#Qty', '#Cost value'], rows.map((r) => `<tr><td>${esc(r.product_name)} ${esc(r.strength || '')}</td><td>${esc(r.batch_no)}</td><td>${esc(r.expiry_date)}</td>
        <td class="num">${r.days_to_expiry < 0 ? '<span class="badge expired">Expired</span>' : r.days_to_expiry}</td><td class="num">${r.qty_on_hand}</td><td class="num">${rs(r.cost_value)}</td></tr>`))
    } else if (f.tab === 'valuation') {
      const v = await get('/reports/stock-valuation')
      title = 'Stock valuation'
      out.innerHTML = `<div class="stack"><div class="cards">${card('At cost', rs(v.cost_value))}${card('At retail', rs(v.retail_value))}${card('Expired stock (cost)', rs(v.expired_cost_value))}</div>
        ${table(['Product', '#Qty', '#Cost value', '#Retail value'], v.rows.map((r) => `<tr><td>${esc(r.name)} ${esc(r.strength || '')}</td><td class="num">${r.qty}</td><td class="num">${rs(r.cost_value)}</td><td class="num">${rs(r.retail_value)}</td></tr>`))}</div>`
    } else if (f.tab === 'controlled') {
      const rows = await get(`/reports/controlled-register?${range}`)
      title = `Controlled drug register ${period}`
      out.innerHTML = table(['Date', 'Drug', 'Batch', 'Type', '#In', '#Out', '#Balance', 'Patient / CNIC', 'Prescriber / PMDC', 'Supplier / Ref', 'By'],
        rows.map((r) => `<tr><td>${esc(r.created_at)}</td><td>${esc(r.product_name)} ${esc(r.strength || '')}</td><td>${esc(r.batch_no)}</td><td>${esc(r.reason)}</td>
          <td class="num">${r.change > 0 ? r.change : ''}</td><td class="num">${r.change < 0 ? -r.change : ''}</td><td class="num">${r.balance}</td>
          <td>${esc(r.patient_name || '')}${r.patient_cnic ? `<br>${esc(r.patient_cnic)}` : ''}</td>
          <td>${esc(r.prescriber_name || '')}${r.prescriber_reg_no ? `<br>${esc(r.prescriber_reg_no)}` : ''}</td>
          <td>${r.department_name ? `Dept: ${esc(r.department_name)}` : esc(r.supplier_name || r.invoice_no || r.note || '')}${r.supplier_invoice ? ` / ${esc(r.supplier_invoice)}` : ''}</td><td>${esc(r.user_name)}</td></tr>`))
    } else if (f.tab === 'deptusage') {
      await deptUsageReport(out, f, (t) => { title = t })
    } else if (f.tab === 'dues') {
      const rows = await get('/reports/supplier-dues')
      title = `Supplier dues as of ${today()}`
      out.innerHTML = supplierDuesHtml(rows)
    }
  }
  const reload = () => load().catch((e) => toast(e.message, true))
  $('#from', view).addEventListener('change', (e) => { f.from = e.target.value; reload() })
  $('#to', view).addEventListener('change', (e) => { f.to = e.target.value; reload() })
  $('#tabs', view).addEventListener('click', (e) => {
    const b = e.target.closest('button[data-t]')
    if (!b) return
    f.tab = b.dataset.t
    $$('#tabs button', view).forEach((x) => x.classList.toggle('sel', x === b))
    reload()
  })
  $('#print', view).addEventListener('click', () =>
    printHtml(`<h2>${esc(state.settings.pharmacy_name)}</h2><h3>${esc(title)}</h3>${out.innerHTML}<p>Printed ${new Date().toLocaleString()} by ${esc(state.user.full_name)}</p>`, 'report'))
  await load()
}

const DUE_BUCKETS = [['not_due', 'Not due'], ['d1_30', '1–30'], ['d31_60', '31–60'], ['d61_90', '61–90'], ['d90_plus', '90+']]

// Aging of what each supplier is owed; buckets are days past the bill's due date.
function supplierDuesHtml(rows) {
  const sum = (k) => rows.reduce((t, r) => t + (r[k] || 0), 0)
  const money = (v) => (v ? rs(v) : '')
  return `<div class="panel table-wrap"><table class="dues">
    <thead><tr><th>Supplier</th><th class="num">Terms</th>${DUE_BUCKETS.map(([, l]) => `<th class="num">${l}</th>`).join('')}<th class="num">Overdue</th><th class="num">Balance</th><th>Oldest unpaid</th></tr></thead>
    <tbody>${rows.length ? rows.map((r) => `<tr class="${r.overdue > 0 ? 'overdue' : ''}"><td><a href="#/suppliers?id=${esc(r.supplier_id)}">${esc(r.name)}</a></td>
      <td class="num">${esc(r.due_days || 0)}d</td>${DUE_BUCKETS.map(([k]) => `<td class="num">${money(r[k])}</td>`).join('')}
      <td class="num">${r.overdue > 0 ? `<b>${rs(r.overdue)}</b>` : ''}</td><td class="num">${rs(r.balance)}</td><td>${esc(r.oldest_unpaid_date || '')}</td></tr>`).join('')
      : '<tr><td colspan="10" class="muted">Nothing owed to suppliers.</td></tr>'}</tbody>
    <tfoot><tr><td colspan="2">Total</td>${DUE_BUCKETS.map(([k]) => `<td class="num">${rs(sum(k))}</td>`).join('')}
      <td class="num">${rs(sum('overdue'))}</td><td class="num">${rs(sum('balance'))}</td><td></td></tr></tfoot></table></div>`
}

// ---------- users ----------

async function usersView(view) {
  view.innerHTML = `<div class="stack">
    <div class="row"><h1>Users</h1><div class="spacer"></div><button class="primary" id="add">Add user</button></div>
    <div class="panel table-wrap" id="list"></div>
    <p class="muted" style="font-size:13px">Cashiers: sell, see only their own sales. Pharmacists: also controlled drugs, returns, stock, purchases, reports and department issues. Admins: everything including users and settings. Discount limits per role are set by the owner. Only the owner can add or change admins.</p></div>`
  let rows = []
  const isOwner = !!state.user.is_owner
  // Only the owner may touch admin accounts.
  const editable = (u) => isOwner || u.role !== 'admin'
  const load = async () => {
    rows = await get('/users')
    $('#list', view).innerHTML = `<table><thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Status</th><th>Created</th></tr></thead>
      <tbody>${rows.map((u) => `<tr class="${editable(u) ? 'clickable' : ''}" data-id="${u.id}"><td>${esc(u.full_name)}</td><td>${esc(u.username)}</td>
        <td>${esc(u.role)} ${u.is_owner ? '<span class="badge ok">Owner</span>' : ''}${editable(u) ? '' : ' <span class="muted" style="font-size:12px">read-only</span>'}</td>
        <td>${u.active ? 'Active' : '<span class="muted">Disabled</span>'}</td><td>${esc(u.created_at)}</td></tr>`).join('')}</tbody></table>`
  }
  const form = (u) => {
    const roleSel = (r) => (isOwner ? ['cashier', 'pharmacist', 'admin'] : ['cashier', 'pharmacist']).map((x) => `<option ${x === r ? 'selected' : ''}>${x}</option>`).join('')
    const m = modal(`<form id="uf"><h2>${u ? `Edit ${esc(u.username)}` : 'Add user'}</h2><div class="grid">
      ${u ? '' : '<label class="field">Username *<input name="username" required></label>'}
      <label class="field">Full name *<input name="full_name" value="${esc(u?.full_name)}" required></label>
      ${u?.is_owner ? '<div class="field">Role<div><b>admin</b> <span class="badge ok">Owner</span></div></div>' : `<label class="field">Role<select name="role">${roleSel(u?.role || 'cashier')}</select></label>`}
      <label class="field">${u ? 'New password (leave blank to keep)' : 'Password *'}<input name="password" type="password" minlength="8" ${u ? '' : 'required'} autocomplete="new-password"></label>
      </div>
      ${u && !u.is_owner ? `<label class="row" style="margin-top:10px"><input type="checkbox" name="active" ${u.active ? 'checked' : ''}> Active</label>` : ''}
      ${u?.is_owner ? '<p class="muted" style="font-size:13px">The owner cannot be deactivated or demoted. Transfer ownership from the Owner panel first.</p>' : ''}
      <div class="actions"><button type="button" data-close>Cancel</button><button class="primary">Save</button></div></form>`)
    $('#uf', m.el).addEventListener('submit', guard(async (e) => {
      e.preventDefault()
      const d = formData(e.target)
      if (u) {
        if (!d.password) delete d.password
        await patch(`/users/${u.id}`, d)
      } else {
        await post('/users', d)
      }
      m.close()
      toast('User saved')
      await load()
    }))
  }
  $('#add', view).addEventListener('click', () => form(null))
  $('#list', view).addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]')
    const u = tr && rows.find((x) => x.id === Number(tr.dataset.id))
    if (u && editable(u)) form(u)
  })
  await load()
}

// ---------- settings ----------

const POLICY_KEYS = ['require_open_till', 'refund_card_sales', 'opening_balance_due', 'max_discount_cashier_bps', 'max_discount_pharmacist_bps', 'max_discount_admin_bps']
const policyLabels = (s) => [
  ['Every sale needs an open till', s.require_open_till === '0' ? 'No' : 'Yes'],
  ['Refunds of card/wallet sales', s.refund_card_sales === 'original' ? 'Back to card or wallet' : 'Cash from drawer'],
  ['Supplier opening balance falls due', s.opening_balance_due === 'immediate' ? 'Immediately' : 'After credit days'],
  ['Max discount: cashier', pct(s.max_discount_cashier_bps ?? DEFAULT_DISCOUNT_BPS.cashier)],
  ['Max discount: pharmacist', pct(s.max_discount_pharmacist_bps ?? DEFAULT_DISCOUNT_BPS.pharmacist)],
  ['Max discount: admin', pct(s.max_discount_admin_bps ?? DEFAULT_DISCOUNT_BPS.admin)],
]
const policyRowsHtml = (s) => policyLabels(s).map(([l, v]) => `<div class="field">${esc(l)}<div style="color:var(--text);font-size:15px"><b>${esc(v)}</b></div></div>`).join('')

async function settingsView(view) {
  const s = state.settings
  const admin = can('admin')
  const field = (key, label, attrs = '') =>
    `<label class="field">${label}<input name="${key}" value="${esc(s[key])}" ${admin ? '' : 'disabled'} ${attrs}></label>`
  view.innerHTML = `<div class="stack">
    <h1>Settings</h1>
    <form class="panel stack" id="sf">
      <h2>Pharmacy details</h2>
      <div class="grid">
        ${field('pharmacy_name', 'Pharmacy name', 'required')}${field('address', 'Address')}${field('phone', 'Phone')}
        ${field('drug_license_no', 'Drug sale licence no')}${field('ntn', 'NTN')}${field('strn', 'STRN (sales tax reg.)')}
      </div>
      <h2>Billing & stock</h2>
      <div class="grid">
        <label class="field">Default GST % for new products<input name="gst" type="number" min="0" max="100" step="0.01" value="${Number(s.default_gst_rate_bps) / 100}" ${admin ? '' : 'disabled'}></label>
        ${field('near_expiry_days', 'Warn about expiry (days ahead)', 'type="number" min="1"')}
        <label class="field">Round bills to whole rupee<select name="round_to_rupee" ${admin ? '' : 'disabled'}>
          <option value="1" ${s.round_to_rupee === '1' ? 'selected' : ''}>Yes</option><option value="0" ${s.round_to_rupee === '1' ? '' : 'selected'}>No</option></select></label>
        <label class="field">Default sale unit at the counter<select name="default_sale_unit" ${admin ? '' : 'disabled'}>
          <option value="pack" ${s.default_sale_unit === 'unit' ? '' : 'selected'}>Pack</option><option value="unit" ${s.default_sale_unit === 'unit' ? 'selected' : ''}>Single unit</option></select></label>
        <label class="field">Default margin % on purchases<input name="margin" type="number" min="0" max="99" step="0.01" value="${Number(s.default_margin_bps ?? 1500) / 100}" ${admin ? '' : 'disabled'}></label>
      </div>
      <h2>Cash control</h2>
      <div class="grid">
        ${field('cash_denominations', 'Cash denominations (Rs, comma separated)', 'pattern="\\s*\\d+(\\s*,\\s*\\d+)*\\s*" placeholder="5000,1000,500,100,50,20,10,5,2,1"')}
      </div>
      <h2>Policies</h2>
      <div class="grid" id="policies">${policyRowsHtml(s)}</div>
      <p class="muted" style="font-size:13px">Changed by the owner in the Owner panel.</p>
      <label class="field">Receipt footer<textarea name="receipt_footer" rows="2" ${admin ? '' : 'disabled'}>${esc(s.receipt_footer)}</textarea></label>
      ${admin ? '<div><button class="primary">Save settings</button></div>' : '<p class="muted">Only an admin can change these.</p>'}
    </form>
    <form class="panel stack" id="pw">
      <h2>Change your password</h2>
      <div class="grid">
        <label class="field">Current password<input name="current_password" type="password" required autocomplete="current-password"></label>
        <label class="field">New password (8+ characters)<input name="new_password" type="password" minlength="8" required autocomplete="new-password"></label>
      </div>
      <div><button>Change password</button></div>
    </form></div>`
  $('#sf', view).addEventListener('submit', guard(async (e) => {
    e.preventDefault()
    const d = formData(e.target)
    d.default_gst_rate_bps = String(Math.round(Number(d.gst || 0) * 100))
    d.default_margin_bps = String(Math.round(Number(d.margin || 0) * 100))
    d.cash_denominations = String(d.cash_denominations || '').replace(/\s+/g, '')
    delete d.gst
    delete d.margin
    for (const k of POLICY_KEYS) delete d[k]
    state.settings = await put('/settings', d)
    toast('Settings saved')
    renderShell()
  }))
  $('#pw', view).addEventListener('submit', guard(async (e) => {
    e.preventDefault()
    await post('/auth/change-password', formData(e.target))
    e.target.reset()
    toast('Password changed')
  }))
}

// ---------- till ----------

const TILL_ROWS = [
  ['opening_cash', 'Opening cash'], ['cash_sales', 'Cash sales'], ['card_sales', 'Card sales'], ['wallet_sales', 'Wallet sales'],
  ['refunds', 'Refunds (cash)'], ['cash_in', 'Cash in'], ['cash_out', 'Cash out'],
]
const time = (ts) => String(ts || '').slice(11, 16)
const varianceHtml = (v) => (v == null ? '' : `<span style="color:${v < 0 ? 'var(--danger)' : v > 0 ? 'var(--warn)' : 'inherit'}">${v > 0 ? '+' : ''}${rs(v)}</span>`)

function openTillDialog(onDone) {
  const m = modal(`<form id="otf"><h2>Open till</h2>
    <p class="muted">Count the notes and coins in the drawer.</p>
    ${noteGridHtml('open-notes')}
    <div class="actions"><button type="button" data-close>Cancel</button><button class="primary">Open till</button></div></form>`)
  bindNoteGrid($('#open-notes', m.el))
  $('#otf', m.el).addEventListener('submit', guard(async (e) => {
    e.preventDefault()
    const { notes, total } = readNotes($('#open-notes', m.el))
    await post('/tills/open', { notes, opening_cash: total })
    m.close()
    toast(`Till opened with ${rs(total)}`)
    await onDone?.()
  }))
}

async function closeTillDialog(onDone) {
  const cur = await get('/tills/current')
  if (!cur.session) throw new Error('Your till is not open')
  const expected = cur.totals?.expected_cash ?? 0
  const m = modal(`<form id="ctf"><h2>Close till</h2>
    <div class="totals">${TILL_ROWS.map(([k, l]) => `<div><span>${l}</span><span class="num">${rs(cur.totals?.[k])}</span></div>`).join('')}
      <div class="grand"><span>Expected cash</span><span class="num">${rs(expected)}</span></div></div>
    <h3 style="margin-top:14px">Count the drawer</h3>
    ${noteGridHtml('close-notes')}
    <div class="totals" id="variance"></div>
    <label class="field" style="margin-top:10px">Note (explain any difference)<input name="note"></label>
    <div class="actions"><button type="button" data-close>Cancel</button><button class="primary">Close till</button></div></form>`)
  bindNoteGrid($('#close-notes', m.el), (counted) => {
    $('#variance', m.el).innerHTML = `<div><span>Expected</span><span class="num">${rs(expected)}</span></div>
      <div><span>Counted</span><span class="num">${rs(counted)}</span></div>
      <div class="grand"><span>${counted - expected < 0 ? 'Short' : counted - expected > 0 ? 'Over' : 'Variance'}</span><span class="num">${varianceHtml(counted - expected)}</span></div>`
  })
  $('#ctf', m.el).addEventListener('submit', guard(async (e) => {
    e.preventDefault()
    const { notes, total } = readNotes($('#close-notes', m.el))
    const session = await post('/tills/current/close', { notes, counted_cash: total, note: e.target.note.value })
    m.close()
    toast(`Till closed. Variance ${rs(session.variance)}`)
    const detail = await get(`/tills/${session.id}`).catch(() => ({ session, totals: cur.totals, movements: [] }))
    tillDetailModal(detail)
    await onDone?.()
  }))
}

function cashMoveDialog(direction, onDone) {
  const m = modal(`<form id="cmf"><h2>${direction === 'in' ? 'Cash in' : 'Cash out'}</h2>
    <div class="grid">
      <label class="field">Amount (Rs) *<input name="amount" inputmode="decimal" required></label>
      <label class="field">Reason *<input name="reason" required placeholder="${direction === 'in' ? 'e.g. change from bank' : 'e.g. tea, petty expense'}"></label></div>
    <div class="actions"><button type="button" data-close>Cancel</button><button class="primary">Save</button></div></form>`)
  $('#cmf', m.el).addEventListener('submit', guard(async (e) => {
    e.preventDefault()
    const d = formData(e.target)
    const amount = paisaOrNull(d.amount)
    if (!amount || amount <= 0) throw new Error('Enter an amount')
    await post('/tills/current/movements', { direction, amount, reason: d.reason })
    m.close()
    toast(`Cash ${direction} ${rs(amount)} recorded`)
    await onDone?.()
  }))
}

// 80 mm till slip, same layout as receipts.
function tillSlipHtml(d) {
  const s = d.session || d
  const t = d.totals || {}
  const row = (l, v) => `<tr><td>${l}</td><td class="num">${v}</td></tr>`
  return `<div class="receipt">
    <div class="c big">${esc(state.settings.pharmacy_name)}</div>
    <div class="c">TILL ${s.status === 'closed' ? 'CLOSE' : 'STATUS'} #${esc(s.id)}</div><hr>
    <div>Cashier: ${esc(s.user_name || state.user.full_name)}</div>
    <div>Date: ${esc(s.business_date)}</div>
    <div>Opened: ${esc(s.opened_at)}</div>
    ${s.closed_at ? `<div>Closed: ${esc(s.closed_at)}</div>` : ''}<hr>
    <table>${TILL_ROWS.map(([k, l]) => row(l, toRupees(t[k]))).join('')}
      ${row('Invoices', esc(t.invoices ?? ''))}
      ${row('<b>Expected cash</b>', `<b>${toRupees(s.expected_cash ?? t.expected_cash)}</b>`)}
      ${s.counted_cash != null ? row('Counted cash', toRupees(s.counted_cash)) + row('Variance', toRupees(s.variance ?? s.counted_cash - s.expected_cash)) : ''}
    </table>
    ${s.closing_notes ? `<hr><div>Note count</div>${notesTableHtml(s.closing_notes)}` : ''}
    ${s.close_note ? `<hr><div>Note: ${esc(s.close_note)}</div>` : ''}
    <hr><div>Cashier sign: ____________</div><br><div>Checked by: ____________</div>
  </div>`
}

function tillDetailModal(d) {
  const s = d.session || d
  const t = d.totals || {}
  const moves = d.movements || []
  const m = modal(`<div class="row"><h2>Till #${esc(s.id)} — ${esc(s.user_name || '')}</h2><div class="spacer"></div><button id="print">Print slip</button></div>
    <p class="muted">${esc(s.business_date)} · opened ${esc(s.opened_at)}${s.closed_at ? ` · closed ${esc(s.closed_at)}` : ' · <b>open</b>'}</p>
    <div class="cards">${TILL_ROWS.map(([k, l]) => `<div class="card"><div class="label">${l}</div><div class="value">${rs(t[k])}</div></div>`).join('')}
      <div class="card"><div class="label">Expected cash</div><div class="value">${rs(s.expected_cash ?? t.expected_cash)}</div></div>
      ${s.counted_cash != null ? `<div class="card"><div class="label">Counted</div><div class="value">${rs(s.counted_cash)}</div></div>
        <div class="card"><div class="label">Variance</div><div class="value">${varianceHtml(s.variance ?? s.counted_cash - s.expected_cash)}</div></div>` : ''}</div>
    ${s.close_note ? `<p>Note: ${esc(s.close_note)}</p>` : ''}
    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(200px,1fr));margin-top:12px">
      ${s.opening_notes && Object.keys(parseJson(s.opening_notes)).length ? `<div><h3>Opening count</h3>${notesTableHtml(s.opening_notes)}</div>` : ''}
      ${s.closing_notes && Object.keys(parseJson(s.closing_notes)).length ? `<div><h3>Closing count</h3>${notesTableHtml(s.closing_notes)}</div>` : ''}
    </div>
    <h3 style="margin-top:12px">Cash in / out</h3>
    ${moves.length ? `<div class="table-wrap"><table><thead><tr><th>Time</th><th>Type</th><th>Reason</th><th class="num">Amount</th></tr></thead>
      <tbody>${moves.map((x) => `<tr><td>${esc(x.created_at)}</td><td>${x.direction === 'in' ? 'In' : 'Out'}</td><td>${esc(x.reason)}</td>
        <td class="num">${x.direction === 'out' ? '-' : ''}${rs(x.amount)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">None.</p>'}
    <div class="actions"><button class="primary" data-close>Close</button></div>`, { wide: true })
  $('#print', m.el).addEventListener('click', () => printHtml(tillSlipHtml(d)))
}

// Day-close record: { business_date, user_name, created_at, summary: { totals, sales, returns, net_sales, tills } }.
function dayCloseHtml(rec) {
  const sum = parseJson(rec.summary)
  const t = sum.totals || {}
  const card = (label, value) => `<div class="card"><div class="label">${label}</div><div class="value">${value}</div></div>`
  const tills = sum.tills || []
  return `<div class="panel stack"><div class="row"><span class="badge ok">Day closed</span>
      <span class="muted">${esc(rec.business_date)} · by ${esc(rec.user_name || '')} at ${esc(rec.created_at || '')}</span></div>
    <div class="cards">
      ${card('Invoices', `${esc(sum.sales?.count ?? 0)} · ${rs(sum.sales?.total)}`)}${card('Returns', `${esc(sum.returns?.count ?? 0)} · ${rs(sum.returns?.total)}`)}
      ${card('Net sales', rs(sum.net_sales))}${card('Cash sales', rs(t.cash_sales))}${card('Card + wallet', rs((t.card_sales || 0) + (t.wallet_sales || 0)))}
      ${card('Cash in / out', `${rs(t.cash_in)} / ${rs(t.cash_out)}`)}${card('Expected cash', rs(t.expected_cash))}${card('Counted cash', rs(t.counted_cash))}
      ${card('Variance', varianceHtml(t.variance ?? 0))}</div>
    ${tills.length ? `<div class="table-wrap"><table><thead><tr><th>Till</th><th>Cashier</th><th class="num">Expected</th><th class="num">Counted</th><th class="num">Variance</th></tr></thead>
      <tbody>${tills.map((x) => `<tr><td>#${esc(x.id)}</td><td>${esc(x.user_name)}</td><td class="num">${rs(x.expected_cash)}</td>
        <td class="num">${rs(x.counted_cash)}</td><td class="num">${varianceHtml(x.variance)}</td></tr>`).join('')}</tbody></table></div>` : ''}
    <div><button id="print-day">Print day close</button></div></div>`
}

async function tillView(view) {
  const f = { date: today() }
  const manager = can('admin', 'pharmacist')
  view.innerHTML = `<div class="stack">
    <div class="row"><h1>Till</h1></div>
    <div class="panel" id="current"></div>
    <div class="row"><h2 style="margin:0">Tills for</h2><input type="date" id="tdate" value="${f.date}" aria-label="Business date">
      <div class="spacer"></div>${manager ? '<button id="dayclose">Close day</button>' : ''}</div>
    <div id="dayrec"></div>
    <div class="panel table-wrap" id="tills"></div></div>`

  async function loadCurrent() {
    const box = $('#current', view)
    let cur
    try {
      cur = await get('/tills/current')
    } catch (e) {
      box.innerHTML = `<p class="muted">Till information is not available: ${esc(e.message)}</p>`
      return
    }
    if (!cur.session) {
      box.innerHTML = `<div class="row"><div><h2 style="margin:0">Your till is closed</h2>
        <p class="muted" style="margin:4px 0 0">${state.settings.require_open_till === '1' ? 'You must open your till before selling.' : 'Open a till to track the cash in your drawer.'}</p></div>
        <div class="spacer"></div><button class="primary" id="open">Open till</button></div>`
      $('#open', box).addEventListener('click', () => openTillDialog(reloadAll))
      return
    }
    const t = cur.totals || {}
    box.innerHTML = `<div class="row"><h2 style="margin:0">Your till <span class="badge ok">Open</span></h2>
        <span class="muted">since ${esc(cur.session.opened_at)}</span><div class="spacer"></div>
        <button id="cin">Cash in</button><button id="cout">Cash out</button><button id="detail">Details</button><button class="primary" id="close">Close till</button></div>
      <div class="cards" style="margin-top:12px">${TILL_ROWS.map(([k, l]) => `<div class="card"><div class="label">${l}</div><div class="value">${rs(t[k])}</div></div>`).join('')}
        <div class="card" style="border-color:var(--accent)"><div class="label">Expected cash</div><div class="value">${rs(t.expected_cash)}</div></div></div>`
    $('#cin', box).addEventListener('click', () => cashMoveDialog('in', reloadAll))
    $('#cout', box).addEventListener('click', () => cashMoveDialog('out', reloadAll))
    $('#close', box).addEventListener('click', guard(() => closeTillDialog(reloadAll)))
    $('#detail', box).addEventListener('click', guard(async () => tillDetailModal(await get(`/tills/${cur.session.id}`))))
  }

  async function loadDay() {
    const [rows, rec] = await Promise.all([
      get(`/tills?date=${f.date}`),
      manager ? get(`/tills/day-close?date=${f.date}`).then((x) => x.day_close ?? null).catch(() => null) : null,
    ])
    $('#dayrec', view).innerHTML = rec ? dayCloseHtml(rec) : ''
    $('#print-day', view)?.addEventListener('click', () => printHtml(`<h2>${esc(state.settings.pharmacy_name)}</h2>
      <h3>Day close ${esc(rec.business_date)}</h3>${dayCloseHtml(rec).replace(/<button[^>]*>.*?<\/button>/, '')}
      <p>Printed ${esc(new Date().toLocaleString())} by ${esc(state.user.full_name)}</p>`, 'report'))
    const dc = $('#dayclose', view)
    if (dc) dc.hidden = !!rec
    $('#tills', view).innerHTML = rows.length === 0 ? '<p class="muted">No tills for this date.</p>' : `<table>
      <thead><tr><th>#</th><th>Cashier</th><th>Opened</th><th>Closed</th><th>Status</th><th class="num">Cash sales</th><th class="num">Expected</th><th class="num">Counted</th><th class="num">Variance</th></tr></thead>
      <tbody>${rows.map((s) => {
        const t = s.totals || {}
        return `<tr class="clickable" data-id="${s.id}"><td>${s.id}</td><td>${esc(s.user_name || '')}</td><td>${esc(time(s.opened_at))}</td><td>${esc(time(s.closed_at))}</td>
          <td>${s.status === 'open' ? '<span class="badge near">Open</span>' : '<span class="badge ok">Closed</span>'}</td>
          <td class="num">${rs(t.cash_sales)}</td><td class="num">${rs(s.expected_cash ?? t.expected_cash)}</td>
          <td class="num">${s.counted_cash != null ? rs(s.counted_cash) : ''}</td><td class="num">${varianceHtml(s.variance ?? (s.counted_cash != null ? s.counted_cash - s.expected_cash : null))}</td></tr>`
      }).join('')}</tbody></table>`
  }

  const reloadAll = () => Promise.all([loadCurrent(), loadDay()]).catch((e) => toast(e.message, true))
  $('#tdate', view).addEventListener('change', (e) => { f.date = e.target.value || today(); loadDay().catch((x) => toast(x.message, true)) })
  $('#tills', view).addEventListener('click', guard(async (e) => {
    const tr = e.target.closest('tr[data-id]')
    if (tr) tillDetailModal(await get(`/tills/${tr.dataset.id}`))
  }))
  $('#dayclose', view)?.addEventListener('click', guard(async () => {
    if (!confirm(`Close the day ${f.date}? All tills for that date must be closed first.`)) return
    await post('/tills/day-close', { date: f.date })
    toast(`Day ${f.date} closed`)
    await loadDay()
  }))
  await reloadAll()
}

// ---------- owner panel ----------

const ownerSelect = (name, label, options, current) => `<label class="field">${label}<select name="${name}">
  ${options.map(([v, l]) => `<option value="${v}" ${v === current ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`

// Audit detail is JSON; show it as "key: value" pairs.
function auditDetailText(detail) {
  const d = parseJson(detail)
  if (d === null || typeof d !== 'object') return String(detail ?? '')
  return Object.entries(d)
    .map(([k, v]) => {
      const text = v !== null && typeof v === 'object'
        ? ('from' in v && 'to' in v ? `${v.from} → ${v.to}` : JSON.stringify(v))
        : v
      return `${k.replace(/_/g, ' ')}: ${text}`
    })
    .join(' · ')
}

async function ownerView(view) {
  const s = state.settings
  view.innerHTML = `<div class="stack">
    <h1>Owner</h1>
    <form class="panel stack" id="policy">
      <h2>Policy settings</h2>
      <div class="grid">
        ${ownerSelect('require_open_till', 'Every sale needs an open till', [['1', 'Yes'], ['0', 'No']], s.require_open_till === '0' ? '0' : '1')}
        ${ownerSelect('refund_card_sales', 'Refunds of card/wallet sales', [['drawer', 'Cash from drawer'], ['original', 'Back to card or wallet']], s.refund_card_sales === 'original' ? 'original' : 'drawer')}
        ${ownerSelect('opening_balance_due', 'Supplier opening balance falls due', [['terms', 'After credit days'], ['immediate', 'Immediately']], s.opening_balance_due === 'immediate' ? 'immediate' : 'terms')}
      </div>
      <h3>Maximum discount per role</h3>
      <div class="grid">
        ${['cashier', 'pharmacist', 'admin'].map((r) => `<label class="field">${r[0].toUpperCase() + r.slice(1)} (%)
          <input name="max_discount_${r}_bps" type="number" min="0" max="100" step="0.01" inputmode="decimal" value="${Number(s[`max_discount_${r}_bps`] ?? DEFAULT_DISCOUNT_BPS[r]) / 100}"></label>`).join('')}
      </div>
      <div class="row">
        <label class="field" style="flex:1;max-width:320px">Your password (to confirm)<input name="current_password" type="password" required autocomplete="current-password"></label>
        <button class="primary" style="align-self:flex-end">Save policies</button>
      </div>
    </form>
    <form class="panel stack" id="transfer">
      <h2>Transfer ownership</h2>
      <p class="muted" style="font-size:13px;margin:0">The new owner must be an active admin. You stay an admin but lose the owner controls.</p>
      <div class="row">
        <label class="field" style="flex:1;min-width:200px">New owner<select name="user_id" required id="newowner"><option value="">Loading…</option></select></label>
        <label class="field" style="flex:1;min-width:200px">Your password<input name="current_password" type="password" required autocomplete="current-password"></label>
        <button class="danger" style="align-self:flex-end">Transfer…</button>
      </div>
    </form>
    <div class="panel">
      <h2>Audit log</h2>
      <div class="table-wrap" id="audit"><p class="muted">Loading…</p></div>
    </div></div>`
  // The assistant module adds its own owner section (key status, on/off).
  const assistantEl = document.createElement('div')
  $('.stack', view).append(assistantEl)
  assistantOwnerSection(assistantEl, assistantContext())

  $('#policy', view).addEventListener('submit', guard(async (e) => {
    e.preventDefault()
    const d = formData(e.target)
    const body = { current_password: d.current_password }
    for (const k of ['require_open_till', 'refund_card_sales', 'opening_balance_due']) body[k] = d[k]
    for (const r of ['cashier', 'pharmacist', 'admin']) {
      const n = Number(d[`max_discount_${r}_bps`])
      if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error(`Enter a ${r} discount between 0 and 100`)
      body[`max_discount_${r}_bps`] = String(Math.round(n * 100))
    }
    await put('/owner/settings', body)
    await loadSettings()
    e.target.elements.current_password.value = ''
    toast('Policies saved')
    loadAudit().catch(() => {})
  }))

  const users = await get('/users').catch(() => [])
  const admins = users.filter((u) => u.role === 'admin' && u.active && u.id !== state.user.id)
  $('#newowner', view).innerHTML = admins.length
    ? `<option value="">Choose an admin…</option>${admins.map((u) => `<option value="${u.id}">${esc(u.full_name)} (${esc(u.username)})</option>`).join('')}`
    : '<option value="">No other active admin</option>'
  $('#transfer', view).addEventListener('submit', (e) => {
    e.preventDefault()
    const d = formData(e.target)
    const target = admins.find((u) => String(u.id) === d.user_id)
    if (!target) return toast('Choose an admin to receive ownership', true)
    const m = modal(`<h2>Transfer ownership?</h2>
      <p><b>${esc(target.full_name)}</b> will become the owner. You will no longer be able to change policies, view the audit log or transfer ownership.</p>
      <div class="actions"><button type="button" data-close>Cancel</button><button class="primary danger" id="confirm-transfer">Yes, transfer ownership</button></div>`)
    $('#confirm-transfer', m.el).addEventListener('click', guard(async () => {
      await post('/owner/transfer', { user_id: target.id, current_password: d.current_password })
      m.close()
      const { user } = await get('/auth/me')
      state.user = user
      await loadSettings()
      toast(`${target.full_name} is now the owner`)
      location.hash = '#/settings'
      renderShell()
    }))
  })

  async function loadAudit() {
    const rows = await get('/owner/audit?limit=200')
    $('#audit', view).innerHTML = rows.length === 0 ? '<p class="muted">Nothing recorded yet.</p>' : `<table>
      <thead><tr><th>Time</th><th>User</th><th>Action</th><th>Detail</th></tr></thead>
      <tbody>${rows.map((r) => `<tr><td style="white-space:nowrap">${esc(r.created_at)}</td><td>${esc(r.user_name || '')}</td>
        <td>${esc(String(r.action || '').replace(/[._]/g, ' '))}</td><td style="font-size:13px;word-break:break-word">${esc(auditDetailText(r.detail))}</td></tr>`).join('')}</tbody></table>`
  }
  await loadAudit()
}

// ---------- department issues ----------

const isoDaysAgo = (n) => {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
}
const STATUS_BADGE = { open: 'near', partial: 'near', closed: 'ok', cancelled: 'expired' }
const statusBadge = (st) => `<span class="badge ${STATUS_BADGE[st] || 'otc'}">${esc(st)}</span>`

// Search box that adds products via onPick. Enter picks the highlighted match or an exact barcode.
function itemPicker(box, onPick, placeholder = 'Scan barcode or search medicine / generic name') {
  box.innerHTML = `<div class="search-box"><input placeholder="${esc(placeholder)}" autocomplete="off" aria-label="Search items">
    <div class="results" hidden></div></div>`
  const input = $('input', box)
  const results = $('.results', box)
  let list = []
  let hl = 0
  let seq = 0
  let timer = null
  const renderResults = () => {
    results.hidden = list.length === 0 || !input.value.trim()
    results.innerHTML = list.map((p, i) => `<button type="button" data-i="${i}" class="${i === hl ? 'hl' : ''}">
      <div style="flex:1"><div class="name">${esc(productLabel(p))} ${schedBadge(p.schedule)}</div>
        <div class="muted">${esc(p.generic_name || '')}${p.manufacturer ? ' · ' + esc(p.manufacturer) : ''}</div></div>
      <div class="num muted">${p.stock > 0 ? `${esc(packsText(p.stock, p.pack_size))} in stock` : '<span class="badge expired">Out of stock</span>'}</div></button>`).join('')
  }
  const search = async (text) => {
    const my = ++seq
    const rows = text ? await get(`/products?q=${encodeURIComponent(text)}&limit=20`) : []
    if (my !== seq) return null
    list = rows
    hl = 0
    renderResults()
    return rows
  }
  const pick = (p) => {
    input.value = ''
    list = []
    renderResults()
    onPick(p)
    input.focus()
  }
  input.addEventListener('input', () => {
    clearTimeout(timer)
    timer = setTimeout(() => search(input.value.trim()).catch((e) => toast(e.message, true)), 150)
  })
  input.addEventListener('keydown', guard(async (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (list.length) hl = (hl + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length
      renderResults()
    } else if (e.key === 'Escape') {
      input.value = ''
      list = []
      renderResults()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const text = input.value.trim()
      if (!text) return
      clearTimeout(timer)
      const rows = (await search(text)) || list
      const found = rows.find((p) => p.barcode === text) || rows[hl] || (rows.length === 1 ? rows[0] : null)
      if (found) pick(found)
      else toast(`No product matches "${text}"`, true)
    }
  }))
  results.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-i]')
    if (b) pick(list[Number(b.dataset.i)])
  })
  return { focus: () => input.focus() }
}

// Packs/loose grid used by issues and requisitions. `lines` is mutated in place.
// opts: checkStock (reject more than is in stock), extra(line) -> html under the item name, onChange().
function qtyGrid(box, lines, opts = {}) {
  const render = () => {
    box.innerHTML = lines.length === 0
      ? '<div class="cart-empty">No items yet. Scan a barcode or search to add medicines.</div>'
      : `<div class="table-wrap"><table class="cart-table">
          <thead><tr><th>Item</th><th class="num">Stock</th><th>Packs</th><th>Loose</th><th class="num">Units</th><th></th></tr></thead>
          <tbody>${lines.map((l, i) => {
            const p = l.product
            const ps = p.pack_size || 1
            const over = lineUnits(l) > p.stock
            return `<tr><td>${esc(productLabel(p))} ${schedBadge(p.schedule)}
                <div class="muted">${ps > 1 ? `${esc(p.packing || 'Pack')} of ${ps}` : 'Single unit'}${opts.extra ? ' ' + opts.extra(l) : ''}</div></td>
              <td class="num" ${over && opts.checkStock ? 'style="color:var(--danger)"' : ''}>${esc(packsText(p.stock, ps))}</td>
              <td><input type="number" min="0" value="${l.packs}" data-packs="${i}" aria-label="Packs" class="qty"></td>
              <td>${canLoose(p) ? `<input type="number" min="0" max="${ps - 1}" value="${l.loose}" data-loose="${i}" aria-label="Loose units" class="qty">` : '<span class="muted">—</span>'}</td>
              <td class="num">${lineUnits(l)}</td>
              <td><button type="button" class="link danger" data-rm="${i}" aria-label="Remove ${esc(p.name)}">✕</button></td></tr>`
          }).join('')}</tbody></table></div>`
    opts.onChange?.()
  }
  const setQty = (line, packs, loose) => {
    const ps = line.product.pack_size || 1
    let p = Math.max(0, Math.floor(packs) || 0)
    let lo = canLoose(line.product) ? Math.max(0, Math.floor(loose) || 0) : 0
    if (ps > 1 && lo >= ps) { p += Math.floor(lo / ps); lo %= ps }
    const units = p * ps + lo
    if (units < 1) return toast('Quantity must be at least 1 — use ✕ to remove the line', true)
    if (opts.checkStock && units > line.product.stock) return toast(`Only ${packsText(line.product.stock, ps)} of ${line.product.name} in stock`, true)
    line.packs = p
    line.loose = lo
  }
  box.addEventListener('change', (e) => {
    const { packs, loose } = e.target.dataset
    const idx = packs ?? loose
    if (idx === undefined) return
    const line = lines[idx]
    if (packs !== undefined) setQty(line, Number(e.target.value), line.loose)
    else setQty(line, line.packs, Number(e.target.value))
    render()
  })
  box.addEventListener('click', (e) => {
    const b = e.target.closest('[data-rm]')
    if (!b) return
    lines.splice(Number(b.dataset.rm), 1)
    render()
  })
  return {
    render,
    add(p) {
      if (opts.checkStock && p.stock <= 0) return toast(`${p.name} is out of stock`, true)
      const line = lines.find((l) => l.product.id === p.id && !l.request_item_id) || lines.find((l) => l.product.id === p.id)
      if (line) {
        setQty(line, line.packs + 1, line.loose)
      } else {
        if (opts.checkStock && (p.pack_size || 1) > p.stock) lines.push({ product: p, packs: 0, loose: p.stock })
        else lines.push({ product: p, packs: 1, loose: 0 })
      }
      render()
    },
  }
}

const issueItemCost = (i) => i.line_cost ?? Math.round((i.qty || 0) * (i.unit_cost || 0))

function issueSlipHtml(issue) {
  const items = issue.items || []
  return `<div class="issue-slip">
    <h2>${esc(state.settings.pharmacy_name)}</h2>
    <h3>Department issue slip — ${esc(issue.issue_no)}</h3>
    <table class="slip-meta">
      <tr><td>Date</td><td>${esc(issue.created_at)}</td><td>Department</td><td><b>${esc(issue.department_name)}</b></td></tr>
      <tr><td>Received by</td><td>${esc(issue.received_by || '')}</td><td>Patient</td><td>${esc(issue.patient_name || '')}</td></tr>
      <tr><td>Issued by</td><td>${esc(issue.user_name || state.user.full_name)}</td><td>Requisition</td><td>${issue.request_id ? `#${esc(issue.request_id)}` : ''}</td></tr>
      ${issue.note ? `<tr><td>Note</td><td colspan="3">${esc(issue.note)}</td></tr>` : ''}
    </table>
    <table>
      <thead><tr><th>Item</th><th>Batch</th><th>Expiry</th><th class="num">Qty</th><th class="num">Unit cost</th><th class="num">Cost</th></tr></thead>
      <tbody>${items.map((i) => `<tr><td>${esc(i.product_name)} ${esc(i.strength || '')} ${schedBadge(i.schedule || 'otc')}</td><td>${esc(i.batch_no)}</td><td>${esc(i.expiry_date)}</td>
        <td class="num">${esc(qtyText(i.qty, i.pack_size))}</td><td class="num">${rs(i.unit_cost)}</td><td class="num">${rs(issueItemCost(i))}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td colspan="5">Total cost</td><td class="num">${rs(issue.total_cost)}</td></tr></tfoot>
    </table>
    <div class="sign-row"><div>Issued by (pharmacy)</div><div>Received by (${esc(issue.department_name)})</div></div>
  </div>`
}

function showIssueSlip(issue, onClose) {
  const m = modal(`<div class="row"><h2 style="margin:0">Issue ${esc(issue.issue_no)} saved</h2><div class="spacer"></div><button id="slip-print" class="primary">Print slip</button></div>
    <div class="panel" style="margin-top:12px;overflow-x:auto">${issueSlipHtml(issue)}</div>
    <div class="actions"><button data-close>Close</button></div>`, { wide: true, onClose })
  $('#slip-print', m.el).addEventListener('click', () => printHtml(issueSlipHtml(issue), 'report'))
  return m
}

async function issuesView(view) {
  const ctx = { tab: 'issue', departments: [] }
  const TABS = [['issue', 'Issue'], ['requisitions', 'Requisitions'], ['issued', 'Issued'], ['departments', 'Departments']]
  view.innerHTML = `<div class="stack">
    <h1>Department issues</h1>
    <div class="tabs" id="tabs">${TABS.map(([k, l]) => `<button data-t="${k}" class="${k === ctx.tab ? 'sel' : ''}">${l}</button>`).join('')}</div>
    <div id="pane"></div></div>`
  const pane = $('#pane', view)
  const loadDepartments = async () => { ctx.departments = await get('/departments?all=1') }
  const activeDepts = () => ctx.departments.filter((d) => d.active !== 0)
  const deptOptions = (sel, blank) => `${blank ? `<option value="">${esc(blank)}</option>` : ''}${activeDepts().map((d) => `<option value="${d.id}" ${String(d.id) === String(sel) ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}`

  // ----- Issue tab -----
  const iss = { dept: '', request: '', requests: [], received: '', patient: '', note: '', lines: [], busy: false }

  async function loadRequests() {
    iss.requests = iss.dept
      ? (await get(`/issue-requests?department_id=${iss.dept}`)).filter((r) => ['open', 'partial'].includes(r.status))
      : []
  }

  // Replaces the lines with what is still owed on a requisition.
  async function pickRequest(id) {
    iss.request = id ? String(id) : ''
    if (!id) return
    const req = await get(`/issue-requests/${id}`)
    iss.dept = String(req.department_id)
    const items = (req.items || []).filter((it) => it.qty_requested - it.qty_issued > 0)
    const prods = await Promise.all(items.map((it) => get(`/products/${it.product_id}`).catch(() => null)))
    iss.lines = items.map((it, k) => {
      const product = { id: it.product_id, name: it.product_name, strength: it.strength, form: it.form, schedule: 'otc', allow_loose: 1, ...(prods[k] || {}), pack_size: it.pack_size || prods[k]?.pack_size || 1, stock: it.stock ?? prods[k]?.stock ?? 0 }
      const units = it.qty_requested - it.qty_issued
      const ps = product.pack_size || 1
      return { product, packs: Math.floor(units / ps), loose: units % ps, request_item_id: it.id, remaining: units }
    })
    // Received by is left for the person collecting the stock to be entered deliberately (controlled drugs need it).
    await loadRequests()
    if (!iss.requests.some((r) => String(r.id) === iss.request)) iss.requests.push(req)
  }

  function renderIssue() {
    pane.innerHTML = `<form class="panel stack" id="issf" autocomplete="off">
      <div class="grid">
        <label class="field">Department *<select name="dept" required>${deptOptions(iss.dept, 'Choose department…')}</select></label>
        <label class="field">Requisition (optional)<select name="request"><option value="">No requisition</option>
          ${iss.requests.map((r) => `<option value="${r.id}" ${String(r.id) === iss.request ? 'selected' : ''}>#${r.id}${r.ref_no ? ' · ' + esc(r.ref_no) : ''} · ${esc(r.status)} · ${esc(String(r.created_at || '').slice(0, 10))}</option>`).join('')}</select></label>
        <label class="field"><span id="recv-label">Received by</span><input name="received" value="${esc(iss.received)}"></label>
        <label class="field">Patient name (optional)<input name="patient" value="${esc(iss.patient)}"></label>
        <label class="field">Note<input name="note" value="${esc(iss.note)}"></label>
      </div>
      <div id="picker"></div>
      <div id="lines"></div>
      <div class="muted" style="font-size:13px">Issued stock is valued at cost, taken from the batches that expire first. Nothing is charged and no till is involved.</div>
      <div class="alert" id="ctrl-note" hidden>This issue has a controlled drug. “Received by” is required.</div>
      <div class="row"><div class="spacer"></div><button type="button" id="issue-clear">Clear</button><button class="primary" id="issue-save">Issue stock</button></div>
    </form>`
    const form = $('#issf', pane)
    const grid = qtyGrid($('#lines', pane), iss.lines, {
      checkStock: true,
      extra: (l) => (l.request_item_id ? `· <b>requested, ${esc(qtyText(l.remaining, l.product.pack_size))} still owed</b>` : ''),
      onChange: () => {
        const ctrl = iss.lines.some((l) => l.product.schedule === 'controlled')
        $('#ctrl-note', pane).hidden = !ctrl
        $('#recv-label', pane).textContent = ctrl ? 'Received by *' : 'Received by'
      },
    })
    grid.render()
    const picker = itemPicker($('#picker', pane), (p) => grid.add(p))
    form.elements.dept.addEventListener('change', guard(async (e) => {
      iss.dept = e.target.value
      iss.request = ''
      iss.lines = iss.lines.filter((l) => !l.request_item_id)
      await loadRequests()
      renderIssue()
    }))
    form.elements.request.addEventListener('change', guard(async (e) => {
      if (e.target.value) await pickRequest(e.target.value)
      else iss.request = ''
      if (!e.target.value) iss.lines = iss.lines.filter((l) => !l.request_item_id)
      renderIssue()
    }))
    form.addEventListener('input', (e) => {
      if (['received', 'patient', 'note'].includes(e.target.name)) iss[e.target.name] = e.target.value
    })
    $('#issue-clear', pane).addEventListener('click', () => {
      Object.assign(iss, { request: '', received: '', patient: '', note: '', lines: [] })
      renderIssue()
    })
    form.addEventListener('submit', guard(async (e) => {
      e.preventDefault()
      if (iss.busy) return
      if (!iss.dept) throw new Error('Choose the department')
      if (!iss.lines.length) throw new Error('Add at least one item')
      if (iss.lines.some((l) => l.product.schedule === 'controlled') && !iss.received.trim()) throw new Error('Enter who received the controlled drug')
      iss.busy = true
      $('#issue-save', pane).disabled = true
      try {
        const res = await post('/issues', {
          department_id: Number(iss.dept),
          request_id: iss.request ? Number(iss.request) : undefined,
          received_by: iss.received.trim(),
          patient_name: iss.patient.trim(),
          note: iss.note.trim(),
          items: iss.lines.map((l) => ({ product_id: l.product.id, qty: lineUnits(l), request_item_id: l.request_item_id })),
        })
        const full = await get(`/issues/${res.id}`).catch(() => res)
        Object.assign(iss, { request: '', requests: [], received: '', patient: '', note: '', lines: [] })
        await loadRequests()
        renderIssue()
        showIssueSlip(full)
      } finally {
        iss.busy = false
        const btn = $('#issue-save', pane)
        if (btn) btn.disabled = false
      }
    }))
    if (iss.dept) picker.focus()
  }

  // ----- Requisitions tab -----
  async function renderRequisitions() {
    const f = ctx.reqFilter || (ctx.reqFilter = { status: '', department_id: '' })
    pane.innerHTML = `<div class="stack"><div class="row">
      <label class="field">Status<select id="rf-status">${['', 'open', 'partial', 'closed', 'cancelled'].map((s) => `<option value="${s}" ${s === f.status ? 'selected' : ''}>${s || 'All'}</option>`).join('')}</select></label>
      <label class="field">Department<select id="rf-dept">${deptOptions(f.department_id, 'All departments')}</select></label>
      <div class="spacer"></div><button class="primary" id="req-add">New requisition</button></div>
      <div class="panel table-wrap" id="reqlist"></div></div>`
    const load = async () => {
      const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString()
      const rows = await get(`/issue-requests${qs ? `?${qs}` : ''}`)
      $('#reqlist', pane).innerHTML = rows.length === 0 ? '<p class="muted">No requisitions.</p>' : `<table>
        <thead><tr><th>#</th><th>Date</th><th>Department</th><th>Ref no</th><th>Requested by</th><th>Status</th><th class="num">Items</th></tr></thead>
        <tbody>${rows.map((r) => `<tr class="clickable" data-id="${r.id}"><td>${r.id}</td><td>${esc(String(r.created_at || '').slice(0, 10))}</td><td>${esc(r.department_name)}</td>
          <td>${esc(r.ref_no || '')}</td><td>${esc(r.requested_by || '')}</td><td>${statusBadge(r.status)}</td><td class="num">${esc(r.item_count ?? '')}</td></tr>`).join('')}</tbody></table>`
    }
    $('#rf-status', pane).addEventListener('change', (e) => { f.status = e.target.value; load().catch((x) => toast(x.message, true)) })
    $('#rf-dept', pane).addEventListener('change', (e) => { f.department_id = e.target.value; load().catch((x) => toast(x.message, true)) })
    $('#req-add', pane).addEventListener('click', () => requisitionForm(load))
    $('#reqlist', pane).addEventListener('click', guard(async (e) => {
      const tr = e.target.closest('tr[data-id]')
      if (tr) await requisitionDetail(Number(tr.dataset.id), load)
    }))
    await load()
  }

  function requisitionForm(onSaved) {
    const lines = []
    const m = modal(`<form id="rqf"><h2>New requisition</h2>
      <div class="grid">
        <label class="field">Department *<select name="department_id" required>${deptOptions('', 'Choose department…')}</select></label>
        <label class="field">Requested by<input name="requested_by"></label>
        <label class="field">Ref no<input name="ref_no"></label>
        <label class="field">Note<input name="note"></label>
      </div>
      <div id="rq-picker" style="margin-top:12px"></div><div id="rq-lines" style="margin-top:8px"></div>
      <div class="actions"><button type="button" data-close>Cancel</button><button class="primary">Save requisition</button></div></form>`, { wide: true })
    const grid = qtyGrid($('#rq-lines', m.el), lines)
    grid.render()
    itemPicker($('#rq-picker', m.el), (p) => grid.add(p))
    $('#rqf', m.el).addEventListener('submit', guard(async (e) => {
      e.preventDefault()
      const d = formData(e.target)
      if (!lines.length) throw new Error('Add at least one item')
      await post('/issue-requests', {
        department_id: Number(d.department_id), requested_by: d.requested_by, ref_no: d.ref_no, note: d.note,
        items: lines.map((l) => ({ product_id: l.product.id, qty: lineUnits(l) })),
      })
      m.close()
      toast('Requisition saved')
      await onSaved()
    }))
  }

  async function requisitionDetail(id, onChange) {
    const r = await get(`/issue-requests/${id}`)
    const live = ['open', 'partial'].includes(r.status)
    const m = modal(`<div class="row"><h2 style="margin:0">Requisition #${r.id} — ${esc(r.department_name)}</h2>${statusBadge(r.status)}</div>
      <p class="muted">${esc(String(r.created_at || '').slice(0, 10))}${r.requested_by ? ` · requested by ${esc(r.requested_by)}` : ''}${r.ref_no ? ` · ref ${esc(r.ref_no)}` : ''}${r.note ? ` · ${esc(r.note)}` : ''}</p>
      <div class="table-wrap"><table><thead><tr><th>Item</th><th class="num">Requested</th><th class="num">Issued</th><th class="num">Still owed</th><th class="num">In stock</th></tr></thead>
      <tbody>${(r.items || []).map((i) => `<tr><td>${esc(i.product_name)} ${esc(i.strength || '')}</td>
        <td class="num">${esc(qtyText(i.qty_requested, i.pack_size))}</td><td class="num">${esc(qtyText(i.qty_issued, i.pack_size))}</td>
        <td class="num">${esc(qtyText(Math.max(0, i.qty_requested - i.qty_issued), i.pack_size))}</td><td class="num">${esc(packsText(i.stock ?? 0, i.pack_size))}</td></tr>`).join('')}</tbody></table></div>
      <div class="actions"><button data-close>Close</button>
        ${live ? '<button class="danger" id="rq-cancel">Cancel requisition</button><button class="primary" id="rq-issue">Issue now</button>' : ''}</div>`, { wide: true })
    $('#rq-issue', m.el)?.addEventListener('click', guard(async () => {
      await pickRequest(r.id)
      m.close()
      showTab('issue')
    }))
    $('#rq-cancel', m.el)?.addEventListener('click', guard(async () => {
      if (!confirm(`Cancel requisition #${r.id}?`)) return
      await post(`/issue-requests/${r.id}/cancel`)
      m.close()
      toast('Requisition cancelled')
      await onChange()
    }))
  }

  // ----- Issued tab -----
  async function renderIssued() {
    const f = ctx.issuedFilter || (ctx.issuedFilter = { from: isoDaysAgo(30), to: today(), department_id: '' })
    pane.innerHTML = `<div class="stack"><div class="row">
      <label class="field">From<input type="date" id="if-from" value="${f.from}"></label>
      <label class="field">To<input type="date" id="if-to" value="${f.to}"></label>
      <label class="field">Department<select id="if-dept">${deptOptions(f.department_id, 'All departments')}</select></label></div>
      <div class="panel table-wrap" id="issuedlist"></div></div>`
    const load = async () => {
      const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString()
      const rows = await get(`/issues?${qs}`)
      const sum = (k) => rows.reduce((t, r) => t + (r[k] || 0), 0)
      $('#issuedlist', pane).innerHTML = rows.length === 0 ? '<p class="muted">No issues in this period.</p>' : `<table>
        <thead><tr><th>Issue no</th><th>Date</th><th>Department</th><th>Received by</th><th class="num">Items</th><th class="num">Cost</th><th class="num">Returned</th></tr></thead>
        <tbody>${rows.map((r) => `<tr class="clickable" data-id="${r.id}"><td>${esc(r.issue_no)}</td><td>${esc(r.created_at)}</td><td>${esc(r.department_name)}</td><td>${esc(r.received_by || '')}</td>
          <td class="num">${esc(r.item_count)}</td><td class="num">${rs(r.total_cost)}</td><td class="num">${r.returned_cost ? rs(r.returned_cost) : ''}</td></tr>`).join('')}</tbody>
        <tfoot><tr><td colspan="5">Total</td><td class="num">${rs(sum('total_cost'))}</td><td class="num">${rs(sum('returned_cost'))}</td></tr></tfoot></table>`
    }
    const reload = () => load().catch((x) => toast(x.message, true))
    $('#if-from', pane).addEventListener('change', (e) => { f.from = e.target.value; reload() })
    $('#if-to', pane).addEventListener('change', (e) => { f.to = e.target.value; reload() })
    $('#if-dept', pane).addEventListener('change', (e) => { f.department_id = e.target.value; reload() })
    $('#issuedlist', pane).addEventListener('click', guard(async (e) => {
      const tr = e.target.closest('tr[data-id]')
      if (tr) await issueDetail(Number(tr.dataset.id), load)
    }))
    await load()
  }

  async function issueDetail(id, onChange) {
    const issue = await get(`/issues/${id}`)
    const items = issue.items || []
    const returnable = items.some((i) => i.qty > (i.returned_qty || 0))
    const m = modal(`<div class="row"><h2 style="margin:0">${esc(issue.issue_no)} — ${esc(issue.department_name)}</h2><div class="spacer"></div><button id="is-print">Print slip</button></div>
      <p class="muted">${esc(issue.created_at)}${issue.received_by ? ` · received by ${esc(issue.received_by)}` : ''}${issue.patient_name ? ` · patient ${esc(issue.patient_name)}` : ''}${issue.request_id ? ` · requisition #${esc(issue.request_id)}` : ''}${issue.note ? ` · ${esc(issue.note)}` : ''}</p>
      <form id="isret"><div class="table-wrap"><table>
        <thead><tr><th>Item</th><th>Batch</th><th class="num">Issued</th><th class="num">Returned</th><th class="num">Cost</th>${returnable ? '<th>Return (units)</th>' : ''}</tr></thead>
        <tbody>${items.map((i) => `<tr><td>${esc(i.product_name)} ${esc(i.strength || '')} ${schedBadge(i.schedule || 'otc')}</td>
          <td>${esc(i.batch_no)} <span class="muted">${esc(i.expiry_date)}</span></td><td class="num">${esc(qtyText(i.qty, i.pack_size))}</td>
          <td class="num">${i.returned_qty ? `${i.returned_qty} units` : ''}</td><td class="num">${rs(issueItemCost(i))}</td>
          ${returnable ? `<td>${i.qty > (i.returned_qty || 0) ? `<input type="number" min="0" max="${i.qty - (i.returned_qty || 0)}" value="0" name="r${i.id}" aria-label="Return quantity (units)">` : ''}</td>` : ''}</tr>`).join('')}</tbody>
        <tfoot><tr><td colspan="4">Total cost</td><td class="num">${rs(issue.total_cost)}</td>${returnable ? '<td></td>' : ''}</tr></tfoot></table></div>
      ${(issue.returns || []).length ? `<h3>Returns</h3><ul>${issue.returns.map((r) => `<li>${esc(r.created_at)} — ${rs(r.total_cost)}${r.user_name ? ` by ${esc(r.user_name)}` : ''}${r.reason ? `: ${esc(r.reason)}` : ''}</li>`).join('')}</ul>` : ''}
      ${returnable ? `<div class="row" style="margin-top:10px"><label class="field" style="flex:1">Return reason<input name="reason" placeholder="e.g. not needed, ward closed"></label>
        <label class="row" style="font-size:13px"><input type="checkbox" name="restock" checked> Put back in stock</label></div>
        <p class="muted" style="font-size:13px">Expired batches are never put back in stock.</p>` : ''}
      <div class="actions"><button type="button" data-close>Close</button>${returnable ? '<button class="primary">Record return</button>' : ''}</div></form>`, { wide: true })
    $('#is-print', m.el).addEventListener('click', () => printHtml(issueSlipHtml(issue), 'report'))
    $('#isret', m.el).addEventListener('submit', guard(async (e) => {
      e.preventDefault()
      const d = formData(e.target)
      const lines = items.map((i) => ({ issue_item_id: i.id, qty: Number(d[`r${i.id}`] || 0), restock: !!d.restock })).filter((i) => i.qty > 0)
      if (!lines.length) throw new Error('Enter a quantity to return')
      await post(`/issues/${id}/returns`, { items: lines, reason: d.reason })
      m.close()
      toast('Return recorded')
      await onChange()
    }))
  }

  // ----- Departments tab -----
  async function renderDepartments() {
    pane.innerHTML = `<div class="stack"><div class="row"><div class="spacer"></div><button class="primary" id="dept-add">Add department</button></div>
      <div class="panel table-wrap" id="deptlist"></div></div>`
    const draw = () => {
      $('#deptlist', pane).innerHTML = ctx.departments.length === 0 ? '<p class="muted">No departments yet.</p>' : `<table>
        <thead><tr><th>Name</th><th>In-charge</th><th>Status</th></tr></thead>
        <tbody>${ctx.departments.map((d) => `<tr class="clickable" data-id="${d.id}"><td>${esc(d.name)}</td><td>${esc(d.incharge || '')}</td>
          <td>${d.active !== 0 ? '<span class="badge ok">Active</span>' : '<span class="muted">Inactive</span>'}</td></tr>`).join('')}</tbody></table>`
    }
    const form = (d) => {
      const m = modal(`<form id="df"><h2>${d ? 'Edit' : 'Add'} department</h2><div class="grid">
        <label class="field">Name *<input name="name" value="${esc(d?.name)}" required></label>
        <label class="field">In-charge<input name="incharge" value="${esc(d?.incharge)}"></label></div>
        <label class="row" style="margin-top:10px"><input type="checkbox" name="active" ${d?.active !== 0 ? 'checked' : ''}> Active</label>
        <div class="actions"><button type="button" data-close>Cancel</button><button class="primary">Save</button></div></form>`)
      $('#df', m.el).addEventListener('submit', guard(async (e) => {
        e.preventDefault()
        const v = formData(e.target)
        const body = { name: v.name.trim(), incharge: v.incharge, active: v.active ? 1 : 0 }
        if (d) await put(`/departments/${d.id}`, body)
        else await post('/departments', body)
        m.close()
        toast('Department saved')
        await loadDepartments()
        draw()
      }))
    }
    $('#dept-add', pane).addEventListener('click', () => form(null))
    $('#deptlist', pane).addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-id]')
      if (tr) form(ctx.departments.find((d) => d.id === Number(tr.dataset.id)))
    })
    draw()
  }

  async function showTab(tab) {
    ctx.tab = tab
    $$('#tabs button', view).forEach((x) => x.classList.toggle('sel', x.dataset.t === tab))
    if (tab === 'issue') {
      if (iss.dept && !iss.requests.length) await loadRequests()
      renderIssue()
    } else if (tab === 'requisitions') await renderRequisitions()
    else if (tab === 'issued') await renderIssued()
    else await renderDepartments()
  }
  $('#tabs', view).addEventListener('click', guard(async (e) => {
    const b = e.target.closest('button[data-t]')
    if (b) await showTab(b.dataset.t)
  }))
  await loadDepartments()
  await showTab('issue')
}

// Department usage report: per department, then per product for one department.
async function deptUsageReport(out, f, setTitle) {
  const range = `from=${f.from}&to=${f.to}`
  const period = f.from === f.to ? f.from : `${f.from} to ${f.to}`
  const head = (cols) => `<thead><tr>${cols.map((h) => `<th class="${h.startsWith('#') ? 'num' : ''}">${esc(h.replace(/^#/, ''))}</th>`).join('')}</tr></thead>`
  const show = async (dept) => {
    if (!dept) {
      const rows = await get(`/reports/department-usage?${range}`)
      setTitle(`Department usage ${period}`)
      const sum = (k) => rows.reduce((t, r) => t + (r[k] || 0), 0)
      out.innerHTML = `<div class="panel table-wrap"><table>${head(['Department', '#Issues', '#Issued cost', '#Returned cost', '#Net cost'])}
        <tbody>${rows.length ? rows.map((r) => `<tr class="clickable" data-dept="${r.department_id}" data-name="${esc(r.name)}"><td>${esc(r.name)}</td><td class="num">${r.issues}</td>
          <td class="num">${rs(r.issued_cost)}</td><td class="num">${rs(r.returned_cost)}</td><td class="num">${rs(r.net_cost)}</td></tr>`).join('') : '<tr><td colspan="5" class="muted">Nothing issued in this period.</td></tr>'}</tbody>
        <tfoot><tr><td>Total</td><td class="num">${sum('issues')}</td><td class="num">${rs(sum('issued_cost'))}</td><td class="num">${rs(sum('returned_cost'))}</td><td class="num">${rs(sum('net_cost'))}</td></tr></tfoot></table></div>
        <p class="muted" style="font-size:13px">Click a department to see usage by product. Values are at cost.</p>`
    } else {
      const rows = await get(`/reports/department-usage?${range}&department_id=${dept.id}`)
      setTitle(`Department usage — ${dept.name} ${period}`)
      const sum = (k) => rows.reduce((t, r) => t + (r[k] || 0), 0)
      out.innerHTML = `<div class="stack"><div class="row"><button class="link" data-back>← All departments</button><h3 style="margin:0">${esc(dept.name)}</h3></div>
        <div class="panel table-wrap"><table>${head(['Product', '#Qty issued', '#Qty returned', '#Net cost'])}
        <tbody>${rows.length ? rows.map((r) => `<tr><td>${esc(r.name)} ${esc(r.strength || '')}</td><td class="num">${r.qty_issued}</td><td class="num">${r.qty_returned || ''}</td><td class="num">${rs(r.net_cost)}</td></tr>`).join('') : '<tr><td colspan="4" class="muted">Nothing issued in this period.</td></tr>'}</tbody>
        <tfoot><tr><td>Total</td><td class="num">${sum('qty_issued')}</td><td class="num">${sum('qty_returned')}</td><td class="num">${rs(sum('net_cost'))}</td></tr></tfoot></table></div></div>`
    }
  }
  out.onclick = (e) => {
    const tr = e.target.closest('tr[data-dept]')
    if (tr) show({ id: tr.dataset.dept, name: tr.dataset.name }).catch((x) => toast(x.message, true))
    else if (e.target.closest('[data-back]')) show(null).catch((x) => toast(x.message, true))
  }
  await show(null)
}

boot()
