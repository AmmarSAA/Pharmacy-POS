// Model providers for the assistant. Each keeps the conversation in its own native message format
// (stored as-is, append-only) and exposes the same step() / toolResults() shape to the agent.
import { HttpError } from '../lib/http.js'
import { open } from './secret.js'
import { getSetting } from '../db.js'

const GROQ = 'https://api.groq.com/openai/v1'

// The saved key row: { sealed, hint, updated_at } in the private `assistant_api_key` setting.
export async function savedKey(db) {
  const value = await getSetting(db, 'assistant_api_key')
  if (!value) return null
  try {
    const v = JSON.parse(value)
    return v?.sealed ? v : null
  } catch {
    return null
  }
}

// GROQ_API_KEY (a Worker secret, or env var locally) wins; else the key the owner saved.
export async function resolveKey(db) {
  if (process.env.GROQ_API_KEY) return { key: process.env.GROQ_API_KEY, source: 'environment' }
  const saved = await savedKey(db)
  const key = saved && (await open(db, saved.sealed))
  return key ? { key, source: 'settings' } : { key: null, source: null }
}

// Groq checks tool arguments against the schema and rejects the whole reply when the model sends
// null for an optional field, so optional fields also accept null (the tools ignore nulls).
export function nullableOptional(schema) {
  if (!schema?.properties) return schema
  const required = new Set(schema.required || [])
  const properties = Object.fromEntries(Object.entries(schema.properties).map(([k, p]) => {
    if (required.has(k) || !p.type) return [k, p]
    const types = [...new Set([...(Array.isArray(p.type) ? p.type : [p.type]), 'null'])]
    return [k, { ...p, type: types, ...(p.enum && { enum: [...p.enum, null] }) }]
  }))
  return { ...schema, properties }
}

const busy = (seconds) =>
  Object.assign(new HttpError(429, 'The assistant is busy, retrying shortly'), { retryAfterMs: Math.ceil(seconds * 1000) + 250 })

async function groqFetch(path, init, timeoutMs, what) {
  try {
    return await fetch(GROQ + path, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') throw new HttpError(504, `${what} took too long to answer. Try again.`)
    throw new HttpError(502, `Could not reach ${what}. Check the internet connection and try again.`)
  }
}

// ── Groq (OpenAI-compatible chat completions) ────────────────────────────────
const groq = {
  name: 'groq',
  model: () => process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
  userMessage: (text) => [{ role: 'user', content: text }],

  async step({ system, tools, history, key, timeoutMs = 12000 }) {
    const res = await groqFetch('/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: groq.model(),
        messages: [{ role: 'system', content: system }, ...history],
        tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: nullableOptional(t.input_schema) } })),
        tool_choice: 'auto',
        reasoning_effort: process.env.GROQ_REASONING_EFFORT || 'low',
        max_completion_tokens: 4000,
        temperature: 0.2,
      }),
    }, timeoutMs, 'The assistant')
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      const msg = data?.error?.message || `Groq API error ${res.status}`
      if (res.status === 429) {
        // Groq says how long to wait (header in seconds, or "try again in 6.09s" in the message).
        const header = Number(res.headers.get('retry-after'))
        const inText = Number(/try again in ([\d.]+)s/i.exec(msg)?.[1])
        throw busy(header || inText || 5)
      }
      if (res.status === 401) throw new HttpError(502, 'The assistant key was rejected. The owner can replace it in Owner → Assistant.')
      throw new HttpError(502, `Assistant error: ${msg}`)
    }
    const m = data.choices?.[0]?.message || {}
    const toolCalls = (m.tool_calls || []).map((c) => {
      let input = {}
      let parseError = null
      try {
        input = c.function.arguments ? JSON.parse(c.function.arguments) : {}
      } catch {
        parseError = 'Arguments were not valid JSON'
      }
      return { id: c.id, name: c.function.name, input, parseError }
    })
    // Store only what the API accepts back (drop the provider's private reasoning text).
    const stored = { role: 'assistant', content: m.content || '' }
    if (m.tool_calls?.length) stored.tool_calls = m.tool_calls
    return { append: [stored], text: m.content || '', toolCalls, done: !toolCalls.length, usage: data.usage }
  },

  toolResults: (results) => results.map((r) => ({ role: 'tool', tool_call_id: r.id, content: r.content })),
}

// ── Fake (tests and offline demos): echoes; tests replace PROVIDERS.fake with a scripted one ──
const fake = {
  name: 'fake',
  model: () => 'fake-model',
  userMessage: (text) => [{ role: 'user', content: text }],
  async step({ history }) {
    const last = [...history].reverse().find((m) => m.role === 'user')
    const text = `(test assistant) You said: ${last?.content || ''}`
    return { append: [{ role: 'assistant', content: text }], text, toolCalls: [], done: true }
  },
  toolResults: (results) => results.map((r) => ({ role: 'tool', tool_call_id: r.id, content: r.content })),
}

export const PROVIDERS = { groq, fake }

// AGENT_PROVIDER forces one (tests use 'fake'); otherwise Groq when a key is available.
export async function activeProvider(db) {
  const forced = process.env.AGENT_PROVIDER
  if (forced && PROVIDERS[forced]) return PROVIDERS[forced]
  return (await resolveKey(db)).key ? groq : null
}

// Checks a key with Groq before it is saved (a cheap "list models" call). Tests replace this.
export const keyCheck = {
  async verify(key) {
    const res = await groqFetch('/models', { headers: { Authorization: `Bearer ${key}` } }, 10000, 'Groq')
    if (res.status === 401 || res.status === 403) throw new HttpError(400, 'Groq rejected this key. Check that you copied the whole key.')
    if (!res.ok) throw new HttpError(502, `Groq returned an error (${res.status}). Try again.`)
  },
}

// ── Voice: speech-to-text with Groq Whisper (understands Urdu and English) ────
export const voiceAvailable = async (db) => process.env.AGENT_PROVIDER === 'fake' || !!(await resolveKey(db)).key

const DEVANAGARI = /[ऀ-ॿ]/
async function whisper(key, audio, mime, language) {
  const form = new FormData()
  const ext = mime.includes('mp4') || mime.includes('aac') || mime.includes('m4a') ? 'm4a'
    : mime.includes('ogg') ? 'ogg' : mime.includes('wav') ? 'wav' : mime.includes('mpeg') ? 'mp3' : 'webm'
  form.append('file', new Blob([audio], { type: mime }), `voice.${ext}`)
  form.append('model', process.env.GROQ_WHISPER_MODEL || 'whisper-large-v3')
  form.append('response_format', 'json')
  form.append('temperature', '0')
  // Vocabulary hint: words staff say often.
  form.append('prompt', 'Hospital pharmacy: Panadol, Augmentin, Risek, strip, pack, tablet, syrup, injection, ph5152, supplier, stock, expiry, ward. فارمیسی، دوائی، پتا، گولی، شربت، انجکشن، اسٹاک، ایکسپائری، وارڈ')
  if (language) form.append('language', language)
  const res = await groqFetch('/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form }, 15000, 'Speech recognition')
  const data = await res.json().catch(() => ({}))
  if (res.status === 429) throw new HttpError(429, 'Voice is busy right now. Try again in a few seconds.')
  if (!res.ok) throw new HttpError(502, data?.error?.message || `Speech recognition failed (${res.status})`)
  return String(data.text || '').trim()
}

// lang 'ur' forces Urdu; otherwise the language is detected. Urdu speech is sometimes written
// out in Hindi (Devanagari) script when detected automatically, so that case is redone as Urdu.
export async function transcribe(db, audio, mime, lang) {
  if (process.env.AGENT_PROVIDER === 'fake') return lang === 'ur' ? 'آج کی سیل کتنی ہے؟' : 'What are today\'s sales?'
  const { key } = await resolveKey(db)
  if (!key) throw new HttpError(503, 'Voice input needs a Groq API key')
  let text = await whisper(key, audio, mime, lang === 'ur' ? 'ur' : undefined)
  if (DEVANAGARI.test(text)) text = await whisper(key, audio, mime, 'ur')
  return text
}
