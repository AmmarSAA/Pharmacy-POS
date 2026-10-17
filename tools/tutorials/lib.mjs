// Tutorial recorder: plays a scripted walkthrough of the real app in Chromium, with a visible cursor,
// captions and narration (Microsoft neural voices via edge-tts), and writes an MP4.
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { DEMO_LOGIN, seed } from './seed.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
export const VOICES = { en: 'en-US-AndrewNeural', ur: 'ur-PK-AsadNeural' }
const W = 1280
const H = 720
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const PYTHON = () => process.env.PYTHON || 'python'

export const ffmpeg = () => {
  if (process.env.FFMPEG) return process.env.FFMPEG
  for (const py of [PYTHON(), 'python3', 'python']) {
    try { return execFileSync(py, ['-c', 'import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())']).toString().trim() } catch { /* try next */ }
  }
  return 'ffmpeg'
}

function durationOf(file) {
  let out = ''
  try { execFileSync(ffmpeg(), ['-hide_banner', '-i', file], { stdio: 'pipe' }) } catch (e) { out = String(e.stderr) }
  const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(out)
  return m ? (+m[1] * 3600 + +m[2] * 60 + +m[3]) * 1000 : 0
}

// Narration for every scene, cached by text so re-recording is cheap.
async function narrate(scenes, lang, dir) {
  fs.mkdirSync(dir, { recursive: true })
  const out = []
  for (const [i, s] of scenes.entries()) {
    const text = s[lang]
    if (!text) { out.push(null); continue }
    const key = Buffer.from(VOICES[lang] + text).toString('base64url').slice(-40)
    const mp3 = path.join(dir, `${key}.mp3`)
    if (!fs.existsSync(mp3) || !fs.statSync(mp3).size) {
      const txt = path.join(dir, `${key}.txt`)
      fs.writeFileSync(txt, text)
      for (let attempt = 1; ; attempt++) {
        try { execFileSync(PYTHON(), [path.join(here, 'tts.py'), VOICES[lang], txt, mp3], { stdio: 'pipe' }); break } catch (e) {
          if (attempt >= 4) throw new Error(`TTS failed for scene ${i}: ${e.stderr}`)
          await sleep(1500 * attempt)
        }
      }
    }
    out.push({ file: mp3, ms: durationOf(mp3) })
  }
  return out
}

// Injected into every page: cursor, click ripple, caption bar, title card. State survives navigation.
const OVERLAY = `(() => {
  const st = JSON.parse(sessionStorage.getItem('__tut') || '{"x":640,"y":360}')
  const save = () => sessionStorage.setItem('__tut', JSON.stringify(st))
  const css = \`
    @import url('https://fonts.googleapis.com/css2?family=Noto+Nastaliq+Urdu:wght@400;700&display=swap');
    #tut-cursor{position:fixed;z-index:2147483647;left:0;top:0;width:26px;height:26px;pointer-events:none;transition:transform .55s cubic-bezier(.4,.1,.2,1);filter:drop-shadow(0 2px 3px rgba(0,0,0,.35))}
    .tut-ripple{position:fixed;z-index:2147483646;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;border:3px solid #f59e0b;pointer-events:none;animation:tutr .6s ease-out forwards}
    @keyframes tutr{from{transform:scale(.3);opacity:1}to{transform:scale(1.4);opacity:0}}
    #tut-cap{position:fixed;z-index:2147483645;left:50%;bottom:22px;transform:translateX(-50%);max-width:1040px;padding:10px 22px;border-radius:12px;background:rgba(10,30,28,.88);color:#fff;font:600 21px/1.5 Inter,system-ui,sans-serif;text-align:center;pointer-events:none;box-shadow:0 8px 24px rgba(0,0,0,.25);transition:opacity .25s}
    #tut-cap[dir=rtl]{font-family:'Noto Nastaliq Urdu',system-ui,sans-serif;font-size:22px;line-height:2.1;padding:6px 24px}
    #tut-cap:empty{opacity:0}
    #tut-title{position:fixed;inset:0;z-index:2147483646;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;background:linear-gradient(135deg,#0b2e2a,#0f7b6c);color:#fff;font-family:Inter,system-ui,sans-serif;text-align:center;transition:opacity .5s}
    #tut-title .logo{width:84px;height:84px;border-radius:22px;background:#0b2e2a;display:grid;place-items:center;font-size:44px;color:#9ae6d8;box-shadow:0 10px 30px rgba(0,0,0,.3)}
    #tut-title h1{font-size:46px;margin:6px 0 0;letter-spacing:-.5px}
    #tut-title p{font-size:22px;margin:0;color:#bdf2e6}
    #tut-title[dir=rtl] h1,#tut-title[dir=rtl] p{font-family:'Noto Nastaliq Urdu',system-ui,sans-serif;line-height:2}
    .tut-mark{outline:4px solid #f59e0b !important;outline-offset:3px;border-radius:8px;transition:outline-color .3s}
  \`
  const init = () => {
    if (document.getElementById('tut-cursor')) return
    const s = document.createElement('style'); s.textContent = css; document.head.appendChild(s)
    const c = document.createElement('div'); c.id = 'tut-cursor'
    c.innerHTML = '<svg viewBox="0 0 24 24" width="26" height="26"><path d="M4 2l16 9.5-7 1.6-3.6 6.9z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>'
    c.style.transition = 'none'; c.style.transform = 'translate(' + st.x + 'px,' + st.y + 'px)'
    document.body.appendChild(c); requestAnimationFrame(() => { c.style.transition = '' })
    const cap = document.createElement('div'); cap.id = 'tut-cap'; document.body.appendChild(cap)
    if (st.cap) { cap.textContent = st.cap; cap.dir = st.rtl ? 'rtl' : 'ltr' }
    if (st.title) showTitle(st.title, st.sub, st.rtl)
  }
  function showTitle(t, sub, rtl) {
    let el = document.getElementById('tut-title')
    if (!el) { el = document.createElement('div'); el.id = 'tut-title'; document.body.appendChild(el) }
    el.dir = rtl ? 'rtl' : 'ltr'
    el.innerHTML = '<div class="logo">✚</div><h1></h1><p></p>'
    el.querySelector('h1').textContent = t; el.querySelector('p').textContent = sub || ''
    el.style.opacity = '1'
  }
  window.__tut = {
    move(x, y) { st.x = x; st.y = y; save(); const c = document.getElementById('tut-cursor'); if (c) c.style.transform = 'translate(' + x + 'px,' + y + 'px)' },
    ripple(x, y) { const r = document.createElement('div'); r.className = 'tut-ripple'; r.style.left = x + 'px'; r.style.top = y + 'px'; document.body.appendChild(r); setTimeout(() => r.remove(), 700) },
    caption(t, rtl) { st.cap = t; st.rtl = rtl; save(); const c = document.getElementById('tut-cap'); if (c) { c.textContent = t || ''; c.dir = rtl ? 'rtl' : 'ltr' } },
    title(t, sub, rtl) { st.title = t; st.sub = sub; st.rtl = rtl; save(); showTitle(t, sub, rtl) },
    hideTitle() { st.title = null; save(); const el = document.getElementById('tut-title'); if (el) { el.style.opacity = '0'; setTimeout(() => el.remove(), 500) } },
  }
  if (document.body) init(); else document.addEventListener('DOMContentLoaded', init)
})()`

// ── Helpers handed to each scene (the app's UI is English-only; only the narration changes by lang) ─
function helpers(page, lang, base, ctx) {
  const loc = (target) => (typeof target === 'string' ? page.locator(target).first() : target)
  const h = {
    page, lang, base, ctx,
    button: (name, o = {}) => page.getByRole('button', { name, exact: o.exact ?? false }).first(),
    link: (name) => page.getByRole('link', { name }).first(),
    // Not exact: a label's accessible name can pick up incidental whitespace from how it wraps its
    // control (e.g. "Linked login (optional)" next to an inline <select>), which fails a strict
    // exact match despite being the right field. A trimmed substring match is safe here since every
    // field label in this app is distinct.
    label: (name) => page.getByLabel(name).first(),
    text: (s) => page.getByText(s, { exact: false }).first(),
    nav: (path) => page.locator(`.side a[data-path="${path.replace(/^\/+/, '')}"]`).first(),
    async goto(p) { await page.goto(base + '/#/' + p.replace(/^\/+/, '')); await sleep(500) },
    async pointAt(target, { dwell = 250 } = {}) {
      const el = loc(target)
      await el.waitFor({ state: 'visible', timeout: 15000 })
      await el.scrollIntoViewIfNeeded().catch(() => {})
      const b = await el.boundingBox()
      if (!b) return
      const x = Math.round(b.x + Math.min(b.width / 2, 60)); const y = Math.round(b.y + b.height / 2)
      await page.evaluate(([x, y]) => window.__tut?.move(x, y), [x, y])
      await sleep(600 + dwell)
      return { x, y }
    },
    async click(target, o = {}) {
      const p = await h.pointAt(target)
      if (p) await page.evaluate(([x, y]) => window.__tut?.ripple(x, y), [p.x, p.y])
      await loc(target).click(o)
      await sleep(450)
    },
    async type(target, text, { clear = true } = {}) {
      await h.click(target)
      if (clear) await loc(target).fill('')
      await loc(target).pressSequentially(String(text), { delay: 55 })
      await sleep(250)
    },
    async select(target, value) {
      await h.click(target)
      await loc(target).selectOption(value)
      await sleep(400)
    },
    async mark(target, ms = 1800) {
      const el = loc(target)
      await el.scrollIntoViewIfNeeded().catch(() => {})
      await el.evaluate((e) => e.classList.add('tut-mark')).catch(() => {})
      await h.pointAt(el, { dwell: 0 })
      await sleep(ms)
      await el.evaluate((e) => e.classList.remove('tut-mark')).catch(() => {})
    },
    async scroll(y) { await page.evaluate((y) => window.scrollTo({ top: y, behavior: 'smooth' }), y); await sleep(900) },
    wait: sleep,
  }
  return h
}

// ── Demo server lifecycle ──────────────────────────────────────────────────
export async function startDemo(port) {
  const proc = spawn(process.execPath, [path.join(here, 'server.mjs'), String(port)], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } })
  let log = ''
  proc.stdout.on('data', (d) => { log += d })
  proc.stderr.on('data', (d) => { log += d })
  const base = `http://localhost:${port}`
  for (let i = 0; i < 180; i++) {
    try { if ((await fetch(base + '/api/auth/status')).ok) break } catch { /* not up yet */ }
    if (proc.exitCode !== null) throw new Error('demo server exited:\n' + log)
    await sleep(500)
  }
  const data = await seed(base)
  return { base, data, stop: () => proc.kill('SIGTERM') }
}

// ── Recording ──────────────────────────────────────────────────────────────
export async function record(video, lang, { port = 9100, outDir = path.join(here, 'out') } = {}) {
  const scenes = video.scenes
  const audio = await narrate(scenes, lang, path.join(here, '.cache', lang))
  const demo = await startDemo(port)
  const work = fs.mkdtempSync(path.join(here, '.cache', 'rec-'))
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined })
  try {
    // Sign in outside the recording, then start the recorded context already logged in.
    const pre = await browser.newContext()
    const r = await pre.request.post(demo.base + '/api/auth/login', { data: DEMO_LOGIN })
    if (!r.ok()) throw new Error('demo login failed: ' + (await r.text()))
    const state = await pre.storageState()
    await pre.close()
    const ctx = await browser.newContext({ viewport: { width: W, height: H }, recordVideo: { dir: work, size: { width: W, height: H } }, storageState: video.loggedOut ? { cookies: [] } : state })
    await ctx.addInitScript(OVERLAY)
    const page = await ctx.newPage()
    const t0 = Date.now()
    const h = helpers(page, lang, demo.base, { ...demo.data, video })
    await page.goto(demo.base + '/' + (video.start ? '#/' + video.start.replace(/^\/+/, '') : ''))
    await page.waitForLoadState('networkidle').catch(() => {})
    await page.evaluate(([t, s, rtl]) => window.__tut.title(t, s, rtl), [video.title[lang], video.subtitle?.[lang] || (lang === 'ur' ? 'فارمیسی پی او ایس — تربیتی ویڈیو' : 'Pharmacy POS tutorial'), lang === 'ur'])

    const offsets = []
    for (const [i, s] of scenes.entries()) {
      const a = audio[i]
      offsets.push(a ? { ...a, at: Date.now() - t0 + 150 } : null)
      await page.evaluate(([t, rtl]) => window.__tut.caption(t, rtl), [s.caption?.[lang] ?? s[lang] ?? '', lang === 'ur'])
      try {
        await Promise.all([sleep((a?.ms || 0) + 150), s.run ? s.run(h) : null])
      } catch (err) {
        const shot = path.join(here, '.cache', `fail-${video.id}-${lang}.png`)
        await page.screenshot({ path: shot }).catch(() => {})
        throw new Error(`scene ${i} failed (screenshot: ${shot}): ${err.message}`)
      }
      await sleep(s.gap ?? 400)
      if (i === 0) await page.evaluate(() => window.__tut.hideTitle())
    }
    await page.evaluate(() => window.__tut.caption(''))
    await sleep(800)
    const seconds = Math.round((Date.now() - t0) / 1000)
    const raw = await page.video().path()
    await ctx.close()
    // On Windows the video file's handle can take a moment to actually release after close()
    // resolves; reading it too soon intermittently fails (EBUSY/EPERM).
    await sleep(500)

    fs.mkdirSync(path.join(outDir, lang), { recursive: true })
    const out = path.join(outDir, lang, `${video.id}.mp4`)
    const clips = offsets.filter(Boolean)
    const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', raw, ...clips.flatMap((c) => ['-i', c.file])]
    if (clips.length) {
      const filter = clips.map((c, i) => `[${i + 1}:a]adelay=${c.at}|${c.at}[a${i}]`).join(';') +
        `;${clips.map((_, i) => `[a${i}]`).join('')}amix=inputs=${clips.length}:normalize=0,apad[aout]`
      execFileSync(ffmpeg(), [...args, '-filter_complex', filter, '-map', '0:v', '-map', '[aout]', '-shortest',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-pix_fmt', 'yuv420p', '-r', '25', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', out])
    } else {
      execFileSync(ffmpeg(), [...args, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-pix_fmt', 'yuv420p', '-r', '25', '-an', '-movflags', '+faststart', out])
    }
    return { out, seconds }
  } finally {
    // A crashed renderer can leave browser.close() hanging forever (its IPC never answers), which
    // would otherwise stall the whole batch on one bad recording. Force-kill after a short wait.
    await Promise.race([browser.close().catch(() => {}), sleep(10000)])
    try { browser.process()?.kill('SIGKILL') } catch { /* already gone */ }
    demo.stop()
    // Best-effort: a lingering Windows file lock here must never mask a real error from the try
    // block above (a thrown finally replaces it). A few retries clears the lock almost always;
    // if not, it's an orphaned temp dir, not a failed recording.
    for (let attempt = 1; attempt <= 5; attempt++) {
      try { fs.rmSync(work, { recursive: true, force: true }); break } catch (e) {
        if (attempt === 5) console.error(`(cleanup) could not remove ${work}: ${e.message}`)
        else await sleep(500)
      }
    }
  }
}
