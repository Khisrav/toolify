// Generates PWA icons (indigo rounded square + white "T" glyph) and the test fixture PNG.
import { writeFileSync, mkdirSync } from 'node:fs'
import { encodePng } from './png.mjs'

const out = new URL('../public/icons/', import.meta.url).pathname
mkdirSync(out, { recursive: true })

// Coverage of rounded rect (units 0..1) with supersampling for anti-aliasing.
function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false
  const cx = x < x0 + r ? x0 + r : x > x1 - r ? x1 - r : x
  const cy = y < y0 + r ? y0 + r : y > y1 - r ? y1 - r : y
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r
}
// "T" within inner 80% safe zone (0.2..0.8): bar and stem.
const glyph = (x, y) => inRoundRect(x, y, 0.28, 0.27, 0.72, 0.4, 0.02) || inRoundRect(x, y, 0.43, 0.27, 0.57, 0.73, 0.02)

function render(size, { full }) {
  const px = Buffer.alloc(size * size * 4)
  const S = 3
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let bg = 0, fg = 0
    for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
      const u = (x + (sx + .5) / S) / size, v = (y + (sy + .5) / S) / size
      if (full || inRoundRect(u, v, 0, 0, 1, 1, 0.22)) { bg++; if (glyph(u, v)) fg++ }
    }
    const n = S * S, a = bg / n, f = fg / bg || 0
    const i = (y * size + x) * 4
    px[i] = Math.round(0x4f * (1 - f) + 255 * f); px[i + 1] = Math.round(0x46 * (1 - f) + 255 * f); px[i + 2] = Math.round(0xe5 * (1 - f) + 255 * f)
    px[i + 3] = Math.round(a * 255)
  }
  return px
}
// Full-bleed square for all (maskable-safe; the OS applies its own mask). Apple icon must be opaque.
writeFileSync(out + 'icon-192.png', encodePng(192, 192, render(192, { full: true })))
writeFileSync(out + 'icon-512.png', encodePng(512, 512, render(512, { full: true })))
writeFileSync(out + 'apple-touch-icon.png', encodePng(180, 180, render(180, { full: true })))
writeFileSync(new URL('../public/logo.svg', import.meta.url).pathname,
`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="#4f46e5"/><rect x="143" y="138" width="226" height="67" rx="10" fill="#fff"/><rect x="220" y="138" width="72" height="236" rx="10" fill="#fff"/></svg>
`)

// Test fixture: 64x48 gradient with alpha.
const w = 64, h = 48, fx = Buffer.alloc(w * h * 4)
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
  const i = (y * w + x) * 4
  fx[i] = Math.round(255 * x / (w - 1)); fx[i + 1] = Math.round(255 * y / (h - 1)); fx[i + 2] = 160; fx[i + 3] = 255 - Math.round(180 * x / (w - 1))
}
mkdirSync(new URL('../tests/fixtures/', import.meta.url).pathname, { recursive: true })
writeFileSync(new URL('../tests/fixtures/sample.png', import.meta.url).pathname, encodePng(w, h, fx))
console.log('[icons] wrote icons, logo.svg, tests/fixtures/sample.png')
