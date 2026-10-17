// Copies recorded videos into the app (public/tutorials/<lang>/) with a poster image each, so the
// Help page can play them. Run after record.mjs.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ffmpeg } from './lib.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const dest = path.resolve(here, '../../public/tutorials')
let n = 0
for (const lang of ['en', 'ur']) {
  const dir = path.join(here, 'out', lang)
  if (!fs.existsSync(dir)) continue
  fs.mkdirSync(path.join(dest, lang), { recursive: true })
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.mp4'))) {
    const id = f.replace(/\.mp4$/, '')
    fs.copyFileSync(path.join(dir, f), path.join(dest, lang, f))
    // Poster: the title card, a second into the video.
    execFileSync(ffmpeg(), ['-y', '-hide_banner', '-loglevel', 'error', '-ss', '1.2', '-i', path.join(dir, f), '-frames:v', '1', '-vf', 'scale=640:-1', '-q:v', '4', path.join(dest, lang, `${id}.jpg`)])
    n++
  }
}
console.log(`published ${n} videos to ${path.relative(process.cwd(), dest)}`)
