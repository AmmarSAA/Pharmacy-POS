// Supervisor check: confirms every recorded tutorial MP4 actually has a video stream AND an audio
// stream (genuinely muxed, not a silent clip or a bare screen recording), with a sane duration.
// Usage: node verify.mjs [out-dir]   (default: ./out)
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ffmpeg } from './lib.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.resolve(here, process.argv[2] || 'out')
const MIN_SECONDS = 15
const MAX_SECONDS = 420

function probe(file) {
  let out = ''
  try { execFileSync(ffmpeg(), ['-hide_banner', '-i', file], { stdio: 'pipe' }) } catch (e) { out = String(e.stderr) }
  const duration = /Duration: (\d+):(\d+):([\d.]+)/.exec(out)
  const seconds = duration ? (+duration[1] * 3600 + +duration[2] * 60 + +duration[3]) : 0
  const hasVideo = /Stream #0:\d+.*: Video:/.test(out)
  const hasAudio = /Stream #0:\d+.*: Audio:/.test(out)
  return { seconds, hasVideo, hasAudio, raw: out }
}

let total = 0
let failed = 0
for (const lang of ['en', 'ur']) {
  const dir = path.join(outDir, lang)
  if (!fs.existsSync(dir)) continue
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.mp4')).sort()) {
    total++
    const file = path.join(dir, f)
    const size = fs.statSync(file).size
    const { seconds, hasVideo, hasAudio, raw } = probe(file)
    const problems = []
    if (size < 100 * 1024) problems.push(`file is only ${Math.round(size / 1024)}KB`)
    if (!hasVideo) problems.push('no video stream')
    if (!hasAudio) problems.push('no audio stream (narration missing or not muxed in)')
    if (seconds < MIN_SECONDS) problems.push(`duration ${seconds.toFixed(1)}s is suspiciously short`)
    if (seconds > MAX_SECONDS) problems.push(`duration ${seconds.toFixed(1)}s is suspiciously long`)
    if (problems.length) {
      failed++
      console.log(`✗ ${lang}/${f}: ${problems.join('; ')}`)
    } else {
      console.log(`✓ ${lang}/${f}  (${seconds.toFixed(1)}s, ${(size / 1024 / 1024).toFixed(1)}MB, video+audio OK)`)
    }
  }
}
console.log(`\n${total - failed}/${total} videos passed.`)
if (failed) process.exitCode = 1
