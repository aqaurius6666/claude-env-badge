// Renders index.html#record frame by frame on a fake clock and writes env-badge-demo.gif.
//   npm i --no-save playwright gifenc pngjs && node demo/record.mjs
// Install JetBrains Mono and Instrument Sans locally first: the page's Google Fonts link is blocked here
// so every frame renders with the same faces.
import { chromium } from 'playwright'
import { PNG } from 'pngjs'
import gifenc from 'gifenc'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const { GIFEncoder, quantize, applyPalette } = gifenc
const [W, H, STEP] = [960, 540, 100]
const page_ = new URL('index.html#record', import.meta.url).href
const out = fileURLToPath(new URL('env-badge-demo.gif', import.meta.url))

const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {})
const page = await browser.newPage({ viewport: { width: W, height: H } })
page.on('pageerror', (e) => console.error(e))
await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort())
await page.clock.install()
await page.goto(page_)

const frames = []
for (let i = 0; i < 600; i++) {
  await page.clock.runFor(STEP)
  const buf = await page.screenshot()
  const prev = frames.at(-1)
  if (prev && prev.buf.equals(buf)) prev.delay += STEP
  else frames.push({ buf, delay: STEP })
  if (await page.evaluate(() => document.documentElement.dataset.done)) break
}
frames.at(-1).delay += 1500
await browser.close()

// one shared palette keeps badge colors stable across frames
const px = frames.map((f) => PNG.sync.read(f.buf).data)
const palette = quantize(Buffer.concat(px.filter((_, i) => i % Math.max(1, Math.floor(px.length / 10)) === 0)), 256)
const gif = GIFEncoder()
px.forEach((d, i) => gif.writeFrame(applyPalette(d, palette), W, H, { palette: i ? undefined : palette, delay: frames[i].delay }))
gif.finish()
fs.writeFileSync(out, gif.bytes())
console.log(`${frames.length} frames, ${frames.reduce((a, f) => a + f.delay, 0)} ms, ${Math.round(gif.bytes().length / 1024)} KB`)
