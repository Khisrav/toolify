/**
 * Dependency-free archive reading for bulk intake: ZIP (stored/deflate, ZIP64), TAR and TAR.GZ/TGZ.
 * Decompression uses the platform `DecompressionStream`, so nothing extra is downloaded.
 * ZIP entries are read lazily through `File.slice`, so a large archive is never fully in memory.
 * Pure module: no Vue/Nuxt imports.
 */

export interface ArchiveEntry {
  /** Path inside the archive, `/`-separated, without a leading slash. */
  path: string
  file: File
}

export interface ExtractOptions {
  /** Keep only entries whose path passes this check (checked before decompressing). */
  filter?: (path: string) => boolean
  /** Stop after this many kept entries. Default 5000. */
  maxEntries?: number
  signal?: AbortSignal
}

export class ArchiveError extends Error {
  override name = 'ArchiveError'
}

const ARCHIVE_EXT = ['.zip', '.tar', '.tgz', '.tar.gz']
const ARCHIVE_MIME = ['application/zip', 'application/x-zip-compressed', 'application/x-tar', 'application/gzip', 'application/x-gzip', 'application/x-compressed-tar']

/** Accept tokens for archive inputs (for `accept` attributes and `accepts()` checks). */
export const archiveAccepts = [...ARCHIVE_EXT, ...ARCHIVE_MIME]

type Kind = 'zip' | 'tar' | 'tgz'

function kindByName(file: Pick<File, 'name' | 'type'>): Kind | null {
  const n = file.name.toLowerCase()
  if (n.endsWith('.zip')) return 'zip'
  if (n.endsWith('.tar.gz') || n.endsWith('.tgz')) return 'tgz'
  if (n.endsWith('.tar')) return 'tar'
  const t = file.type.toLowerCase()
  if (t === 'application/zip' || t === 'application/x-zip-compressed') return 'zip'
  if (t === 'application/x-tar') return 'tar'
  if (t === 'application/gzip' || t === 'application/x-gzip' || t === 'application/x-compressed-tar') return 'tgz'
  return null
}

export function isArchive(file: Pick<File, 'name' | 'type'>): boolean {
  return kindByName(file) !== null
}

/** Skip OS junk (`__MACOSX/`, `._foo`, `.DS_Store`, `Thumbs.db`) and hidden files. */
export function isJunkPath(path: string): boolean {
  const parts = path.split('/')
  if (parts.some(p => p === '__MACOSX')) return true
  const base = parts[parts.length - 1] ?? ''
  return base.startsWith('.') || base.toLowerCase() === 'thumbs.db' || base.toLowerCase() === 'desktop.ini'
}

/** Normalise an entry path and reject anything that escapes the archive root. */
export function safeEntryPath(raw: string): string | null {
  const parts: string[] = []
  for (const p of raw.replace(/\\/g, '/').split('/')) {
    if (p === '' || p === '.') continue
    if (p === '..') return null
    parts.push(p)
  }
  return parts.length ? parts.join('/') : null
}

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', png: 'image/png', webp: 'image/webp', avif: 'image/avif',
  gif: 'image/gif', bmp: 'image/bmp', ico: 'image/x-icon', heic: 'image/heic', heif: 'image/heif', svg: 'image/svg+xml',
  tif: 'image/tiff', tiff: 'image/tiff',
}

/** Best-effort MIME type from a file name (archives carry no types). */
export function mimeFromName(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  return MIME_BY_EXT[ext] ?? ''
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function makeFile(parts: BlobPart[], path: string, lastModified: number): File {
  return new File(parts, baseName(path), { type: mimeFromName(path), lastModified })
}

async function inflateRaw(blob: Blob): Promise<Blob> {
  if (typeof DecompressionStream === 'undefined') throw new ArchiveError('This browser cannot decompress archives')
  return new Response(blob.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob()
}

async function gunzip(blob: Blob): Promise<Blob> {
  if (typeof DecompressionStream === 'undefined') throw new ArchiveError('This browser cannot decompress archives')
  return new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).blob()
}

async function bytes(blob: Blob, start: number, end: number): Promise<DataView> {
  return new DataView(await blob.slice(start, end).arrayBuffer())
}

// ---------------------------------------------------------------------------
// ZIP
// ---------------------------------------------------------------------------

const EOCD_SIG = 0x06054B50
const EOCD64_LOC_SIG = 0x07064B50
const EOCD64_SIG = 0x06064B50
const CEN_SIG = 0x02014B50
const LOC_SIG = 0x04034B50

function dosDate(date: number, time: number): number {
  const d = new Date(
    ((date >> 9) & 0x7F) + 1980, ((date >> 5) & 0x0F) - 1, date & 0x1F,
    (time >> 11) & 0x1F, (time >> 5) & 0x3F, (time & 0x1F) * 2,
  )
  const t = d.getTime()
  return Number.isFinite(t) ? t : Date.now()
}

function u64(view: DataView, off: number): number {
  return Number(view.getBigUint64(off, true))
}

async function readZip(file: Blob, opts: Required<Pick<ExtractOptions, 'filter' | 'maxEntries'>> & { signal?: AbortSignal }): Promise<ArchiveEntry[]> {
  // The end-of-central-directory record sits in the last 22 + up to 65535 (comment) bytes.
  const tailLen = Math.min(file.size, 22 + 0xFFFF + 20)
  const tailStart = file.size - tailLen
  const tail = await bytes(file, tailStart, file.size)
  let eocd = -1
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === EOCD_SIG) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new ArchiveError('Not a valid ZIP file')

  let count = tail.getUint16(eocd + 10, true)
  let cdSize = tail.getUint32(eocd + 12, true)
  let cdOffset = tail.getUint32(eocd + 16, true)

  // ZIP64: a locator sits right before the classic EOCD.
  if (eocd >= 20 && tail.getUint32(eocd - 20, true) === EOCD64_LOC_SIG) {
    const rec64Off = u64(tail, eocd - 20 + 8)
    const rec = await bytes(file, rec64Off, rec64Off + 56)
    if (rec.getUint32(0, true) !== EOCD64_SIG) throw new ArchiveError('Corrupt ZIP64 archive')
    count = u64(rec, 32)
    cdSize = u64(rec, 40)
    cdOffset = u64(rec, 48)
  }

  const cd = await bytes(file, cdOffset, cdOffset + cdSize)
  const decoder = new TextDecoder()
  const latin1 = new TextDecoder('latin1')
  const out: ArchiveEntry[] = []
  let p = 0
  for (let n = 0; n < count && p + 46 <= cd.byteLength; n++) {
    opts.signal?.throwIfAborted()
    if (cd.getUint32(p, true) !== CEN_SIG) throw new ArchiveError('Corrupt ZIP central directory')
    const flags = cd.getUint16(p + 8, true)
    const method = cd.getUint16(p + 10, true)
    const time = cd.getUint16(p + 12, true)
    const date = cd.getUint16(p + 14, true)
    let compSize = cd.getUint32(p + 20, true)
    let size = cd.getUint32(p + 24, true)
    const nameLen = cd.getUint16(p + 28, true)
    const extraLen = cd.getUint16(p + 30, true)
    const commentLen = cd.getUint16(p + 32, true)
    let localOff = cd.getUint32(p + 42, true)
    const nameBytes = new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen)
    const rawName = (flags & 0x800 ? decoder : latin1).decode(nameBytes)

    // ZIP64 extended info: only the fields that overflowed are present, in this order.
    let e = p + 46 + nameLen
    const extraEnd = e + extraLen
    while (e + 4 <= extraEnd) {
      const id = cd.getUint16(e, true)
      const len = cd.getUint16(e + 2, true)
      if (id === 0x0001) {
        let q = e + 4
        if (size === 0xFFFFFFFF) { size = u64(cd, q); q += 8 }
        if (compSize === 0xFFFFFFFF) { compSize = u64(cd, q); q += 8 }
        if (localOff === 0xFFFFFFFF) { localOff = u64(cd, q) }
      }
      e += 4 + len
    }
    p = extraEnd + commentLen

    if (rawName.endsWith('/')) continue // directory
    const path = safeEntryPath(rawName)
    if (!path || !opts.filter(path)) continue
    if (flags & 0x1) throw new ArchiveError('Encrypted ZIP files are not supported')
    if (method !== 0 && method !== 8) throw new ArchiveError(`Unsupported ZIP compression (method ${method})`)

    const loc = await bytes(file, localOff, localOff + 30)
    if (loc.getUint32(0, true) !== LOC_SIG) throw new ArchiveError('Corrupt ZIP entry')
    const dataStart = localOff + 30 + loc.getUint16(26, true) + loc.getUint16(28, true)
    const raw = file.slice(dataStart, dataStart + compSize)
    const data = method === 0 ? raw : await inflateRaw(raw)
    if (data.size !== size) throw new ArchiveError(`Corrupt ZIP entry: ${path}`)
    out.push({ path, file: makeFile([data], path, dosDate(date, time)) })
    if (out.length >= opts.maxEntries) break
  }
  return out
}

// ---------------------------------------------------------------------------
// TAR (ustar, GNU long names, PAX path/mtime)
// ---------------------------------------------------------------------------

function cstr(buf: Uint8Array, off: number, len: number): string {
  let end = off
  while (end < off + len && buf[end] !== 0) end++
  return new TextDecoder().decode(buf.subarray(off, end))
}

function octal(buf: Uint8Array, off: number, len: number): number {
  // GNU base-256 for sizes ≥ 8 GiB.
  if ((buf[off]! & 0x80) !== 0) {
    let v = 0
    for (let i = off + 1; i < off + len; i++) v = v * 256 + buf[i]!
    return v
  }
  const s = cstr(buf, off, len).trim()
  return s ? Number.parseInt(s, 8) : 0
}

function parsePax(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  let i = 0
  while (i < text.length) {
    const sp = text.indexOf(' ', i)
    if (sp < 0) break
    const len = Number.parseInt(text.slice(i, sp), 10)
    if (!len) break
    const rec = text.slice(sp + 1, i + len - 1)
    const eq = rec.indexOf('=')
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1)
    i += len
  }
  return out
}

async function readTar(file: Blob, opts: Required<Pick<ExtractOptions, 'filter' | 'maxEntries'>> & { signal?: AbortSignal }): Promise<ArchiveEntry[]> {
  const out: ArchiveEntry[] = []
  let off = 0
  let longName: string | null = null
  let pax: Record<string, string> = {}
  let globalPax: Record<string, string> = {}
  while (off + 512 <= file.size) {
    opts.signal?.throwIfAborted()
    const h = new Uint8Array(await file.slice(off, off + 512).arrayBuffer())
    if (h.every(b => b === 0)) break // end-of-archive marker
    const size = octal(h, 124, 12)
    const type = String.fromCharCode(h[156] || 48) // '\0' means regular file
    const dataStart = off + 512
    off = dataStart + Math.ceil(size / 512) * 512

    if (type === 'L') {
      longName = cstr(new Uint8Array(await file.slice(dataStart, dataStart + size).arrayBuffer()), 0, size)
      continue
    }
    if (type === 'x' || type === 'g') {
      const rec = parsePax(new TextDecoder().decode(await file.slice(dataStart, dataStart + size).arrayBuffer()))
      if (type === 'x') pax = rec
      else globalPax = { ...globalPax, ...rec }
      continue
    }

    const magic = cstr(h, 257, 6)
    const prefix = magic.startsWith('ustar') ? cstr(h, 345, 155) : ''
    const headerName = prefix ? `${prefix}/${cstr(h, 0, 100)}` : cstr(h, 0, 100)
    const meta = { ...globalPax, ...pax }
    const name = meta.path ?? longName ?? headerName
    const mtime = meta.mtime ? Number.parseFloat(meta.mtime) : octal(h, 136, 12)
    longName = null
    pax = {}

    if (type !== '0' && type !== '7') continue // only regular files
    const path = safeEntryPath(name)
    if (!path || !opts.filter(path)) continue
    out.push({ path, file: makeFile([file.slice(dataStart, dataStart + size)], path, mtime * 1000 || Date.now()) })
    if (out.length >= opts.maxEntries) break
  }
  return out
}

// ---------------------------------------------------------------------------

/** Extract the files of a ZIP / TAR / TAR.GZ. Throws `ArchiveError` for unreadable archives. */
export async function extractArchive(file: File, options: ExtractOptions = {}): Promise<ArchiveEntry[]> {
  const kind = kindByName(file)
  if (!kind) throw new ArchiveError('Unsupported archive type')
  const opts = {
    filter: options.filter ?? (() => true),
    maxEntries: options.maxEntries ?? 5000,
    signal: options.signal,
  }
  const filter = (p: string) => !isJunkPath(p) && opts.filter(p)
  if (kind === 'zip') return readZip(file, { ...opts, filter })
  if (kind === 'tar') return readTar(file, { ...opts, filter })
  return readTar(await gunzip(file), { ...opts, filter })
}
