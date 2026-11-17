/**
 * Saving results: plain download, Save-As picker, folder save, streaming zip, and Web Share.
 * All browser-specific APIs are feature-detected and fall back gracefully.
 */
import { computed, onMounted, ref } from 'vue'
import { downloadZip as clientZip } from 'client-zip'
import { uniqueName } from '~/lib/files'

export { uniqueName, replaceExtension } from '~/lib/files'

export interface OutputItem {
  name: string
  blob: Blob
}

export type SaveResult = 'saved' | 'downloaded' | 'cancelled'

interface WritableLike {
  write: (data: Blob | BufferSource) => Promise<void>
  close: () => Promise<void>
}
interface FileHandleLike {
  createWritable: () => Promise<WritableLike & WritableStream>
}
interface DirHandleLike {
  entries: () => AsyncIterable<[string, unknown]>
  getFileHandle: (name: string, opts?: { create?: boolean }) => Promise<FileHandleLike>
  getDirectoryHandle: (name: string, opts?: { create?: boolean }) => Promise<DirHandleLike>
}
interface FsWindow {
  showSaveFilePicker?: (opts?: {
    suggestedName?: string
    types?: { description?: string, accept: Record<string, string[]> }[]
  }) => Promise<FileHandleLike>
  showDirectoryPicker?: (opts?: { mode?: 'read' | 'readwrite' }) => Promise<DirHandleLike>
}

/** Above this total size, prefer streaming the zip straight to disk when a save picker exists. */
const STREAM_ZIP_THRESHOLD = 200 * 1024 * 1024

function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError'
}

function acceptFor(name: string, type: string) {
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || !type) return undefined
  return [{ accept: { [type]: [name.slice(dot)] } }]
}

/** Dedupe names within a batch (`a.jpg`, `a.jpg` → `a.jpg`, `a-1.jpg`). */
function uniqueItems(items: readonly OutputItem[], taken: Set<string> = new Set()): OutputItem[] {
  return items.map((it) => {
    const name = uniqueName(it.name, taken)
    taken.add(name)
    return { name, blob: it.blob }
  })
}

export function useFileOutput() {
  const mounted = ref(false)
  onMounted(() => { mounted.value = true })

  // Evaluated only after mount so SSR/prerender and hydration agree (both false).
  const canSaveToFolder = computed(() => mounted.value && typeof (window as unknown as FsWindow).showDirectoryPicker === 'function')
  const canShareFiles = computed(() => {
    if (!mounted.value || typeof navigator.share !== 'function' || typeof navigator.canShare !== 'function') return false
    try {
      return navigator.canShare({ files: [new File([''], 'probe.txt', { type: 'text/plain' })] })
    }
    catch {
      return false
    }
  })

  /** Classic `<a download>`. The object URL is revoked after the browser has started the save. */
  function download(blob: Blob, name: string): void {
    if (!import.meta.client) return
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.rel = 'noopener'
    a.style.display = 'none'
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }

  /** Save with a native "Save as" dialog where supported; otherwise download. Cancel is not an error. */
  async function saveAs(blob: Blob, name: string): Promise<SaveResult> {
    const picker = import.meta.client ? (window as unknown as FsWindow).showSaveFilePicker : undefined
    if (!picker) {
      download(blob, name)
      return 'downloaded'
    }
    try {
      const handle = await picker.call(window, { suggestedName: name, types: acceptFor(name, blob.type) })
      const w = await handle.createWritable()
      await w.write(blob)
      await w.close()
      return 'saved'
    }
    catch (e) {
      if (isAbort(e)) return 'cancelled'
      throw e
    }
  }

  /**
   * Write every item into a user-chosen folder (Chromium). Names may contain `/` to create
   * subfolders. Existing files are never overwritten: clashes get a `-1`, `-2`… suffix.
   */
  async function saveAllToFolder(items: readonly OutputItem[]): Promise<{ status: SaveResult, names: string[] }> {
    const picker = import.meta.client ? (window as unknown as FsWindow).showDirectoryPicker : undefined
    if (!picker) throw new Error('Saving to a folder is not supported in this browser')
    let root: DirHandleLike
    try {
      root = await picker.call(window, { mode: 'readwrite' })
    }
    catch (e) {
      if (isAbort(e)) return { status: 'cancelled', names: [] }
      throw e
    }
    const dirs = new Map<string, { handle: DirHandleLike, taken: Set<string> }>()
    async function dirFor(path: string) {
      let d = dirs.get(path)
      if (d) return d
      let handle = root
      for (const part of path ? path.split('/') : []) handle = await handle.getDirectoryHandle(part, { create: true })
      const taken = new Set<string>()
      for await (const [name] of handle.entries()) taken.add(name)
      d = { handle, taken }
      dirs.set(path, d)
      return d
    }
    const names: string[] = []
    for (const it of items) {
      const slash = it.name.lastIndexOf('/')
      const dirPath = slash >= 0 ? it.name.slice(0, slash) : ''
      const dir = await dirFor(dirPath)
      const name = uniqueName(it.name.slice(slash + 1), dir.taken)
      dir.taken.add(name)
      const fh = await dir.handle.getFileHandle(name, { create: true })
      const w = await fh.createWritable()
      await w.write(it.blob)
      await w.close()
      names.push(dirPath ? `${dirPath}/${name}` : name)
    }
    return { status: 'saved', names }
  }

  /**
   * Zip the items with client-zip (streaming, store-only so nothing is recompressed).
   * Large batches stream to a Save-As writable when available, avoiding one giant in-memory Blob.
   */
  async function downloadZip(items: readonly OutputItem[], zipName = 'toolify.zip'): Promise<SaveResult> {
    const files = uniqueItems(items).map(it => ({ name: it.name, input: it.blob, lastModified: Date.now() }))
    const response = clientZip(files)
    const total = items.reduce((n, it) => n + it.blob.size, 0)
    const picker = import.meta.client ? (window as unknown as FsWindow).showSaveFilePicker : undefined

    if (picker && total > STREAM_ZIP_THRESHOLD && response.body) {
      try {
        const handle = await picker.call(window, {
          suggestedName: zipName,
          types: [{ description: 'ZIP archive', accept: { 'application/zip': ['.zip'] } }],
        })
        const writable = await handle.createWritable()
        await response.body.pipeTo(writable)
        return 'saved'
      }
      catch (e) {
        if (isAbort(e)) return 'cancelled'
        throw e
      }
    }
    const blob = await response.blob()
    download(new Blob([blob], { type: 'application/zip' }), zipName)
    return 'downloaded'
  }

  /** Web Share with files (mobile). Resolves false if sharing is unsupported or cancelled. */
  async function share(items: readonly OutputItem[]): Promise<boolean> {
    if (!import.meta.client || typeof navigator.share !== 'function') return false
    const files = items.map(it => new File([it.blob], it.name, { type: it.blob.type }))
    if (typeof navigator.canShare === 'function' && !navigator.canShare({ files })) return false
    try {
      await navigator.share({ files })
      return true
    }
    catch (e) {
      if (isAbort(e)) return false
      throw e
    }
  }

  return { download, saveAs, saveAllToFolder, downloadZip, share, canSaveToFolder, canShareFiles }
}
