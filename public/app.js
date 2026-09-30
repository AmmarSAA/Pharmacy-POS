// Pharmacy POS front end. Plain ES modules, no build step.
// Money from the API is integer paisa; everything shown to people is rupees.

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
  const { needsSetup } = await get('/auth/status').catch(() => ({ needsSetup: false }))
  $('#modal-root').innerHTML = ''
  $('#app').innerHTML = needsSetup
    ? `<div class="auth"><form class="panel" id="auth-form">
        <h1>Set up your pharmacy</h1>
        <p class="muted">Create the owner (admin) account. You can add pharmacists and cashiers afterwards.</p>
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
  { path: 'sales', label: 'Sales & returns', view: salesView },
  { path: 'products', label: 'Products', view: productsView },
  { path: 'stock', label: 'Stock & expiry', view: stockView },
  { path: 'purchases', label: 'Purchases', view: purchasesView, roles: ['admin', 'pharmacist'] },
  { path: 'suppliers', label: 'Suppliers', view: suppliersView, roles: ['admin', 'pharmacist'] },
  { path: 'reports', label: 'Reports', view: reportsView, roles: ['admin', 'pharmacist'] },
  { path: 'users', label: 'Users', view: usersView, roles: ['admin'] },
  { path: 'settings', label: 'Settings', view: settingsView },
]
const allowed = () => ROUTES.filter((r) => !r.roles || can(...r.roles))
let teardown = null

function renderShell() {
  $('#app').innerHTML = `<div class="shell">
    <nav class="side">
      <div class="brand">${esc(state.settings.pharmacy_name)}</div>
      ${allowed().map((r) => `<a href="#/${r.path}" data-path="${r.path}">${r.label}</a>`).join('')}
      <div class="who">${esc(state.user.full_name)}<br><span>${esc(state.user.role)}</span><br>
        <button class="link" id="logout">Sign out</button></div>
    </nav>
    <main id="view"></main>
  </div>`
  $('#logout').addEventListener('click', guard(async () => {
    await post('/auth/logout')
    state.user = null
    renderAuth()
  }))
  route()
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

function receiptHtml(sale) {
  const s = state.settings
  const rows = sale.items.map((i) => `
    <tr><td colspan="3">${esc(i.product_name)} ${esc(i.strength || '')}${i.schedule !== 'otc' ? ' (Rx)' : ''}</td></tr>
    <tr><td>&nbsp; ${i.qty} x ${toRupees(i.unit_price)}${i.discount ? ` -${pct(i.discount_bps)}` : ''}</td>
      <td style="font-size:10px">B:${esc(i.batch_no)} E:${esc(i.expiry_date.slice(0, 7))}</td>
      <td class="num">${toRupees(i.line_total)}</td></tr>`).join('')
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

function posView(view) {
  const rxDefaults = () => ({ patient_name: '', patient_phone: '', patient_cnic: '', prescriber_name: '', prescriber_reg_no: '', rx_date: today(), notes: '' })
  const pos = { cart: [], results: [], hl: 0, method: 'cash', paid: '', customer: '', phone: '', rx: rxDefaults(), busy: false }
  const maxDiscount = { cashier: 10, pharmacist: 25, admin: 100 }[state.user.role]

  view.innerHTML = `<div class="pos">
    <div class="stack">
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
          <div class="muted">${esc(p.generic_name || '')}${p.manufacturer ? ' · ' + esc(p.manufacturer) : ''}</div></div>
        <div class="num"><div>${rs(p.current_price ?? p.sale_price)}</div>
          <div class="muted">${p.stock > 0 ? `${p.stock} in stock` : '<span class="badge expired">Out of stock</span>'}</div></div>
      </button>`).join('')
  }

  function addToCart(p) {
    if (p.stock <= 0) return toast(`${p.name} is out of stock`, true)
    const line = pos.cart.find((l) => l.product.id === p.id)
    if (line) {
      if (line.qty + 1 > p.stock) return toast(`Only ${p.stock} of ${p.name} in stock`, true)
      line.qty += 1
    } else {
      pos.cart.push({ product: p, qty: 1, discount: 0 })
    }
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
      const gross = (l.product.current_price ?? l.product.sale_price) * l.qty
      subtotal += gross
      discount += Math.round((gross * l.discount) / 100)
    }
    const net = subtotal - discount
    const total = state.settings.round_to_rupee === '1' ? Math.round(net / 100) * 100 : net
    return { subtotal, discount, total, roundOff: total - net }
  }
  const needsRx = () => pos.cart.some((l) => l.product.schedule !== 'otc')
  const needsControlled = () => pos.cart.some((l) => l.product.schedule === 'controlled')

  function render() {
    const cart = $('#cart', view)
    cart.innerHTML = pos.cart.length === 0
      ? '<div class="cart-empty">Cart is empty. Scan a barcode or search to add medicines.</div>'
      : `<div class="table-wrap"><table>
          <thead><tr><th>Item</th><th class="num">Price</th><th>Qty</th><th>Disc %</th><th class="num">Total</th><th></th></tr></thead>
          <tbody>${pos.cart.map((l, i) => {
            const price = l.product.current_price ?? l.product.sale_price
            const gross = price * l.qty
            return `<tr>
              <td>${esc(productLabel(l.product))} ${schedBadge(l.product.schedule)}
                <div class="muted">${l.product.stock} in stock${l.product.next_expiry ? ` · exp ${esc(l.product.next_expiry)}` : ''}</div></td>
              <td class="num">${rs(price)}</td>
              <td><input type="number" min="1" max="${l.product.stock}" value="${l.qty}" data-qty="${i}" aria-label="Quantity"></td>
              <td><input type="number" min="0" max="${maxDiscount}" step="0.5" value="${l.discount}" data-disc="${i}" aria-label="Discount percent"></td>
              <td class="num">${rs(gross - Math.round((gross * l.discount) / 100))}</td>
              <td><button class="link danger" data-rm="${i}" aria-label="Remove">✕</button></td>
            </tr>`
          }).join('')}</tbody></table></div>`
    renderSide()
  }

  function renderSide() {
    const t = totals()
    const paid = pos.paid === '' ? t.total : toPaisa(pos.paid) || 0
    const change = paid - t.total
    const side = $('#side', view)
    const rx = pos.rx
    side.innerHTML = `
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
        <button class="primary checkout" id="checkout" ${pos.cart.length === 0 || pos.busy ? 'disabled' : ''}>Complete sale <span class="kbd">F9</span></button>
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
    const t = totals()
    const body = {
      items: pos.cart.map((l) => ({ product_id: l.product.id, qty: l.qty, discount_bps: Math.round(l.discount * 100) })),
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
      renderSide()
    }
  })

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
    const qi = e.target.dataset.qty
    const di = e.target.dataset.disc
    if (qi !== undefined) {
      const line = pos.cart[qi]
      const v = Math.max(1, Math.floor(Number(e.target.value) || 1))
      if (v > line.product.stock) toast(`Only ${line.product.stock} in stock`, true)
      line.qty = Math.min(v, line.product.stock)
    }
    if (di !== undefined) {
      const v = Math.max(0, Number(e.target.value) || 0)
      if (v > maxDiscount) toast(`Your maximum discount is ${maxDiscount}%`, true)
      pos.cart[di].discount = Math.min(v, maxDiscount)
    }
    render()
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
  const m = modal(`
    <div class="row"><h2>${esc(sale.invoice_no)}</h2><div class="spacer"></div><button id="print">Print receipt</button></div>
    ${sale.prescription ? `<p class="muted">Rx: ${esc(sale.prescription.patient_name)}${sale.prescription.patient_cnic ? ` (${esc(sale.prescription.patient_cnic)})` : ''}
      — ${esc(sale.prescription.prescriber_name)}${sale.prescription.prescriber_reg_no ? `, ${esc(sale.prescription.prescriber_reg_no)}` : ''}</p>` : ''}
    <form id="ret"><div class="table-wrap"><table>
      <thead><tr><th>Item</th><th>Batch</th><th class="num">Qty</th><th class="num">Line total</th>${canReturn ? '<th>Return</th>' : ''}</tr></thead>
      <tbody>${sale.items.map((i) => `<tr>
        <td>${esc(i.product_name)} ${esc(i.strength || '')} ${schedBadge(i.schedule)}</td>
        <td>${esc(i.batch_no)} <span class="muted">${esc(i.expiry_date)}</span></td>
        <td class="num">${i.qty}${i.returned_qty ? ` <span class="muted">(${i.returned_qty} returned)</span>` : ''}</td>
        <td class="num">${rs(i.line_total)}</td>
        ${canReturn ? `<td>${i.qty > i.returned_qty ? `<input type="number" min="0" max="${i.qty - i.returned_qty}" value="0" name="r${i.id}" aria-label="Return quantity">` : ''}</td>` : ''}
      </tr>`).join('')}</tbody></table></div>
      <p class="num">Total ${rs(sale.total)} · ${esc(sale.payment_method)} · ${esc(sale.created_at)} · ${esc(sale.cashier_name)}</p>
      ${sale.returns.length ? `<h3>Returns</h3><ul>${sale.returns.map((r) => `<li>${esc(r.created_at)} — ${rs(r.refund_total)} by ${esc(r.user_name)}: ${esc(r.reason)}</li>`).join('')}</ul>` : ''}
      ${canReturn && returnable.length ? `<div class="row"><label class="field" style="flex:1">Return reason<input name="reason" placeholder="e.g. wrong item, unopened"></label>
        <label class="row" style="font-size:13px"><input type="checkbox" name="restock" checked> Put back in stock</label></div>` : ''}
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

async function productsView(view) {
  const editable = can('admin', 'pharmacist')
  view.innerHTML = `<div class="stack">
    <div class="row"><h1>Products</h1><div class="spacer"></div>
      <input id="pq" placeholder="Search name, generic or barcode">
      <label class="row" style="font-size:13px"><input type="checkbox" id="inactive"> Show inactive</label>
      ${editable ? '<button class="primary" id="add">Add product</button>' : ''}</div>
    <div class="panel table-wrap" id="list"></div></div>`
  const load = async () => {
    const qv = encodeURIComponent($('#pq', view).value.trim())
    const rows = await get(`/products?q=${qv}&limit=500${$('#inactive', view).checked ? '&all=1' : ''}`)
    $('#list', view).innerHTML = rows.length === 0 ? '<p class="muted">No products yet.</p>' : `<table>
      <thead><tr><th>Name</th><th>Generic</th><th>Barcode</th><th class="num">Price</th><th class="num">GST</th><th class="num">Stock</th><th>Next expiry</th></tr></thead>
      <tbody>${rows.map((p) => `<tr class="${editable ? 'clickable' : ''}" data-id="${p.id}">
        <td>${esc(productLabel(p))} ${schedBadge(p.schedule)} ${p.active ? '' : '<span class="muted">(inactive)</span>'}</td>
        <td>${esc(p.generic_name || '')}</td><td>${esc(p.barcode || '')}</td>
        <td class="num">${rs(p.current_price ?? p.sale_price)}</td><td class="num">${pct(p.gst_rate_bps)}</td>
        <td class="num">${p.stock}${p.reorder_level && p.stock <= p.reorder_level ? ' <span class="badge near">Low</span>' : ''}</td>
        <td>${esc(p.next_expiry || '')}</td></tr>`).join('')}</tbody></table>`
  }
  let t
  $('#pq', view).addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => load().catch((e) => toast(e.message, true)), 200) })
  $('#inactive', view).addEventListener('change', guard(load))
  $('#add', view)?.addEventListener('click', () => productForm(null, load))
  $('#list', view).addEventListener('click', guard(async (e) => {
    const tr = e.target.closest('tr[data-id]')
    if (tr && editable) productForm(await get(`/products/${tr.dataset.id}`), load)
  }))
  await load()
}

function productForm(p, onSaved) {
  const v = p || { schedule: 'otc', pack_size: 1, gst_rate_bps: Number(state.settings.default_gst_rate_bps) || 0, reorder_level: 0, sale_price: 0, active: 1 }
  const m = modal(`<form id="pf">
    <h2>${p ? 'Edit product' : 'Add product'}</h2>
    <div class="grid">
      <label class="field">Brand name *<input name="name" value="${esc(v.name)}" required></label>
      <label class="field">Generic name<input name="generic_name" value="${esc(v.generic_name)}"></label>
      <label class="field">Strength<input name="strength" value="${esc(v.strength)}" placeholder="500mg"></label>
      <label class="field">Form<input name="form" value="${esc(v.form)}" placeholder="Tablet" list="forms"></label>
      <label class="field">Manufacturer<input name="manufacturer" value="${esc(v.manufacturer)}"></label>
      <label class="field">Category<input name="category" value="${esc(v.category)}"></label>
      <label class="field">Barcode<input name="barcode" value="${esc(v.barcode)}"></label>
      <label class="field">Units per pack<input name="pack_size" type="number" min="1" value="${v.pack_size}"></label>
      <label class="field">Schedule
        <select name="schedule">
          <option value="otc" ${v.schedule === 'otc' ? 'selected' : ''}>OTC (no prescription)</option>
          <option value="rx" ${v.schedule === 'rx' ? 'selected' : ''}>Prescription only</option>
          <option value="controlled" ${v.schedule === 'controlled' ? 'selected' : ''}>Controlled / narcotic</option>
        </select></label>
      <label class="field">Retail price per unit (Rs, incl. GST) *<input name="sale_price" inputmode="decimal" value="${toRupees(v.sale_price)}" required></label>
      <label class="field">GST %<input name="gst" type="number" min="0" max="100" step="0.01" value="${Number(v.gst_rate_bps) / 100}"></label>
      <label class="field">Reorder level (units)<input name="reorder_level" type="number" min="0" value="${v.reorder_level}"></label>
    </div>
    <datalist id="forms">${['Tablet', 'Capsule', 'Syrup', 'Suspension', 'Injection', 'Drops', 'Cream', 'Ointment', 'Inhaler', 'Sachet', 'Suppository'].map((f) => `<option value="${f}">`).join('')}</datalist>
    <label class="row" style="margin-top:10px"><input type="checkbox" name="active" ${v.active ? 'checked' : ''}> Active (available for sale)</label>
    <p class="muted" style="font-size:13px">Stock is added through Purchases, which records batch numbers and expiry dates.</p>
    <div class="actions"><button type="button" data-close>Cancel</button><button class="primary">Save</button></div>
  </form>`, { wide: true })
  $('#pf', m.el).addEventListener('submit', guard(async (e) => {
    e.preventDefault()
    const d = formData(e.target)
    const body = { ...d, sale_price: toPaisa(d.sale_price), gst_rate_bps: Math.round(Number(d.gst || 0) * 100) }
    delete body.gst
    if (Number.isNaN(body.sale_price)) throw new Error('Enter a valid price')
    if (p) await put(`/products/${p.id}`, body)
    else await post('/products', body)
    m.close()
    toast('Product saved')
    onSaved()
  }))
}

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
    <div class="row"><h1>Purchases</h1><div class="spacer"></div><button class="primary" id="add">Receive stock</button></div>
    <div class="panel table-wrap" id="list"></div></div>`
  const load = async () => {
    const rows = await get('/purchases')
    $('#list', view).innerHTML = rows.length === 0 ? '<p class="muted">No purchases yet. Use “Receive stock” when a delivery arrives.</p>' : `<table>
      <thead><tr><th>#</th><th>Date</th><th>Supplier</th><th>Invoice</th><th class="num">Lines</th><th class="num">Total</th><th>Received by</th></tr></thead>
      <tbody>${rows.map((p) => `<tr class="clickable" data-id="${p.id}"><td>${p.id}</td><td>${esc(p.created_at)}</td><td>${esc(p.supplier_name)}</td>
        <td>${esc(p.invoice_no || '')}</td><td class="num">${p.item_count}</td><td class="num">${rs(p.total)}</td><td>${esc(p.received_by)}</td></tr>`).join('')}</tbody></table>`
  }
  $('#add', view).addEventListener('click', guard(() => purchaseForm(load)))
  $('#list', view).addEventListener('click', guard(async (e) => {
    const tr = e.target.closest('tr[data-id]')
    if (!tr) return
    const p = await get(`/purchases/${tr.dataset.id}`)
    modal(`<h2>Purchase #${p.id} — ${esc(p.supplier_name)}</h2>
      <p class="muted">Invoice ${esc(p.invoice_no || '—')} ${p.invoice_date ? `dated ${esc(p.invoice_date)}` : ''} · received ${esc(p.created_at)} by ${esc(p.received_by)}</p>
      <div class="table-wrap"><table><thead><tr><th>Product</th><th>Batch</th><th>Expiry</th><th class="num">Qty</th><th class="num">Cost</th><th class="num">Total</th></tr></thead>
      <tbody>${p.items.map((i) => `<tr><td>${esc(i.product_name)}</td><td>${esc(i.batch_no)}</td><td>${esc(i.expiry_date)}</td>
        <td class="num">${i.qty}</td><td class="num">${rs(i.cost_price)}</td><td class="num">${rs(i.line_total)}</td></tr>`).join('')}</tbody></table></div>
      <p class="num"><b>${rs(p.total)}</b></p><div class="actions"><button data-close>Close</button></div>`, { wide: true })
  }))
  await load()
}

async function purchaseForm(onSaved) {
  const [suppliers, products] = await Promise.all([get('/suppliers'), get('/products?limit=500')])
  if (!suppliers.length) {
    toast('Add a supplier first', true)
    location.hash = '#/suppliers'
    return
  }
  const optLabel = (p) => `${productLabel(p)} #${p.id}`
  const lineHtml = () => `<tr>
    <td><input name="product" list="plist" placeholder="Type to search" style="width:220px" required></td>
    <td><input name="batch_no" required style="width:100px"></td>
    <td><input name="expiry_date" type="date" required style="width:140px"></td>
    <td><input name="qty" type="number" min="1" required style="width:70px"></td>
    <td><input name="bonus_qty" type="number" min="0" value="0" style="width:60px"></td>
    <td><input name="cost_price" inputmode="decimal" required style="width:80px" placeholder="per unit"></td>
    <td><input name="sale_price" inputmode="decimal" style="width:80px" placeholder="per unit"></td>
    <td><button type="button" class="link danger" data-rm aria-label="Remove line">✕</button></td></tr>`
  const m = modal(`<form id="pf">
    <h2>Receive stock</h2>
    <div class="grid">
      <label class="field">Supplier *<select name="supplier_id">${suppliers.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></label>
      <label class="field">Supplier invoice no<input name="invoice_no"></label>
      <label class="field">Invoice date<input name="invoice_date" type="date" value="${today()}"></label>
    </div>
    <datalist id="plist">${products.map((p) => `<option value="${esc(optLabel(p))}">`).join('')}</datalist>
    <div class="table-wrap" style="margin-top:12px"><table>
      <thead><tr><th>Product</th><th>Batch no</th><th>Expiry</th><th>Qty</th><th>Bonus</th><th>Cost Rs</th><th>MRP Rs</th><th></th></tr></thead>
      <tbody id="lines">${lineHtml()}</tbody></table></div>
    <button type="button" class="link" id="addline">+ Add line</button>
    <p class="muted" style="font-size:13px">Quantities are in units (tablets, bottles…). Leave MRP blank to keep the product's current price. Bonus units are added to stock at no cost.</p>
    <div class="actions"><span class="spacer" id="ptotal"></span><button type="button" data-close>Cancel</button><button class="primary">Save & add to stock</button></div>
  </form>`, { wide: true })
  const tbody = $('#lines', m.el)
  $('#addline', m.el).addEventListener('click', () => {
    tbody.insertAdjacentHTML('beforeend', lineHtml())
    $('tr:last-child input', tbody).focus()
  })
  tbody.addEventListener('click', (e) => {
    if (e.target.closest('[data-rm]') && tbody.children.length > 1) e.target.closest('tr').remove()
  })
  tbody.addEventListener('input', (e) => {
    // Prefill MRP from the chosen product.
    if (e.target.name === 'product') {
      const p = products.find((x) => optLabel(x) === e.target.value)
      const mrp = $('[name=sale_price]', e.target.closest('tr'))
      if (p && !mrp.value) mrp.value = toRupees(p.sale_price)
    }
    const total = $$('tr', tbody).reduce((s, tr) =>
      s + (Number($('[name=qty]', tr).value) || 0) * (toPaisa($('[name=cost_price]', tr).value) || 0), 0)
    $('#ptotal', m.el).textContent = `Invoice total ${rs(total)}`
  })
  $('#pf', m.el).addEventListener('submit', guard(async (e) => {
    e.preventDefault()
    const items = $$('tr', tbody).map((tr, i) => {
      const val = (n) => $(`[name=${n}]`, tr).value.trim()
      const id = Number((val('product').match(/#(\d+)$/) || [])[1])
      if (!id) throw new Error(`Line ${i + 1}: choose a product from the list`)
      return {
        product_id: id, batch_no: val('batch_no'), expiry_date: val('expiry_date'),
        qty: Number(val('qty')), bonus_qty: Number(val('bonus_qty') || 0),
        cost_price: toPaisa(val('cost_price')),
        ...(val('sale_price') ? { sale_price: toPaisa(val('sale_price')) } : {}),
      }
    })
    const d = formData(e.target)
    await post('/purchases', { supplier_id: Number(d.supplier_id), invoice_no: d.invoice_no, invoice_date: d.invoice_date, items })
    m.close()
    toast('Stock received')
    onSaved()
  }))
}

// ---------- suppliers ----------

async function suppliersView(view) {
  view.innerHTML = `<div class="stack">
    <div class="row"><h1>Suppliers</h1><div class="spacer"></div><button class="primary" id="add">Add supplier</button></div>
    <div class="panel table-wrap" id="list"></div></div>`
  let rows = []
  const load = async () => {
    rows = await get('/suppliers')
    $('#list', view).innerHTML = rows.length === 0 ? '<p class="muted">No suppliers yet.</p>' : `<table>
      <thead><tr><th>Name</th><th>Phone</th><th>Address</th><th>NTN</th><th>Drug licence</th></tr></thead>
      <tbody>${rows.map((s) => `<tr class="clickable" data-id="${s.id}"><td>${esc(s.name)}</td><td>${esc(s.phone || '')}</td>
        <td>${esc(s.address || '')}</td><td>${esc(s.ntn || '')}</td><td>${esc(s.drug_license_no || '')}</td></tr>`).join('')}</tbody></table>`
  }
  const form = (s) => {
    const v = s || {}
    const m = modal(`<form id="sf"><h2>${s ? 'Edit' : 'Add'} supplier</h2><div class="grid">
      <label class="field">Name *<input name="name" value="${esc(v.name)}" required></label>
      <label class="field">Phone<input name="phone" value="${esc(v.phone)}"></label>
      <label class="field">Address<input name="address" value="${esc(v.address)}"></label>
      <label class="field">NTN<input name="ntn" value="${esc(v.ntn)}"></label>
      <label class="field">Drug licence no<input name="drug_license_no" value="${esc(v.drug_license_no)}"></label></div>
      <div class="actions"><button type="button" data-close>Cancel</button><button class="primary">Save</button></div></form>`)
    $('#sf', m.el).addEventListener('submit', guard(async (e) => {
      e.preventDefault()
      if (s) await put(`/suppliers/${s.id}`, formData(e.target))
      else await post('/suppliers', formData(e.target))
      m.close()
      await load()
    }))
  }
  $('#add', view).addEventListener('click', () => form(null))
  $('#list', view).addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]')
    if (tr) form(rows.find((s) => s.id === Number(tr.dataset.id)))
  })
  await load()
}

// ---------- reports ----------

async function reportsView(view) {
  const f = { from: today(), to: today(), tab: 'summary' }
  view.innerHTML = `<div class="stack">
    <div class="row"><h1>Reports</h1><div class="spacer"></div>
      <input type="date" id="from" value="${f.from}" aria-label="From"> – <input type="date" id="to" value="${f.to}" aria-label="To">
      <button id="print">Print</button></div>
    <div class="tabs" id="tabs">
      ${[['summary', 'Sales summary'], ['top', 'Top products'], ['low', 'Low stock'], ['expiry', 'Expiry'], ['valuation', 'Stock value'], ['controlled', 'Controlled drug register']]
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
          <td>${esc(r.supplier_name || r.invoice_no || r.note || '')}${r.supplier_invoice ? ` / ${esc(r.supplier_invoice)}` : ''}</td><td>${esc(r.user_name)}</td></tr>`))
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

// ---------- users ----------

async function usersView(view) {
  view.innerHTML = `<div class="stack">
    <div class="row"><h1>Users</h1><div class="spacer"></div><button class="primary" id="add">Add user</button></div>
    <div class="panel table-wrap" id="list"></div>
    <p class="muted" style="font-size:13px">Cashiers: sell, discounts up to 10%, see only their own sales. Pharmacists: also controlled drugs, returns, stock, purchases and reports, discounts up to 25%. Admins: everything including users and settings.</p></div>`
  let rows = []
  const load = async () => {
    rows = await get('/users')
    $('#list', view).innerHTML = `<table><thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Status</th><th>Created</th></tr></thead>
      <tbody>${rows.map((u) => `<tr class="clickable" data-id="${u.id}"><td>${esc(u.full_name)}</td><td>${esc(u.username)}</td><td>${esc(u.role)}</td>
        <td>${u.active ? 'Active' : '<span class="muted">Disabled</span>'}</td><td>${esc(u.created_at)}</td></tr>`).join('')}</tbody></table>`
  }
  const form = (u) => {
    const roleSel = (r) => ['cashier', 'pharmacist', 'admin'].map((x) => `<option ${x === r ? 'selected' : ''}>${x}</option>`).join('')
    const m = modal(`<form id="uf"><h2>${u ? `Edit ${esc(u.username)}` : 'Add user'}</h2><div class="grid">
      ${u ? '' : '<label class="field">Username *<input name="username" required></label>'}
      <label class="field">Full name *<input name="full_name" value="${esc(u?.full_name)}" required></label>
      <label class="field">Role<select name="role">${roleSel(u?.role || 'cashier')}</select></label>
      <label class="field">${u ? 'New password (leave blank to keep)' : 'Password *'}<input name="password" type="password" minlength="8" ${u ? '' : 'required'} autocomplete="new-password"></label>
      </div>
      ${u ? `<label class="row" style="margin-top:10px"><input type="checkbox" name="active" ${u.active ? 'checked' : ''}> Active</label>` : ''}
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
    if (tr) form(rows.find((u) => u.id === Number(tr.dataset.id)))
  })
  await load()
}

// ---------- settings ----------

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
      </div>
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
    delete d.gst
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

boot()
