// Fails the build if the output references external origins.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'

const root = new URL('../.output/public', import.meta.url).pathname
const ALLOW_ALWAYS = [
  /^https?:\/\/(www\.)?w3\.org\//, /^https?:\/\/vuejs\.org\//, /^https?:\/\/nuxt\.com\//,
  /^https?:\/\/tailwindcss\.com/, /^https?:\/\/bit\.ly\/wb-precache/,
  /^https?:\/\/[ab]\.invalid/, /^https?:\/\/localhost/, /^https?:\/\/127\.0\.0\.1/,
]
const ICONIFY = /^https?:\/\/api\d*\.iconify\.design/
const urlRe = /https?:\/\/[^\s"'`)<>\\,;]+/g
const attrRe = /\b(?:src|href|action|poster|data)\s*=\s*["']?\s*((?:https?:)?\/\/[^"'\s>]+)/gi
const cssRe = /url\(\s*["']?\s*((?:https?:)?\/\/[^"')\s]+)|@import\s+(?:url\()?\s*["']?\s*((?:https?:)?\/\/[^"')\s;]+)/gi

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) walk(p, out); else out.push(p)
  }
  return out
}
const allowed = u => ALLOW_ALWAYS.some(r => r.test(u))
const bad = []
let iconifySeen = false

for (const f of walk(root)) {
  const ext = extname(f)
  if (!['.html', '.css', '.js', '.mjs', '.webmanifest', '.json', '.svg'].includes(ext)) continue
  const text = readFileSync(f, 'utf8')
  const rel = f.slice(root.length)
  if (['.html', '.css', '.webmanifest', '.svg'].includes(ext)) {
    const re = ext === '.css' ? cssRe : ext === '.html' || ext === '.svg' ? attrRe : null
    for (const m of re ? text.matchAll(re) : []) {
      const u = m[1] || m[2]
      if (u && !allowed(u) && !/^\/\/www\.w3\.org/.test(u)) bad.push(`${rel}: ${u}`)
    }
    if (ext === '.html') for (const m of text.matchAll(cssRe)) { const u = m[1] || m[2]; if (u && !allowed(u)) bad.push(`${rel}: ${u}`) }
    if (ext === '.webmanifest') for (const m of text.matchAll(urlRe)) if (!allowed(m[0])) bad.push(`${rel}: ${m[0]}`)
  } else {
    for (const m of text.matchAll(urlRe)) {
      const u = m[0]
      if (ICONIFY.test(u)) { iconifySeen = true; continue }
      if (!allowed(u)) bad.push(`${rel}: ${u}`)
    }
  }
}
if (iconifySeen) console.log('[check-no-external] notice: iconify API default URLs present in JS (inert; icon provider is "none"). E2E network guard is the real proof.')
if (bad.length) {
  console.error('[check-no-external] FAIL: external references found:')
  for (const b of [...new Set(bad)]) console.error('  ' + b)
  process.exit(1)
}
console.log('[check-no-external] OK: no disallowed external references')
