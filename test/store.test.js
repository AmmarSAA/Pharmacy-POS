import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { testStore, stopTestStore, put } from './helpers/mongo.js'
import { initDb, getSettings } from '../src/db.js'

after(stopTestStore)

test('setup is safe to repeat and keeps existing settings', async () => {
  const db = await testStore()
  await db.col('settings').updateOne({ _id: 'pharmacy_name' }, { $set: { value: 'Federal Hospital Pharmacy' } })
  await initDb(db)
  const s = await getSettings(db)
  assert.equal(s.pharmacy_name, 'Federal Hospital Pharmacy')
  assert.equal(s.require_open_till, '1')
})

test('the first active admin becomes the owner when none is marked', async () => {
  const db = await testStore()
  await put(db, 'users', { username: 'a', username_lc: 'a', full_name: 'A', password_hash: 'x', role: 'admin', active: 1 })
  await put(db, 'users', { username: 'b', username_lc: 'b', full_name: 'B', password_hash: 'x', role: 'admin', active: 1 })
  await initDb(db)
  assert.deepEqual((await db.all('users', { is_owner: 1 })).map((u) => u.username), ['a'])
})

test('the database refuses duplicates the app relies on', async () => {
  const db = await testStore()
  await put(db, 'users', { username: 'Ali', username_lc: 'ali', full_name: 'A', password_hash: 'x', role: 'cashier', active: 1 })
  await assert.rejects(put(db, 'users', { username: 'ALI', username_lc: 'ali', full_name: 'B', password_hash: 'x', role: 'cashier', active: 1 }), { code: 11000 })
  await put(db, 'till_sessions', { user_id: 1, status: 'open' })
  await assert.rejects(put(db, 'till_sessions', { user_id: 1, status: 'open' }), { code: 11000 }, 'one open till per user')
  await put(db, 'till_sessions', { user_id: 1, status: 'closed' })
  await put(db, 'products', { name: 'X', barcode: 'ph1' })
  await assert.rejects(put(db, 'products', { name: 'Y', barcode: 'ph1' }), { code: 11000 })
  await put(db, 'products', { name: 'Z', barcode: null })
  await put(db, 'products', { name: 'W', barcode: null }) // many items without a code are fine
})

test('a failed transaction leaves nothing behind', async () => {
  const db = await testStore()
  await assert.rejects(db.tx(async () => {
    await put(db, 'sales', { invoice_no: 'INV-1', total: 100 })
    throw new Error('stop')
  }), /stop/)
  assert.equal(await db.col('sales').countDocuments(), 0)
})
