// Generates app/lib/licenses.json from the production dependency tree in node_modules.
// Usage: npm run licenses
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outFile = join(root, 'app', 'lib', 'licenses.json')

const readJson = file => JSON.parse(readFileSync(file, 'utf8'))

/** Walk up from `fromDir` the way Node resolves packages. */
function findPackage(name, fromDir) {
  let dir = fromDir
  for (;;) {
    const candidate = join(dir, 'node_modules', name, 'package.json')
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function normalizeLicense(pkg) {
  const raw = pkg.license ?? pkg.licenses
  if (!raw) return 'UNKNOWN'
  if (typeof raw === 'string') return raw
  if (Array.isArray(raw)) {
    return raw.map(l => (typeof l === 'string' ? l : l?.type)).filter(Boolean).join(' OR ') || 'UNKNOWN'
  }
  return raw.type ?? 'UNKNOWN'
}

const rootPkg = readJson(join(root, 'package.json'))
const visited = new Set()
const entries = new Map()
const missing = []

function visit(name, fromDir) {
  const file = findPackage(name, fromDir)
  if (!file) {
    missing.push(name)
    return
  }
  if (visited.has(file)) return
  visited.add(file)

  const pkg = readJson(file)
  const key = `${pkg.name}@${pkg.version}`
  if (!entries.has(key)) {
    const entry = {
      name: pkg.name,
      version: pkg.version,
      license: normalizeLicense(pkg),
    }
    entries.set(key, entry)
  }

  for (const dep of Object.keys(pkg.dependencies ?? {})) {
    visit(dep, dirname(file))
  }
}

for (const dep of Object.keys(rootPkg.dependencies ?? {})) {
  visit(dep, root)
}

const licenses = [...entries.values()].sort((a, b) =>
  a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
)

mkdirSync(dirname(outFile), { recursive: true })
writeFileSync(outFile, `${JSON.stringify(licenses, null, 2)}\n`)

console.log(`Wrote ${licenses.length} licenses to ${outFile}`)
if (missing.length) {
  console.warn(`Warning: ${missing.length} package(s) not found in node_modules: ${[...new Set(missing)].join(', ')}`)
}
