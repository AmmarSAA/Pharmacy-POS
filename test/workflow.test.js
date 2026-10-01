// A pharmacy day end to end, over HTTP only, so it can also run against a deployed or
// `wrangler dev` server: TEST_BASE_URL=http://localhost:8787 (needs an empty database).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db-node.js'
import { createApp } from '../src/app.js'

let server, base, token
before(async () => {
  if (process.env.TEST_BASE_URL) {
    base = `${process.env.TEST_BASE_URL}/api`
    return
  }
  server = createApp(openDb(':memory:')).listen(0)
  await new Promise((r) => server.once('listening', r))
  base = `http://127.0.0.1:${server.address().port}/api`
})
after(() => server?.close())

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json()
  if (res.status >= 400 && !call.expectError) throw new Error(`${method} ${path} -> ${res.status} ${data.message}`)
  return { status: res.status, body: data }
}
const expectStatus = async (status, ...args) => {
  call.expectError = true
  try {
    assert.equal((await call(...args)).status, status)
  } finally {
    call.expectError = false
  }
}
const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10)
const ids = {}

test('owner sets up the pharmacy', async () => {
  await call('POST', '/auth/setup', { username: 'owner', full_name: 'Owner', password: 'secret123' })
  token = (await call('POST', '/auth/login', { username: 'owner', password: 'secret123' })).body.token
})

test('items are imported from a MultiTec-style list', async () => {
  const r = await call('POST', '/products/import', {
    rows: [
      { barcode: 'ph5152', name: 'ITP 50MG', manufacturer: 'Getz', pack_size: 10, category: 'PHARMACY' },
      { barcode: 'ph6277', name: 'MOVAX 2MG TAB', manufacturer: 'Hilton', pack_size: 10, pack_price: 17000 },
      { name: '' },
    ],
  })
  assert.deepEqual([r.body.created, r.body.updated, r.body.errors.length], [2, 0, 1])
  const again = await call('POST', '/products/import', { rows: [{ barcode: 'ph5152', name: 'ITP 50MG TAB', pack_size: 10 }] })
  assert.equal(again.body.updated, 1)
  const list = (await call('GET', '/products?limit=500')).body
  ids.itp = list.find((p) => p.barcode === 'ph5152').id
  ids.movax = list.find((p) => p.barcode === 'ph6277').id
})

test('a supplier with credit terms and an opening balance', async () => {
  ids.sup = (await call('POST', '/suppliers', {
    name: 'Premier', due_days: 15, opening_balance: 1000000, opening_date: daysAgo(40),
  })).body.id
})

test('credit purchase in packs sets prices by the 15% margin', async () => {
  const p = (await call('POST', '/purchases', {
    supplier_id: ids.sup, invoice_no: 'PR-1', invoice_date: daysAgo(20), payment_type: 'credit',
    items: [
      { product_id: ids.itp, batch_no: 'B1', expiry_date: '2029-12-31', packs: 6, pack_cost: 19125 },
      { product_id: ids.movax, batch_no: 'M1', expiry_date: '2029-12-31', packs: 2, pack_cost: 14450 },
    ],
  })).body
  assert.equal(p.total, 6 * 19125 + 2 * 14450)
  assert.equal(p.due_date, daysAgo(5))
  const itp = (await call('GET', `/products/${ids.itp}`)).body
  assert.equal(itp.pack_price, 22500) // 191.25 / 0.85
  assert.equal(itp.stock, 60)
  const movax = (await call('GET', `/products/${ids.movax}`)).body
  assert.equal(movax.pack_price, 17000) // kept the imported price
})

test('selling needs an open till; packs and loose are priced exactly', async () => {
  await expectStatus(409, 'POST', '/sales', { items: [{ product_id: ids.itp, packs: 1 }] })
  await call('POST', '/tills/open', { notes: { 1000: 5 } })
  const sale = (await call('POST', '/sales', {
    items: [{ product_id: ids.itp, packs: 2, loose: 3 }], payment_method: 'cash', amount_paid: 60000,
  })).body
  assert.equal(sale.subtotal, 45000 + Math.round((3 * 22500) / 10))
  assert.equal(sale.total, 51800) // 517.50 rounded to the rupee
})

test('supplier paid from the till; ledger and dues agree', async () => {
  await call('POST', `/suppliers/${ids.sup}/payments`, { amount: 500000, method: 'bank', reference: 'CHQ-9' })
  await call('POST', `/suppliers/${ids.sup}/payments`, { amount: 10000, method: 'till' })
  const ledger = (await call('GET', `/suppliers/${ids.sup}/ledger`)).body
  const billed = 1000000 + 6 * 19125 + 2 * 14450
  assert.equal(ledger.balance, billed - 510000)
  assert.equal(ledger.entries.at(-1).balance, ledger.balance)
  const dues = (await call('GET', '/reports/supplier-dues')).body.find((d) => d.supplier_id === ids.sup)
  assert.equal(dues.balance, ledger.balance)
  assert.ok(dues.overdue > 0)
})

test('till closes with the expected cash, then the day closes', async () => {
  const cur = (await call('GET', '/tills/current')).body
  assert.equal(cur.totals.expected_cash, 500000 + 51800 - 10000)
  await expectStatus(409, 'POST', '/tills/day-close', {})
  const closed = (await call('POST', '/tills/current/close', { counted_cash: 541800 })).body
  assert.equal(closed.variance, 0)
  const day = (await call('POST', '/tills/day-close', {})).body.day_close
  assert.ok(day.summary)
  await expectStatus(409, 'POST', '/tills/day-close', {})
})

test('a ward requests stock, the pharmacy issues it at cost, the ward returns some', async () => {
  const ward = (await call('POST', '/departments', { name: 'Emergency', incharge: 'Dr. Ali' })).body
  const req = (await call('POST', '/issue-requests', {
    department_id: ward.id, requested_by: 'Nurse Sara', items: [{ product_id: ids.itp, packs: 2 }],
  })).body
  const issue = (await call('POST', '/issues', {
    department_id: ward.id, request_id: req.id, received_by: 'Nurse Sara', items: [{ product_id: ids.itp, packs: 2 }],
  })).body
  assert.match(issue.issue_no, /^ISS-\d{6}$/)
  assert.equal(issue.total_cost, 20 * 1913) // cost per tablet: 191.25 / 10, rounded
  assert.equal((await call('GET', `/issue-requests/${req.id}`)).body.status, 'closed')
  const back = (await call('POST', `/issues/${issue.id}/returns`, {
    items: [{ issue_item_id: issue.items[0].id, qty: 5 }], reason: 'not used',
  })).body
  assert.equal(back.items[0].returned_qty, 5)
  const usage = (await call('GET', '/reports/department-usage')).body.find((d) => d.department_id === ward.id)
  assert.equal(usage.net_cost, 15 * 1913)
})

test('owner policies need the owner password', async () => {
  await expectStatus(403, 'PUT', '/settings', { require_open_till: '0' })
  await expectStatus(403, 'PUT', '/owner/settings', { require_open_till: '0', current_password: 'nope' })
  const s = (await call('PUT', '/owner/settings', { require_open_till: '0', current_password: 'secret123' })).body
  assert.equal(s.require_open_till, '0')
  const log = (await call('GET', '/owner/audit')).body
  assert.equal(log[0].action, 'settings.update')
})
