import { Router } from 'express'
import { requireRole } from '../auth.js'
import { notFound, reqString, optString } from '../lib/http.js'

const read = (b) => ({
  name: reqString(b, 'name', 'Name'),
  phone: optString(b, 'phone'),
  address: optString(b, 'address'),
  ntn: optString(b, 'ntn'),
  drug_license_no: optString(b, 'drug_license_no'),
})

export default function supplierRoutes(db) {
  const r = Router()
  r.use(requireRole('admin', 'pharmacist'))

  r.get('/', (req, res) => {
    res.json(db.prepare('SELECT * FROM suppliers ORDER BY name').all())
  })

  r.post('/', (req, res) => {
    const { lastInsertRowid } = db
      .prepare('INSERT INTO suppliers (name, phone, address, ntn, drug_license_no) VALUES (:name, :phone, :address, :ntn, :drug_license_no)')
      .run(read(req.body))
    res.status(201).json(db.prepare('SELECT * FROM suppliers WHERE id = ?').get(lastInsertRowid))
  })

  r.put('/:id', (req, res) => {
    const id = Number(req.params.id)
    if (!db.prepare('SELECT 1 FROM suppliers WHERE id = ?').get(id)) throw notFound('Supplier')
    db.prepare('UPDATE suppliers SET name = :name, phone = :phone, address = :address, ntn = :ntn, drug_license_no = :drug_license_no WHERE id = :id')
      .run({ ...read(req.body), id })
    res.json(db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id))
  })

  return r
}
