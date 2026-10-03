import { Router } from '../lib/router.js'
import bcrypt from 'bcryptjs'
import { getSettings, setSetting } from '../db.js'
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

async function confirmPassword(db, userId, password) {
  const row = await db.get('users', userId)
  if (!password || !bcrypt.compareSync(String(password), row.password_hash)) {
    throw new HttpError(403, 'Password is incorrect')
  }
}

export default function assistantRoutes(db) {
  const r = Router()

  const enabled = async () => (await getSettings(db)).assistant_enabled !== '0'
  // Conversation routes need the owner's switch on; the engine itself reports a missing key.
  const requireOn = async (req, res, next) => {
    if (!(await enabled())) return next(new HttpError(503, 'The assistant is switched off. The owner can turn it on in the Owner panel.'))
    next()
  }
  const own = async (req) => {
    const c = await loadConversation(db, req.params.id, req.user.id)
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

  r.get('/status', async (req, res) => {
    const p = await activeProvider(db)
    const on = await enabled()
    const body = {
      enabled: on && !!p,
      switched_on: on,
      provider: p?.name || null,
      model: p?.model() || null,
      source: (await resolveKey(db)).source,
      voice: on && !!p && (await voiceAvailable(db)),
    }
    if (req.user.is_owner) {
      const saved = await savedKey(db)
      body.saved = saved ? { keyHint: saved.hint, updatedAt: saved.updated_at } : null
    }
    res.json(body)
  })

  // Owner: save the Groq key (checked with Groq first, stored sealed). The GROQ_API_KEY secret,
  // when set, still takes precedence.
  r.put('/key', requireOwner, async (req, res, next) => {
    try {
      await confirmPassword(db, req.user.id, req.body?.current_password)
      const key = String(req.body?.apiKey || '').trim()
      if (key.length < 20 || /\s/.test(key)) throw new HttpError(400, 'Paste the full API key')
      if (!key.startsWith('gsk_')) throw new HttpError(400, 'A Groq key starts with gsk_')
      await keyCheck.verify(key)
      const value = JSON.stringify({ sealed: await seal(db, key), hint: hint(key), updated_at: new Date().toISOString() })
      await setSetting(db, 'assistant_api_key', value)
      await audit(db, req.user.id, 'assistant.key', { saved: hint(key) })
      res.json({ ok: true, saved: { keyHint: hint(key) }, source: (await resolveKey(db)).source })
    } catch (err) {
      next(err)
    }
  })

  r.delete('/key', requireOwner, async (req, res) => {
    await confirmPassword(db, req.user.id, req.body?.current_password)
    await db.col('settings').deleteOne({ _id: 'assistant_api_key' })
    await audit(db, req.user.id, 'assistant.key', { removed: true })
    res.json({ ok: true, source: (await resolveKey(db)).source })
  })

  r.get('/conversations', async (req, res) => res.json(await listConversations(db, req.user.id)))
  r.get('/conversations/:id', async (req, res) => res.json(view(await own(req))))
  r.post('/conversations', requireOn, run((req) => startConversation(db, req.app, req.user, text(req), lang(req)), 201))
  r.post('/conversations/:id/messages', requireOn, run(async (req) => sendMessage(db, req.app, await own(req), req.user, text(req), lang(req))))
  r.post('/conversations/:id/step', requireOn, run(async (req) => continueConversation(db, req.app, await own(req), req.user)))
  r.post('/conversations/:id/approve', requireOn, run(async (req) => decide(db, req.app, await own(req), req.user, req.body?.decisions || {})))
  r.delete('/conversations/:id', async (req, res) => {
    await deleteConversation(db, await own(req))
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
