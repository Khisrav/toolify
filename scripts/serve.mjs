// Zero-dependency static server for .output/public that applies _headers.
import { createServer } from 'node:http'
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { join, extname, normalize } from 'node:path'

const root = new URL('../.output/public', import.meta.url).pathname
const port = Number(process.argv[2] || process.env.PORT || 4173)

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.avif': 'image/avif', '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json',
}

// Parse Netlify-style _headers: path pattern lines followed by indented "Name: value".
function loadRules() {
  const file = join(root, '_headers')
  if (!existsSync(file)) return []
  const rules = []
  let cur = null
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    if (/^\S/.test(line)) {
      const esc = line.trim().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
      cur = { re: new RegExp(`^${esc}$`), headers: [] }
      rules.push(cur)
    } else if (cur) {
      const i = line.indexOf(':')
      cur.headers.push([line.slice(0, i).trim(), line.slice(i + 1).trim()])
    }
  }
  return rules
}
const rules = loadRules()

function resolveFile(pathname) {
  const clean = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '')
  const base = join(root, clean)
  if (!base.startsWith(root)) return null
  const candidates = [base, join(base, 'index.html'), base + '.html']
  for (const c of candidates) if (existsSync(c) && statSync(c).isFile()) return c
  return null
}

createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  let status = 200
  let file = resolveFile(url.pathname)
  if (!file) {
    const isAsset = extname(url.pathname) !== ''
    if (isAsset) { status = 404; file = resolveFile('/404.html') }
    else { file = resolveFile('/200.html') || resolveFile('/404.html'); if (!file) status = 404 }
  }
  for (const r of rules) if (r.re.test(url.pathname)) for (const [k, v] of r.headers) res.setHeader(k, v)
  if (!file) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found') }
  res.writeHead(status, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Content-Length': statSync(file).size })
  if (req.method === 'HEAD') return res.end()
  createReadStream(file).pipe(res)
}).listen(port, () => console.log(`[serve] http://localhost:${port} (root: ${root})`))
