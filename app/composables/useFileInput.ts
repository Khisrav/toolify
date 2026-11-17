/**
 * Normalises every way a tool can receive files into one reactive `File[]`:
 * drag-and-drop (including folders), paste, and the PWA Launch Queue (file handlers).
 * Nothing is uploaded; files stay in memory as `File` objects.
 */
import { ref, shallowRef, toValue, type MaybeRefOrGetter, type Ref } from 'vue'
import { tryOnMounted, tryOnScopeDispose } from '@vueuse/core'
import { accepts, collectDroppedFiles, dedupeFiles, type RejectedFile } from '~/lib/files'

export { accepts } from '~/lib/files'
export type { RejectedFile } from '~/lib/files'

interface LaunchParamsLike {
  files?: readonly { getFile: () => Promise<File> }[]
}
interface LaunchQueueLike {
  setConsumer: (consumer: (params: LaunchParamsLike) => void) => void
}

export interface UseFileInputOptions {
  /** MIME types, MIME globs (`image/*`) and extensions (`.heic`). Empty = accept all. */
  accept?: MaybeRefOrGetter<readonly string[]>
  /** Keep a list (true, default) or only the latest file (false). */
  multiple?: MaybeRefOrGetter<boolean>
  /** Element that receives drops. Without it, drag-and-drop is not wired. */
  dropZone?: Ref<HTMLElement | null | undefined>
  /** Listen for clipboard files while mounted. Default true. */
  paste?: boolean
  /** Consume PWA launch-queue files. Default true. */
  launchQueue?: boolean
  /** Called with the newly accepted (non-duplicate) files after every add. */
  onAdded?: (files: File[]) => void
}

export interface UseFileInputReturn {
  files: Ref<File[]>
  /** Add files (filtered by `accept`, deduped). Returns the files actually added. */
  add: (incoming: Iterable<File> | ArrayLike<File>) => File[]
  remove: (index: number) => void
  clear: () => void
  rejected: Ref<RejectedFile[]>
  isOverDropZone: Ref<boolean>
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag === 'INPUT') {
    const type = (target as HTMLInputElement).type
    // File/checkbox/button inputs don't take pasted text; ignore only text-like ones.
    return !['file', 'checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'image'].includes(type)
  }
  return false
}

export function useFileInput(options: UseFileInputOptions = {}): UseFileInputReturn {
  const files = shallowRef<File[]>([]) as Ref<File[]>
  const rejected = ref<RejectedFile[]>([])
  const isOverDropZone = ref(false)

  function add(incoming: Iterable<File> | ArrayLike<File>): File[] {
    const list = Array.from(incoming as ArrayLike<File>)
    const acceptList = toValue(options.accept) ?? []
    const ok: File[] = []
    const bad: RejectedFile[] = []
    for (const f of list) {
      if (accepts(f, acceptList)) ok.push(f)
      else bad.push({ name: f.name, reason: f.type ? `Unsupported type (${f.type})` : 'Unsupported file type' })
    }
    rejected.value = bad
    if (ok.length === 0) return []
    const multiple = toValue(options.multiple) ?? true
    if (!multiple) {
      const next = ok.slice(0, 1)
      files.value = next
      options.onAdded?.(next)
      return next
    }
    const { merged, added } = dedupeFiles(files.value, ok)
    files.value = merged
    if (added.length) options.onAdded?.(added)
    return added
  }

  function remove(index: number) {
    if (index < 0 || index >= files.value.length) return
    files.value = files.value.filter((_, i) => i !== index)
  }

  function clear() {
    files.value = []
    rejected.value = []
  }

  if (import.meta.client) {
    const cleanups: Array<() => void> = []
    const listen = <K extends keyof HTMLElementEventMap>(el: EventTarget, type: K | string, fn: (e: Event) => void) => {
      el.addEventListener(type, fn)
      cleanups.push(() => el.removeEventListener(type, fn))
    }

    // --- drag-and-drop (own implementation: VueUse's useDropZone can't read folders) ---
    let dragDepth = 0
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files')
    const bindDrop = (el: HTMLElement) => {
      listen(el, 'dragenter', (e) => {
        const ev = e as DragEvent
        if (!hasFiles(ev)) return
        ev.preventDefault()
        dragDepth++
        isOverDropZone.value = true
      })
      listen(el, 'dragover', (e) => {
        const ev = e as DragEvent
        if (!hasFiles(ev)) return
        ev.preventDefault()
        if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy'
      })
      listen(el, 'dragleave', (e) => {
        if (!hasFiles(e as DragEvent)) return
        dragDepth = Math.max(0, dragDepth - 1)
        if (dragDepth === 0) isOverDropZone.value = false
      })
      listen(el, 'drop', (e) => {
        const ev = e as DragEvent
        if (!hasFiles(ev) || !ev.dataTransfer) return
        ev.preventDefault()
        dragDepth = 0
        isOverDropZone.value = false
        void collectDroppedFiles(ev.dataTransfer).then(add)
      })
    }

    // --- paste ---
    if (options.paste !== false) {
      listen(window, 'paste', (e) => {
        const ev = e as ClipboardEvent
        if (isEditable(ev.target)) return
        const pasted = Array.from(ev.clipboardData?.files ?? [])
        if (pasted.length === 0) return
        ev.preventDefault()
        add(pasted)
      })
    }

    // --- launch queue (file_handlers) ---
    if (options.launchQueue !== false) {
      const lq = (window as unknown as { launchQueue?: LaunchQueueLike }).launchQueue
      lq?.setConsumer((params) => {
        const handles = params.files ?? []
        if (handles.length === 0) return
        void Promise.all(handles.map(h => h.getFile())).then(add).catch(() => {
          rejected.value = [{ name: '', reason: 'Could not open the launched file' }]
        })
      })
    }

    tryOnMounted(() => {
      if (options.dropZone?.value) bindDrop(options.dropZone.value)
    })
    tryOnScopeDispose(() => {
      cleanups.forEach(fn => fn())
      cleanups.length = 0
      isOverDropZone.value = false
    })
  }

  return { files, add, remove, clear, rejected, isOverDropZone: isOverDropZone }
}
