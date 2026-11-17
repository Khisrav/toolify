/**
 * Pure file helpers (no Vue/Nuxt imports) so they can be unit-tested anywhere.
 * DOM types are used only in signatures; nothing here touches `window` at import time.
 */

export interface RejectedFile {
  name: string
  reason: string
}

// ---------------------------------------------------------------------------
// accept matching
// ---------------------------------------------------------------------------

/**
 * Does `file` match an `accept` list of MIME types (`image/png`), MIME globs
 * (`image/*`) and extensions (`.heic`)? An empty list or a wildcard token accepts everything.
 * Matching is case-insensitive. Extensions are matched against the file name so that
 * formats browsers report with an empty MIME type (HEIC, JXL...) still work.
 */
export function accepts(file: Pick<File, 'name' | 'type'>, accept: readonly string[] | undefined): boolean {
  const list = (accept ?? []).map(a => a.trim().toLowerCase()).filter(Boolean)
  if (list.length === 0) return true
  const name = file.name.toLowerCase()
  const type = (file.type || '').toLowerCase()
  return list.some((token) => {
    if (token === '*' || token === '*/*') return true
    if (token.startsWith('.')) return name.endsWith(token)
    if (token.endsWith('/*')) return type.startsWith(token.slice(0, -1))
    return type === token
  })
}

/** Split a comma-separated `accept` attribute value into a list. */
export function parseAccept(value: string): string[] {
  return value.split(',').map(s => s.trim()).filter(Boolean)
}

/** Human-readable list for UI: `['image/*', '.heic']` → `['Images', 'HEIC']`. */
export function describeAccept(accept: readonly string[]): string[] {
  return accept.map((a) => {
    const t = a.trim().toLowerCase()
    if (t === 'image/*') return 'Images'
    if (t === 'video/*') return 'Video'
    if (t === 'audio/*') return 'Audio'
    if (t === 'text/*') return 'Text'
    if (t.startsWith('.')) return t.slice(1).toUpperCase()
    if (t.includes('/')) return (t.split('/')[1] ?? t).replace(/^x-/, '').toUpperCase()
    return t
  })
}

// ---------------------------------------------------------------------------
// dedupe
// ---------------------------------------------------------------------------

export function fileKey(file: Pick<File, 'name' | 'size' | 'lastModified'>): string {
  return `${file.name}\u0000${file.size}\u0000${file.lastModified}`
}

/** Append `incoming` to `existing`, dropping any file already present (name+size+lastModified). */
export function dedupeFiles(existing: readonly File[], incoming: readonly File[]): { merged: File[], added: File[] } {
  const seen = new Set(existing.map(fileKey))
  const added: File[] = []
  for (const f of incoming) {
    const k = fileKey(f)
    if (seen.has(k)) continue
    seen.add(k)
    added.push(f)
  }
  return { merged: [...existing, ...added], added }
}

// ---------------------------------------------------------------------------
// names
// ---------------------------------------------------------------------------

function splitExt(name: string): { stem: string, ext: string } {
  const i = name.lastIndexOf('.')
  // No dot, or a leading dot only (".gitignore") → no extension.
  if (i <= 0) return { stem: name, ext: '' }
  return { stem: name.slice(0, i), ext: name.slice(i) }
}

/**
 * Return `name` if free, else `stem-1.ext`, `stem-2.ext`... Comparison is case-insensitive
 * (macOS/Windows file systems). The returned name is NOT added to `taken`; callers do that.
 */
export function uniqueName(name: string, taken: ReadonlySet<string>): string {
  const lower = new Set<string>()
  for (const t of taken) lower.add(t.toLowerCase())
  if (!lower.has(name.toLowerCase())) return name
  const { stem, ext } = splitExt(name)
  let n = 1
  while (lower.has(`${stem}-${n}${ext}`.toLowerCase())) n++
  return `${stem}-${n}${ext}`
}

/** `photo.heic`, `jpg` → `photo.jpg`. A leading dot on `ext` is optional. Names without extension get one. */
export function replaceExtension(name: string, ext: string): string {
  const clean = ext.replace(/^\./, '')
  const { stem } = splitExt(name)
  return clean ? `${stem}.${clean}` : stem
}

// ---------------------------------------------------------------------------
// drag-and-drop traversal
// ---------------------------------------------------------------------------

interface FsEntry {
  isFile: boolean
  isDirectory: boolean
  name: string
  fullPath?: string
}
interface FsFileEntry extends FsEntry {
  file: (ok: (f: File) => void, fail: (e: unknown) => void) => void
}
interface FsDirReader {
  readEntries: (ok: (entries: FsEntry[]) => void, fail: (e: unknown) => void) => void
}
interface FsDirEntry extends FsEntry {
  createReader: () => FsDirReader
}
interface HandleLike {
  kind: 'file' | 'directory'
  name: string
}
interface FileHandleLike extends HandleLike {
  getFile: () => Promise<File>
}
interface DirHandleLike extends HandleLike {
  values: () => AsyncIterable<HandleLike>
}
type ItemWithHandle = DataTransferItem & {
  webkitGetAsEntry?: () => FsEntry | null
  getAsFileSystemHandle?: () => Promise<HandleLike | null>
}

const MAX_FILES = 5000

// Relative paths of files that came from a dropped folder (File.webkitRelativePath is read-only and empty there).
const relativePaths = new WeakMap<File, string>()

/** Remember where `file` lives relative to the dropped/picked root (e.g. `holiday/day1/a.jpg`). */
export function setRelativePath(file: File, path: string): void {
  const clean = path.replace(/\\/g, '/').replace(/^\/+/, '')
  if (clean) relativePaths.set(file, clean)
}

/** Folder-relative path of a file: drop traversal, then `webkitRelativePath` (folder picker), then the name. */
export function relativePath(file: File): string {
  return relativePaths.get(file) || (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
}

async function readAllEntries(reader: FsDirReader): Promise<FsEntry[]> {
  const out: FsEntry[] = []
  // readEntries returns batches (≈100 in Chromium) until it returns [].
  for (;;) {
    const batch = await new Promise<FsEntry[]>((ok, fail) => reader.readEntries(ok, fail))
    if (batch.length === 0) return out
    out.push(...batch)
  }
}

async function walkEntry(entry: FsEntry, out: File[]): Promise<void> {
  if (out.length >= MAX_FILES) return
  if (entry.isFile) {
    const file = await new Promise<File>((ok, fail) => (entry as FsFileEntry).file(ok, fail))
    if (entry.fullPath) setRelativePath(file, entry.fullPath)
    out.push(file)
  }
  else if (entry.isDirectory) {
    for (const child of await readAllEntries((entry as FsDirEntry).createReader())) {
      await walkEntry(child, out)
    }
  }
}

async function walkHandle(handle: HandleLike, out: File[], prefix = ''): Promise<void> {
  if (out.length >= MAX_FILES) return
  const path = prefix ? `${prefix}/${handle.name}` : handle.name
  if (handle.kind === 'file') {
    const file = await (handle as FileHandleLike).getFile()
    setRelativePath(file, path)
    out.push(file)
  }
  else {
    for await (const child of (handle as DirHandleLike).values()) await walkHandle(child, out, path)
  }
}

/**
 * Flatten a drop into files, recursing into folders. All `DataTransferItem` accessors are
 * called synchronously up-front (the list is cleared once the event handler yields).
 * Falls back to `dataTransfer.files` when the entry APIs are unavailable.
 */
export async function collectDroppedFiles(dt: DataTransfer): Promise<File[]> {
  const items = Array.from(dt.items ?? []).filter(i => i.kind === 'file') as ItemWithHandle[]
  const direct = Array.from(dt.files ?? [])
  if (items.length === 0) return direct

  type Source = { entry: FsEntry } | { handle: Promise<HandleLike | null> } | { file: File | null }
  const sources: Source[] = items.map((item) => {
    const entry = item.webkitGetAsEntry?.() ?? null
    if (entry) return { entry }
    if (typeof item.getAsFileSystemHandle === 'function') return { handle: item.getAsFileSystemHandle() }
    return { file: item.getAsFile() }
  })

  const out: File[] = []
  for (const [i, src] of sources.entries()) {
    try {
      if ('entry' in src) await walkEntry(src.entry, out)
      else if ('handle' in src) {
        const h = await src.handle
        if (h) await walkHandle(h, out)
        else if (direct[i]) out.push(direct[i])
      }
      else if (src.file) out.push(src.file)
    }
    catch {
      // Unreadable entry (permissions, vanished file): fall back to the flat file when we have one.
      if (direct[i]) out.push(direct[i])
    }
  }
  return out
}
