# Tutorial videos

Narrated walkthroughs of the real app, recorded automatically in English and Urdu. Each video is a
script in `videos/`. The recorder starts a demo server with sample data, plays the script in
Chromium (with a visible cursor, highlights and captions), adds neural narration, and writes an MP4.
The app itself is English-only — only the narration changes between languages.

## Record

```bash
cd tools/tutorials && npm install            # Playwright (once)
npx playwright install chromium              # the browser binary (once, ~300MB)
python -m pip install edge-tts imageio-ffmpeg # narration + a bundled ffmpeg binary (once)
node record.mjs                              # every video, both languages → out/en/*.mp4, out/ur/*.mp4
node record.mjs 02 03 --lang ur              # just some videos / one language
node record.mjs 05 --port 9120               # use another port to record two batches at once
node verify.mjs                              # supervisor check: every MP4 has real video+audio, sane duration
node publish.mjs                             # copies out/ + poster JPGs into ../../public/tutorials/
```

Narration audio is cached by content hash under `.cache/<lang>/`, so re-recording after a small
script edit only re-synthesizes the scenes that actually changed.

The 10-ai-assistant video needs a *working* assistant with no real API key: `server.mjs` sets
`AGENT_PROVIDER=fake` and replaces the built-in fake provider's `step()` with a tiny scripted one
(see `SCRIPT` in `server.mjs`) that decides which real tool to call for that video's exact
questions. Every tool call it makes (`search_products`, `set_product_price`, `find_tutorial`, …)
still runs for real against the demo's real seeded data — only the "what would the model say next"
part is scripted.

## Writing a video

```js
export default {
  id: '02-making-a-sale',                  // output file name; must match an entry in
                                            // ../../public/tutorials.json (the Help page's catalogue)
  title: { en: 'Making a sale', ur: '...' },
  // start: 'pos',                          // first route after '#/' (default 'home')
  scenes: [
    { en: 'Narration…', ur: 'اردو بیان…' },  // the first scene plays over the title card
    { en: '…', ur: '…', async run(h) { await h.click(h.nav('/pos')) } },
  ],
}
```

The helper `h`:

| Helper | Does |
|---|---|
| `h.goto(path)` | open `#/<path>` |
| `h.click(target)`, `h.type(target, text)`, `h.select(target, value)` | move the cursor there, then act |
| `h.pointAt(target)` | move the cursor only |
| `h.mark(target, ms)` | outline an element for a moment |
| `h.scroll(y)`, `h.wait(ms)` | scroll the page, pause |
| `h.nav(path)` | a left-nav link by its `data-path` |
| `h.button(name)`, `h.link(..)`, `h.label(..)`, `h.text(..)` | find by the real on-screen English text |
| `h.lang`, `h.page`, `h.ctx` | language, Playwright page, seeded data (`h.ctx.products`, `h.ctx.customers`, …) |

`target` is a CSS selector string or a Playwright locator. Sample data comes from `seed.mjs`
(pharmacy "City Care Pharmacy", two staff accounts, eight medicines with batches, two customers, a
supplier purchase order, a stock transfer, a department issue, an appointment, messages and a
knowledge article).

Each scene's narration and its `run` actions start together, and the scene lasts as long as the
longer of the two, so write narration that matches what happens on screen.
