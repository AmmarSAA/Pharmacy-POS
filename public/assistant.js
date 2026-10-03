// In-app assistant (chat panel). Loaded by app.js.
// mountAssistant(ctx) is called after sign-in; assistantOwnerSection(el, ctx) inside the Owner panel.
// ctx = { state, api, get, post, toast, esc, rs, modal, guard } from app.js.

const LANG_KEY = 'pos.assistant.lang'
const MAX_RECORD_MS = 60000
const store = {
  get(k) {
    try {
      return localStorage.getItem(k)
    } catch {
      return null
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, v)
    } catch {}
  },
}

const TEXT = {
  en: {
    title: 'Assistant', placeholder: 'Ask about stock, sales…', send: 'Send', newChat: 'New chat',
    history: 'Chats', close: 'Close', working: 'Working', approve: 'Approve', decline: 'Decline',
    submit: 'Submit choices', hello: 'Ask me about stock, expiry, sales, suppliers or departments. I can also make changes, and I always ask before I do.',
    noChats: 'No chats yet.', mic: 'Voice note', stop: 'Stop recording', listening: 'Listening… tap again to stop',
    transcribing: 'Turning speech into text…', off: 'The assistant is switched off. The owner can turn it on in the Owner panel.',
    nokey: 'The assistant has no API key yet. The owner can add one in the Owner panel.',
    states: { pending: 'Waiting for you', running: 'Running', done: 'Done', declined: 'Declined', failed: 'Failed' },
    del: 'Delete',
  },
  ur: {
    title: 'معاون', placeholder: 'اسٹاک، سیل، سپلائر کے بارے میں پوچھیں…', send: 'بھیجیں', newChat: 'نئی بات',
    history: 'پچھلی باتیں', close: 'بند کریں', working: 'کام ہو رہا ہے', approve: 'منظور', decline: 'نامنظور',
    submit: 'فیصلے بھیجیں', hello: 'اسٹاک، ایکسپائری، سیل، سپلائرز یا شعبوں کے بارے میں پوچھیں۔ میں تبدیلی بھی کر سکتا ہوں، مگر پہلے آپ سے پوچھوں گا۔',
    noChats: 'ابھی کوئی بات نہیں۔', mic: 'آواز سے لکھیں', stop: 'ریکارڈنگ روکیں', listening: 'سن رہا ہوں… روکنے کے لیے دوبارہ دبائیں',
    transcribing: 'آواز کو تحریر میں بدل رہا ہوں…', off: 'معاون بند ہے۔ مالک اسے Owner پینل سے چالو کر سکتا ہے۔',
    nokey: 'معاون کی API key ابھی نہیں ہے۔ مالک اسے Owner پینل میں شامل کر سکتا ہے۔',
    states: { pending: 'آپ کا انتظار', running: 'جاری', done: 'مکمل', declined: 'نامنظور', failed: 'ناکام' },
    del: 'حذف',
  },
}

let current = null

export async function mountAssistant(ctx) {
  current?.destroy()
  current = null
  let status
  try {
    status = await ctx.get('/assistant/status')
  } catch {
    return
  }
  if (!ctx.state.user) return
  if (!status.enabled && !ctx.state.user.is_owner) return
  current?.destroy()
  current = createPanel(ctx, status)
}

// Escape first, then a small safe subset of markdown: **bold**, `code`, bullet lists, paragraphs.
function richText(esc, text) {
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>')
  const out = []
  let list = null
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trimEnd()
    const item = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/)
    if (item) {
      list ??= []
      list.push(`<li>${inline(item[1])}</li>`)
      continue
    }
    if (list) {
      out.push(`<ul>${list.join('')}</ul>`)
      list = null
    }
    if (line.trim()) out.push(`<p>${inline(line)}</p>`)
  }
  if (list) out.push(`<ul>${list.join('')}</ul>`)
  return out.join('')
}

function createPanel(ctx, status) {
  const { esc, post, api, get } = ctx
  let lang = store.get(LANG_KEY) === 'ur' ? 'ur' : 'en'
  let conv = null
  let mode = 'chat' // 'chat' | 'list'
  let busy = false
  let chosen = {} // approval id -> 'approve' | 'decline' (several cards at once)
  let recorder = null
  let note = ''
  let destroyed = false
  const t = () => TEXT[lang]

  const fab = document.createElement('button')
  fab.className = 'as-fab'
  fab.type = 'button'
  fab.setAttribute('aria-label', 'Open assistant')
  fab.innerHTML = '<span class="as-fab-icon" aria-hidden="true">✦</span><span class="as-fab-label"></span>'

  const panel = document.createElement('section')
  panel.className = 'as-panel'
  panel.hidden = true
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-label', 'Assistant')
  document.body.append(fab, panel)

  const open = () => {
    panel.hidden = false
    fab.hidden = true
    render()
    panel.querySelector('#as-input')?.focus()
  }
  const close = () => {
    panel.hidden = true
    fab.hidden = false
    stopRecording(true)
  }
  fab.addEventListener('click', open)

  const unavailable = () => (!status.switched_on ? t().off : !status.enabled ? t().nokey : '')

  function cardHtml(a) {
    const details = (a.details || [])
      .map((d) => `<tr><th>${esc(d.label ?? d[0] ?? '')}</th><td dir="auto">${esc(d.value ?? d[1] ?? '')}</td></tr>`)
      .join('')
    const pending = a.state === 'pending'
    const pick = chosen[a.id]
    return `<div class="as-card ${esc(a.state)}">
      <div class="as-card-head"><strong dir="auto">${esc(a.label || a.name)}</strong>
        <span class="as-state">${esc(t().states[a.state] || a.state)}</span></div>
      ${details ? `<table>${details}</table>` : ''}
      ${a.error ? `<div class="as-err" dir="auto">${esc(a.error)}</div>` : ''}
      ${pending ? `<div class="as-card-actions">
        <button type="button" class="primary ${pick === 'approve' ? 'sel' : ''}" data-decide="approve" data-id="${esc(a.id)}" ${busy ? 'disabled' : ''}>${t().approve}</button>
        <button type="button" class="${pick === 'decline' ? 'sel' : ''}" data-decide="decline" data-id="${esc(a.id)}" ${busy ? 'disabled' : ''}>${t().decline}</button>
      </div>` : ''}
    </div>`
  }

  function transcriptHtml() {
    const items = conv?.transcript || []
    if (!items.length) return `<p class="as-note" dir="auto">${esc(unavailable() || t().hello)}</p>`
    const html = items.map((m) => {
      if (m.type === 'user') return `<div class="as-msg me" dir="auto">${esc(m.text)}</div>`
      if (m.type === 'assistant') return `<div class="as-msg bot" dir="auto">${richText(esc, m.text)}</div>`
      if (m.type === 'tool') return `<div class="as-tool" dir="auto">🔎 ${esc(m.label || m.name)}</div>`
      if (m.type === 'approval') return cardHtml(m)
      if (m.type === 'error') return `<div class="as-msg err" dir="auto">${esc(m.text || m.message)}</div>`
      return ''
    })
    const pending = (conv.pending || []).length
    if (pending > 1) {
      const ready = conv.pending.every((p) => chosen[p.id])
      html.push(`<div class="as-card-actions"><button type="button" class="primary" data-act="submit" ${ready && !busy ? '' : 'disabled'}>${t().submit}</button></div>`)
    }
    if (busy || conv.status === 'running') html.push(`<div class="as-working">${t().working}<span class="as-dots"><i></i><i></i><i></i></span></div>`)
    return html.join('')
  }

  async function listHtml() {
    const rows = await get('/assistant/conversations')
    if (!rows.length) return `<p class="as-note">${t().noChats}</p>`
    return `<ul class="as-list">${rows.map((c) => `<li>
      <button type="button" class="link" data-open="${c.id}" dir="auto">${esc(c.title)}</button>
      <span class="muted">${esc(String(c.updated_at || '').slice(0, 16).replace('T', ' '))}</span>
      <button type="button" class="link danger" data-del="${c.id}" aria-label="${t().del}">✕</button></li>`).join('')}</ul>`
  }

  async function render() {
    if (panel.hidden) {
      fab.querySelector('.as-fab-label').textContent = t().title
      return
    }
    const off = !!unavailable()
    const awaiting = conv?.status === 'awaiting_approval'
    panel.dir = lang === 'ur' ? 'rtl' : 'ltr'
    panel.lang = lang
    panel.innerHTML = `
      <header class="as-head">
        <strong>${t().title}</strong>
        <div class="as-head-actions">
          <button type="button" class="as-lang" data-lang="${lang === 'ur' ? 'en' : 'ur'}">${lang === 'ur' ? 'EN' : 'اردو'}</button>
          <button type="button" class="as-icon" data-act="list" title="${t().history}" aria-label="${t().history}">☰</button>
          <button type="button" class="as-icon" data-act="new" title="${t().newChat}" aria-label="${t().newChat}">＋</button>
          <button type="button" class="as-icon" data-act="close" title="${t().close}" aria-label="${t().close}">✕</button>
        </div>
      </header>
      <div class="as-body" aria-live="polite">${mode === 'list' ? '<p class="as-note">…</p>' : transcriptHtml()}</div>
      ${note ? `<div class="as-note small" dir="auto">${esc(note)}</div>` : ''}
      <form class="as-compose" id="as-form">
        <textarea id="as-input" rows="1" dir="auto" placeholder="${esc(t().placeholder)}" ${off || awaiting ? 'disabled' : ''}></textarea>
        ${status.voice ? `<button type="button" class="as-icon as-mic ${recorder ? 'rec' : ''}" data-act="mic" title="${recorder ? t().stop : t().mic}" aria-label="${recorder ? t().stop : t().mic}" ${off || awaiting || busy ? 'disabled' : ''}>🎤</button>` : ''}
        <button class="primary" ${off || awaiting || busy ? 'disabled' : ''}>${t().send}</button>
      </form>`
    const body = panel.querySelector('.as-body')
    if (mode === 'list') {
      try {
        body.innerHTML = await listHtml()
      } catch (e) {
        body.innerHTML = `<p class="as-err">${esc(e.message)}</p>`
      }
    } else {
      body.scrollTop = body.scrollHeight
    }
  }

  // The server runs the agent in short slices; keep asking while it says "running".
  async function settle(c) {
    conv = c
    chosen = {}
    while (conv.status === 'running' && !destroyed) {
      render()
      await new Promise((r) => setTimeout(r, conv.retryAfterMs || 150))
      conv = await post(`/assistant/conversations/${conv.id}/step`)
    }
    render()
  }

  async function withBusy(fn) {
    if (busy) return
    busy = true
    render()
    try {
      await fn()
    } catch (e) {
      ctx.toast(e.message, true)
      if (conv?.id) conv = await get(`/assistant/conversations/${conv.id}`).catch(() => conv)
    } finally {
      busy = false
      render()
    }
  }

  function send(text) {
    return withBusy(async () => {
      mode = 'chat'
      const optimistic = { ...(conv || { transcript: [], pending: [] }), status: 'running' }
      optimistic.transcript = [...(optimistic.transcript || []), { type: 'user', text }]
      conv = optimistic
      const c = optimistic.id
        ? await post(`/assistant/conversations/${optimistic.id}/messages`, { text, lang })
        : await post('/assistant/conversations', { text, lang })
      await settle(c)
    })
  }

  function decide(decisions) {
    return withBusy(async () => {
      const c = await post(`/assistant/conversations/${conv.id}/approve`, { decisions })
      await settle(c)
    })
  }

  // Voice notes: record up to a minute, send to the server for transcription, put the text in the box.
  async function startRecording() {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      ctx.toast('Voice notes are not supported in this browser', true)
      return
    }
    let stream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      ctx.toast('Microphone permission was denied', true)
      return
    }
    const chunks = []
    const rec = new MediaRecorder(stream)
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data)
    rec.onstop = async () => {
      stream.getTracks().forEach((tr) => tr.stop())
      clearTimeout(rec.timer)
      if (rec.cancelled) return
      const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' })
      note = t().transcribing
      render()
      try {
        const audio = await blobToBase64(blob)
        const { text } = await post('/assistant/voice', { audio, mime: blob.type, lang })
        note = ''
        render()
        const input = panel.querySelector('#as-input')
        if (input) {
          input.value = text
          input.focus()
        }
      } catch (e) {
        note = ''
        render()
        ctx.toast(e.message, true)
      }
    }
    rec.start()
    rec.timer = setTimeout(() => stopRecording(), MAX_RECORD_MS)
    recorder = rec
    note = t().listening
    render()
  }
  function stopRecording(cancel = false) {
    if (!recorder) return
    recorder.cancelled = cancel
    if (recorder.state !== 'inactive') recorder.stop()
    recorder = null
    note = ''
    if (!cancel) render()
  }

  panel.addEventListener('click', async (e) => {
    const b = e.target.closest('button')
    if (!b) return
    if (b.dataset.lang) {
      lang = b.dataset.lang
      store.set(LANG_KEY, lang)
      return render()
    }
    if (b.dataset.decide) {
      const id = b.dataset.id
      if ((conv?.pending || []).length <= 1) return decide({ [id]: b.dataset.decide === 'approve' })
      chosen[id] = b.dataset.decide
      return render()
    }
    if (b.dataset.open) {
      try {
        conv = await get(`/assistant/conversations/${b.dataset.open}`)
        mode = 'chat'
        if (conv.status === 'running') return withBusy(() => settle(conv))
        render()
      } catch (err) {
        ctx.toast(err.message, true)
      }
      return
    }
    if (b.dataset.del) {
      try {
        await api('DELETE', `/assistant/conversations/${b.dataset.del}`)
        if (conv?.id === Number(b.dataset.del)) conv = null
        render()
      } catch (err) {
        ctx.toast(err.message, true)
      }
      return
    }
    const act = b.dataset.act
    if (act === 'close') close()
    else if (act === 'new') {
      conv = null
      mode = 'chat'
      render()
    } else if (act === 'list') {
      mode = mode === 'list' ? 'chat' : 'list'
      render()
    } else if (act === 'submit') decide(Object.fromEntries(Object.entries(chosen).map(([k, v]) => [k, v === 'approve'])))
    else if (act === 'mic') recorder ? stopRecording() : startRecording()
  })

  panel.addEventListener('submit', (e) => {
    e.preventDefault()
    const input = panel.querySelector('#as-input')
    const text = input.value.trim()
    if (!text || busy) return
    input.value = ''
    send(text)
  })
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      close()
    } else if (e.key === 'Enter' && !e.shiftKey && e.target.id === 'as-input') {
      e.preventDefault()
      panel.querySelector('#as-form').requestSubmit()
    }
  })

  render()
  return {
    destroy() {
      destroyed = true
      stopRecording(true)
      fab.remove()
      panel.remove()
    },
  }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).split(',')[1] || '')
    r.onerror = () => reject(new Error('Could not read the recording'))
    r.readAsDataURL(blob)
  })
}

// Owner panel: on/off switch and the Groq API key.
export async function assistantOwnerSection(el, ctx) {
  const { esc, api, get, toast, guard } = ctx
  el.className = 'panel stack'
  el.innerHTML = '<h2>Assistant</h2><p class="muted">Loading…</p>'
  let s
  try {
    s = await get('/assistant/status')
  } catch (e) {
    el.innerHTML = `<h2>Assistant</h2><p class="muted">${esc(e.message)}</p>`
    return
  }
  const source =
    s.source === 'environment' ? 'Cloudflare secret (GROQ_API_KEY)' : s.saved ? `Saved key ${esc(s.saved.keyHint)}` : 'No key'
  const state = !s.switched_on ? 'Switched off' : s.enabled ? 'On' : 'On, but no key'
  el.innerHTML = `
    <h2>Assistant</h2>
    <p class="muted" style="font-size:13px;margin:0">Staff can ask the assistant about stock, sales and suppliers. Changes it suggests
      always need the user's approval and are recorded in the audit log. Each user sees only their own chats.</p>
    <div class="cards">
      <div class="card"><div class="label">Status</div><div class="value" style="font-size:16px">${state}</div></div>
      <div class="card"><div class="label">Key</div><div class="value" style="font-size:16px">${source}</div></div>
      <div class="card"><div class="label">Voice notes</div><div class="value" style="font-size:16px">${s.voice ? 'Available' : 'Off'}</div></div>
    </div>
    <form class="row" id="as-switch">
      <label class="field">Assistant<select name="assistant_enabled">
        <option value="1" ${s.switched_on ? 'selected' : ''}>On</option><option value="0" ${s.switched_on ? '' : 'selected'}>Off</option></select></label>
      <label class="field" style="flex:1;max-width:260px">Your password<input name="current_password" type="password" required autocomplete="current-password"></label>
      <button class="primary" style="align-self:flex-end">Save</button>
    </form>
    <form class="row" id="as-key">
      <label class="field" style="flex:1;min-width:220px">Groq API key${s.source === 'environment' ? ' (the Cloudflare secret is used while it is set)' : ''}
        <input name="apiKey" type="password" autocomplete="off" placeholder="gsk_…" required></label>
      <label class="field" style="flex:1;max-width:260px">Your password<input name="current_password" type="password" required autocomplete="current-password"></label>
      <button class="primary" style="align-self:flex-end">Save key</button>
      ${s.saved ? '<button type="button" class="link danger" id="as-key-del" style="align-self:flex-end">Remove saved key</button>' : ''}
    </form>`
  const reload = () => {
    mountAssistant(ctx)
    assistantOwnerSection(el, ctx)
  }
  el.querySelector('#as-switch').addEventListener('submit', guard(async (e) => {
    e.preventDefault()
    const f = e.target.elements
    await api('PUT', '/owner/settings', { assistant_enabled: f.assistant_enabled.value, current_password: f.current_password.value })
    toast('Assistant setting saved')
    reload()
  }))
  el.querySelector('#as-key').addEventListener('submit', guard(async (e) => {
    e.preventDefault()
    const f = e.target.elements
    await api('PUT', '/assistant/key', { apiKey: f.apiKey.value.trim(), current_password: f.current_password.value })
    toast('Key checked and saved')
    reload()
  }))
  el.querySelector('#as-key-del')?.addEventListener('click', guard(async () => {
    const pw = el.querySelector('#as-key [name=current_password]').value
    if (!pw) throw new Error('Enter your password first')
    await api('DELETE', '/assistant/key', { current_password: pw })
    toast('Saved key removed')
    reload()
  }))
}
