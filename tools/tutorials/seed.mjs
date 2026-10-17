// Fills a fresh demo server with a realistic pharmacy: staff, suppliers, products with stock,
// customers, a department & dispensed issue, a purchase order, a stock transfer, employees,
// an appointment, messages, a knowledge article and a few POS sales — so tutorial screens are
// never empty. Returns the admin's token and the created records.
const OWNER = { username: 'owner', password: 'Demo12345!' }
export const DEMO_LOGIN = OWNER

const inDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10) }

export async function seed(base) {
  const call = async (method, url, body, token) => {
    const res = await fetch(base + '/api' + url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const data = await res.json().catch(() => null)
    if (!res.ok) throw new Error(`${method} ${url}: ${res.status} ${JSON.stringify(data)}`)
    return data
  }

  await call('POST', '/auth/setup', {
    username: OWNER.username, full_name: 'Ayesha Khan', password: OWNER.password, pharmacy_name: 'City Care Pharmacy',
  })
  // /auth/setup only sets a cookie; get a bearer token the same way the app's offline sync does.
  const { user, token } = await call('POST', '/auth/login', OWNER)
  const api = (m, u, b) => call(m, u, b, token)

  const pharmacist = await api('POST', '/users', { username: 'hassan', full_name: 'Hassan Raza', password: 'Demo12345!', role: 'pharmacist' })
  const cashier = await api('POST', '/users', { username: 'sara', full_name: 'Sara Malik', password: 'Demo12345!', role: 'cashier' })

  // ── Suppliers & products with stock ────────────────────────────────────
  const supplier1 = await api('POST', '/suppliers', { name: 'City Pharma Distributors', phone: '042-35112233', address: 'Lahore', due_days: 30, contact_person: 'Imran Shah' })
  const supplier2 = await api('POST', '/suppliers', { name: 'MediCore Pakistan', phone: '021-34556677', address: 'Karachi', due_days: 15, contact_person: 'Bilal Ahmed' })

  // name, generic, barcode, form, strength, pack size, schedule, pack price (paisa), pack cost (paisa), reorder
  const CATALOGUE = [
    ['Panadol', 'Paracetamol', '8964000100011', 'Tablet', '500mg', 10, 'otc', 2500, 1900, 100],
    ['Panadol Extra', 'Paracetamol + Caffeine', '8964000100028', 'Tablet', '500mg/65mg', 10, 'otc', 4200, 3300, 50],
    ['Brufen', 'Ibuprofen', '8964000100035', 'Tablet', '400mg', 10, 'otc', 6000, 4700, 50],
    ['Augmentin', 'Amoxicillin + Clavulanate', '8964000100066', 'Tablet', '625mg', 6, 'rx', 31200, 25800, 20],
    ['Risek', 'Omeprazole', '8964000100097', 'Capsule', '20mg', 14, 'rx', 20300, 16100, 30],
    ['Glucophage', 'Metformin', '8964000100080', 'Tablet', '500mg', 10, 'rx', 5500, 4400, 30],
    ['Tramal', 'Tramadol', '8964000100110', 'Capsule', '50mg', 10, 'controlled', 9000, 7200, 10],
    ['ORS Sachet', 'Oral rehydration salts', '8964000100059', 'Sachet', '20.5g', 1, 'otc', 3500, 2800, 30],
  ]
  const products = []
  for (const [name, generic, barcode, form, strength, pack_size, schedule, pack_price, pack_cost, reorder_level] of CATALOGUE) {
    const p = await api('POST', '/products', { name, generic_name: generic, barcode, form, strength, pack_size, schedule, pack_price, reorder_level, allow_loose: 1 })
    products.push({ ...p, pack_cost })
  }
  // Two batches each (soon + later expiry) via a credit purchase from supplier1, to show FEFO and expiry.
  const purchase1 = await api('POST', '/purchases', {
    supplier_id: supplier1.id, invoice_no: 'CPD-1001', payment_type: 'credit',
    items: products.map((p, i) => ({ product_id: p.id, packs: 20, pack_cost: p.pack_cost, batch_no: `B${1000 + i}A`, expiry_date: inDays(240 + (i % 3) * 30) })),
  })
  await api('POST', '/purchases', {
    supplier_id: supplier1.id, invoice_no: 'CPD-1002', payment_type: 'credit',
    items: products.slice(0, 4).map((p, i) => ({ product_id: p.id, packs: 5, pack_cost: p.pack_cost, batch_no: `B${1000 + i}X`, expiry_date: inDays(20 + i * 5) })),
  })
  await call('POST', `/suppliers/${supplier1.id}/payments`, { amount: 5000000, method: 'bank', reference: 'HBL-00231' }, token)

  // An open purchase order so the Purchase Orders screen isn't empty.
  const po = await api('POST', '/purchase-orders', {
    supplier_id: supplier2.id, expected_date: inDays(5), notes: 'Monthly restock',
    items: [
      { product_id: products[2].id, packs: 15, pack_cost: products[2].pack_cost },
      { product_id: products[4].id, packs: 10, pack_cost: products[4].pack_cost },
    ],
  })
  await api('POST', `/purchase-orders/${po.id}/status`, { status: 'sent' })

  // ── Customers (accounts & loyalty) ─────────────────────────────────────
  const customer1 = await api('POST', '/customers', { name: 'Shaukat Clinic', phone: '0300-1112233', due_days: 15 })
  const customer2 = await api('POST', '/customers', { name: 'Imran Yousaf', phone: '0333-4455667' })

  // ── Departments & a dispensed issue ────────────────────────────────────
  const ward = await api('POST', '/departments', { name: 'Emergency Ward', incharge: 'Dr. Nadia Farooq' })
  const request = await api('POST', '/issue-requests', { department_id: ward.id, requested_by: 'Dr. Nadia Farooq', items: [{ product_id: products[0].id, packs: 3 }, { product_id: products[2].id, packs: 2 }] })
  await api('POST', '/issues', { department_id: ward.id, request_id: request.id, received_by: 'Staff Nurse Bano', items: [{ product_id: products[0].id, packs: 3 }, { product_id: products[2].id, packs: 2 }] })

  // ── A location & stock transfer ────────────────────────────────────────
  const branch = await call('POST', '/transfers/locations', { name: 'Johar Town Branch', address: 'Lahore' }, token)
  const transfer = await call('POST', '/transfers', { to_location_id: branch.id, notes: 'Weekly top-up', items: [{ product_id: products[1].id, qty: 20 }] }, token)

  // ── Employees, an appointment, messages, a knowledge article ──────────
  const employee1 = await api('POST', '/employees', { full_name: 'Hassan Raza', user_id: pharmacist.id, job_title: 'Pharmacist', phone: '0301-2223344', hire_date: inDays(-400), salary: 6500000 })
  const employee2 = await api('POST', '/employees', { full_name: 'Sara Malik', user_id: cashier.id, job_title: 'Cashier', phone: '0302-3334455', hire_date: inDays(-120), salary: 3500000 })

  const pad = (n) => String(n).padStart(2, '0')
  const stamp = (daysFromNow, hour) => { const d = new Date(); d.setDate(d.getDate() + daysFromNow); return `${d.toISOString().slice(0, 10)} ${pad(hour)}:00:00` }
  await call('POST', '/appointments', { title: 'Stock audit with supplier', kind: 'other', starts_at: stamp(1, 11), ends_at: stamp(1, 12), with_user_id: user.id, notes: 'Bring last month\'s invoices' }, token)

  await call('POST', '/messages', { to_user_id: pharmacist.id, body: 'Please double check the Tramal batch before tonight\'s close.' }, token)
  const { token: pharmacistToken } = await call('POST', '/auth/login', { username: 'hassan', password: 'Demo12345!' })
  await call('POST', '/messages', { to_user_id: user.id, body: 'Noted, will do it after the evening rush.' }, pharmacistToken)

  await call('POST', '/knowledge', { title: 'Controlled drug dispensing checklist', body: '1. Check the prescription has a PMDC number.\n2. Record the patient CNIC.\n3. Log it in the controlled register.\n4. Get a pharmacist to co-sign.', tags: ['controlled', 'compliance'] }, token)

  // ── A few POS sales, so Sales, Reports and the Dashboard are not empty ─
  await call('POST', '/tills/open', { opening_cash: 500000 }, token)
  await call('POST', '/sales', { items: [{ product_id: products[0].id, packs: 2 }], payment_method: 'cash' }, token)
  await call('POST', '/sales', { items: [{ product_id: products[1].id, packs: 1 }, { product_id: products[7].id, loose: 2 }], payment_method: 'cash' }, token)
  await call('POST', '/sales', { items: [{ product_id: products[4].id, packs: 1 }], payment_method: 'account', customer_id: customer1.id,
    prescription: { patient_name: 'Shaukat Clinic patient', prescriber_name: 'Dr. Nadia Farooq' } }, token)
  // Close the seeding till so the recorded session starts with no till open — the "making a sale"
  // video opens one live, instead of finding it already open. The exact counted cash doesn't matter
  // (no video looks at this session's history), so just count the opening float.
  await call('POST', '/tills/current/close', { counted_cash: 500000 }, token)

  return { token, admin: user, pharmacist, cashier, suppliers: [supplier1, supplier2], products, customers: [customer1, customer2], department: ward, location: branch, purchaseOrder: po, transfer, employees: [employee1, employee2] }
}
