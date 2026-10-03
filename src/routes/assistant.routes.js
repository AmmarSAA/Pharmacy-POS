import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { getSettings } from '../db.js'
import { HttpError, notFound } from '../lib/http.js'
import { audit } from '../lib/audit.js'
import { requireOwner } from './owner.routes.js'
import {
  continueConversation, decide, deleteConversation, listConversations, loadConversation, sendMessage,
  startConversation, view,
} from '../assistant/agent.js'
import { activeProvider, keyCheck, resolveKey, savedKey, transcribe, voiceAvailable } from '../assistant/providers.js'
import { hint, seal } from '../assistant/secret.js'

// In-app assistant. See docs/API-CONTRACT.md (Round 3).
const text = (req) => {
  const t = String(req.body?.text || '').trim()
  if (!t) throw new HttpError(400, 'Type a message')
  if (t.length > 4000) throw new HttpError(400, 'Message is too long')
  return t
}
const lang = (req) => (req.body?.lang === 'ur' ? 'ur' : 'en')

function confirmPassword(db, userId, password) {
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId)
  if (!password || !bcrypt.compareSync(String(password), row.password_hash)) {
    throw new HttpError(403, 'Password is incorrect')
  }
}

export default function assistantRoutes(db) {
  const r = Router()

  const enabled = () => getSettings(db).assistant_enabled !== '0'
  // Conversation routes need the owner's switch on; the engine itself reports a missing key.
  const requireOn = (req, res, next) => {
    if (!enabled()) return next(new HttpError(503, 'The assistant is switched off. The owner can turn it on in the Owner panel.'))
    next()
  }
  const own = (req) => {
    const c = loadConversation(db, req.params.id, req.user.id)
    if (!c) throw notFound('Conversation')
    return c
  }
  // Async handlers: Express 4 doesn't catch rejected promises on its own.
  const run = (fn, status = 200) => async (req, res, next) => {
    try {
      res.status(status).json(view(await fn(req)))
    } catch (err) {
      next(err)
    }
  }

  r.get('/status', (req, res) => {
    const p = activeProvider(db)
    const on = enabled()
    const body = {
      enabled: on && !!p,
      switched_on: on,
      provider: p?.name || null,
      model: p?.model() || null,
      source: resolveKey(db).source,
      voice: on && !!p && voiceAvailable(db),
    }
    if (req.user.is_owner) {
      const saved = savedKey(db)
      body.saved = saved ? { keyHint: saved.hint, updatedAt: saved.updated_at } : null
    }
    res.json(body)
  })

  // Owner: save the Groq key (checked with Groq first, stored sealed). The GROQ_API_KEY secret,
  // when set, still takes precedence.
  r.put('/key', requireOwner, async (req, res, next) => {
    try {
      confirmPassword(db, req.user.id, req.body?.current_password)
      const key = String(req.body?.apiKey || '').trim()
      if (key.length < 20 || /\s/.test(key)) throw new HttpError(400, 'Paste the full API key')
      if (!key.startsWith('gsk_')) throw new HttpError(400, 'A Groq key starts with gsk_')
      await keyCheck.verify(key)
      const value = JSON.stringify({ sealed: seal(db, key), hint: hint(key), updated_at: new Date().toISOString() })
      db.prepare(
        "INSERT INTO settings (key, value) VALUES ('assistant_api_key', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(value)
      audit(db, req.user.id, 'assistant.key', { saved: hint(key) })
      res.json({ ok: true, saved: { keyHint: hint(key) }, source: resolveKey(db).source })
    } catch (err) {
      next(err)
    }
  })

  r.delete('/key', requireOwner, (req, res) => {
    confirmPassword(db, req.user.id, req.body?.current_password)
    db.prepare("DELETE FROM settings WHERE key = 'assistant_api_key'").run()
    audit(db, req.user.id, 'assistant.key', { removed: true })
    res.json({ ok: true, source: resolveKey(db).source })
  })

  r.get('/conversations', (req, res) => res.json(listConversations(db, req.user.id)))
  r.get('/conversations/:id', (req, res) => res.json(view(own(req))))
  r.post('/conversations', requireOn, run((req) => startConversation(db, req.app, req.user, text(req), lang(req)), 201))
  r.post('/conversations/:id/messages', requireOn, run((req) => sendMessage(db, req.app, own(req), req.user, text(req), lang(req))))
  r.post('/conversations/:id/step', requireOn, run((req) => continueConversation(db, req.app, own(req), req.user)))
  r.post('/conversations/:id/approve', requireOn, run((req) => decide(db, req.app, own(req), req.user, req.body?.decisions || {})))
  r.delete('/conversations/:id', (req, res) => {
    deleteConversation(db, own(req))
    res.json({ ok: true })
  })

  // Voice note -> text. The browser records up to ~60 s and sends it base64-encoded.
  const AUDIO = /^audio\/(webm|ogg|mp4|mpeg|wav|x-m4a|aac)(;.*)?$/
  r.post('/voice', requireOn, async (req, res, next) => {
    try {
      const mime = String(req.body?.mime || '')
      if (!AUDIO.test(mime)) throw new HttpError(400, 'Unsupported audio format')
      const audio = Buffer.from(String(req.body?.audio || ''), 'base64')
      if (audio.length < 1000) throw new HttpError(400, 'The recording was too short. Hold the button and speak.')
      if (audio.length > 1.9 * 1024 * 1024) throw new HttpError(400, 'The recording is too long. Keep it under a minute.')
      const out = await transcribe(db, audio, mime.split(';')[0], req.body?.lang === 'ur' ? 'ur' : 'auto')
      if (!out) throw new HttpError(400, 'No speech was recognised. Please try again.')
      res.json({ text: out })
    } catch (err) {
      next(err)
    }
  })

  return r
}
