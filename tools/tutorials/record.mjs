// Records tutorial videos.  node record.mjs [video-id ...] [--lang en,ur] [--port 9100]
// With no ids, records every script in videos/. Output: out/<lang>/<id>.mp4
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { record } from './lib.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args.splice(i, 2)[1] : dflt }
const langs = opt('lang', 'en,ur').split(',')
const port = Number(opt('port', 9100))
const all = fs.readdirSync(path.join(here, 'videos')).filter((f) => f.endsWith('.mjs')).sort()
const pick = args.length ? all.filter((f) => args.some((a) => f.startsWith(a) || f === `${a}.mjs`)) : all
if (!pick.length) { console.error('No matching videos. Available:', all.join(', ')); process.exit(1) }

for (const file of pick) {
  const { default: video } = await import(pathToFileURL(path.join(here, 'videos', file)))
  for (const lang of langs) {
    const started = Date.now()
    try {
      const r = await record(video, lang, { port })
      console.log(`✓ ${lang}/${video.id}.mp4  (${r.seconds}s video, took ${Math.round((Date.now() - started) / 1000)}s)`)
    } catch (e) {
      console.error(`✗ ${lang}/${video.id}: ${e.stack || e.message}`)
      process.exitCode = 1
    }
  }
}
