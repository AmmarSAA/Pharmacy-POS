import crypto from 'node:crypto'
import { jwtSecret } from '../auth.js'

// Seals the owner-saved assistant key with AES-256-GCM, keyed from the app's JWT secret, so a
// copy of the settings table alone does not reveal it. If the JWT secret changes, the saved key
// can no longer be opened and the owner enters it again.
const keyOf = async (db) => crypto.createHash('sha256').update(`pharmacy-assistant:${await jwtSecret(db)}`).digest()

export async function seal(db, plain) {
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', await keyOf(db), iv)
  const data = Buffer.concat([c.update(String(plain), 'utf8'), c.final()])
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), data.toString('base64')].join(':')
}

export async function open(db, sealed) {
  try {
    const [v, iv, tag, data] = String(sealed || '').split(':')
    if (v !== 'v1') return null
    const d = crypto.createDecipheriv('aes-256-gcm', await keyOf(db), Buffer.from(iv, 'base64'))
    d.setAuthTag(Buffer.from(tag, 'base64'))
    return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8')
  } catch {
    return null
  }
}

// "…Ab12": enough to recognise a key without revealing it.
export const hint = (s) => (s && s.length > 10 ? `…${s.slice(-4)}` : '••••')
