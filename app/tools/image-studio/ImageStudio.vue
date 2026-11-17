<script setup lang="ts">
/**
 * Image Studio: one batch pipeline (resize → convert → optimise) for many images at once.
 * Intake: files, whole folders (picker or drag-and-drop), ZIP/TAR/TAR.GZ archives and paste.
 * Folder structure is kept through to the ZIP / folder output.
 */
import { useLocalStorage } from '@vueuse/core'
import type { ToolMeta } from '~/tools/meta'
import {
  defaultStudioSettings, outputPath, planResize, resolveFormat,
  type FormatChoice, type ResizeFit, type ResizeMode, type StudioJobInput, type StudioJobResult, type StudioSettings,
} from '~/tools/_image-engine/studio'
import { accepts, relativePath } from '~/lib/files'
import { archiveAccepts, extractArchive, isArchive, mimeFromName } from '~/lib/archive'
import { memoryBudgetBytes } from '~/lib/capabilities'
import type { JobMeta } from '~/stores/jobs'
import { studioItems, type StudioItem } from './state'

defineProps<{ meta: ToolMeta }>()

const MAX_ITEMS = 5000
const PAGE_SIZE = 50
const imageAccepts = ['image/*', '.heic', '.heif', '.ico', '.bmp', '.avif', '.jfif']

// ---------------------------------------------------------------------------
// settings (persisted)
// ---------------------------------------------------------------------------

const settings = useLocalStorage<StudioSettings>('toolify:studio', defaultStudioSettings(), {
  mergeDefaults: (stored, defaults) => ({
    ...defaults,
    ...stored,
    resize: { ...defaults.resize, ...stored?.resize },
    target: { ...defaults.target, ...stored?.target },
  }),
})
const output = useLocalStorage('toolify:studio:output', { suffix: '', keepFolders: true }, { mergeDefaults: true })

const capsStore = useCapabilitiesStore()
onMounted(() => { void capsStore.probe() })
const avifSupported = computed(() => capsStore.caps?.nativeEncode.avif ?? false)
watch(avifSupported, (ok) => {
  if (capsStore.caps && !ok && settings.value.format === 'avif') settings.value.format = 'webp'
})

const formatItems = computed(() => [
  { label: 'Keep original format', value: 'same' },
  { label: 'JPEG', value: 'jpeg' },
  { label: 'PNG', value: 'png' },
  { label: 'WebP', value: 'webp' },
  { label: avifSupported.value ? 'AVIF' : 'AVIF (not supported in this browser)', value: 'avif', disabled: !avifSupported.value },
])
const encoderItems = [
  { label: 'Smallest files (MozJPEG / libwebp)', value: 'auto' },
  { label: 'Fastest (browser encoder)', value: 'native' },
]
const modeItems = [
  { label: 'Fit inside', value: 'fit' },
  { label: 'Exact size', value: 'exact' },
  { label: 'Percent', value: 'percent' },
]
const fitItems = [
  { label: 'Crop to fill', value: 'cover' },
  { label: 'Fit with padding', value: 'contain' },
  { label: 'Stretch', value: 'fill' },
]
const sizePresets: { label: string; mode: ResizeMode; width: number | null; height: number | null; fit?: ResizeFit }[] = [
  { label: '4K (3840 px)', mode: 'fit', width: 3840, height: 3840 },
  { label: 'Full HD (1920 px)', mode: 'fit', width: 1920, height: 1920 },
  { label: 'HD (1280 px)', mode: 'fit', width: 1280, height: 1280 },
  { label: 'Web (1024 px)', mode: 'fit', width: 1024, height: 1024 },
  { label: 'Thumbnail (320 px)', mode: 'fit', width: 320, height: 320 },
  { label: 'Square post (1080 × 1080)', mode: 'exact', width: 1080, height: 1080, fit: 'cover' },
  { label: 'Story (1080 × 1920)', mode: 'exact', width: 1080, height: 1920, fit: 'cover' },
  { label: 'Open Graph (1200 × 630)', mode: 'exact', width: 1200, height: 630, fit: 'cover' },
]
const presetMenu = computed(() => [sizePresets.map(p => ({
  label: p.label,
  onSelect: () => {
    const r = settings.value.resize
    Object.assign(r, { enabled: true, mode: p.mode, width: p.width, height: p.height })
    if (p.fit) r.fit = p.fit
  },
}))])

const r = computed(() => settings.value.resize)
const format = computed({
  get: () => settings.value.format,
  set: (v: FormatChoice) => { settings.value.format = v },
})
const lossyPossible = computed(() => format.value !== 'png' && !(format.value === 'webp' && settings.value.lossless))
const showBackground = computed(() => format.value === 'jpeg' || format.value === 'same' || (r.value.enabled && r.value.mode === 'exact' && r.value.fit === 'contain'))
const transparentPad = computed({
  get: () => settings.value.background === 'transparent',
  set: (v: boolean) => { settings.value.background = v ? 'transparent' : '#ffffff' },
})
const bgColor = computed({
  get: () => (settings.value.background === 'transparent' ? '#ffffff' : settings.value.background),
  set: (v: string) => { settings.value.background = v },
})

function resetSettings() {
  settings.value = defaultStudioSettings()
  output.value = { suffix: '', keepFolders: true }
}

// Results become stale when anything that affects pixels/bytes changes.
const settingsKey = computed(() => JSON.stringify(settings.value))

// ---------------------------------------------------------------------------
// items
// ---------------------------------------------------------------------------

const items = studioItems
const skipped = ref<string[]>([])
const intakeError = ref<string | null>(null)
const ingesting = ref(false)
const truncated = ref(false)

const itemKey = (path: string, f: File) => `${path}\u0000${f.size}\u0000${f.lastModified}`

function stem(name: string) {
  const n = name.toLowerCase()
  for (const ext of ['.tar.gz', '.tgz', '.tar', '.zip']) if (n.endsWith(ext)) return name.slice(0, -ext.length)
  return name
}

async function ingest(incoming: File[]) {
  if (!incoming.length) return
  ingesting.value = true
  intakeError.value = null
  const seen = new Set(items.value.map(i => itemKey(i.path, i.file)))
  const next: StudioItem[] = []
  const bad: string[] = []
  const room = () => MAX_ITEMS - items.value.length - next.length
  const push = (file: File, path: string) => {
    const k = itemKey(path, file)
    if (seen.has(k)) return
    if (room() <= 0) {
      truncated.value = true
      return
    }
    seen.add(k)
    next.push({ id: crypto.randomUUID(), file, path })
  }
  try {
    for (const f of incoming) {
      if (room() <= 0) {
        truncated.value = true
        break
      }
      const rel = relativePath(f)
      if (isArchive(f)) {
        try {
          const entries = await extractArchive(f, {
            filter: p => accepts({ name: p, type: mimeFromName(p) }, imageAccepts),
            maxEntries: room(),
          })
          if (!entries.length) bad.push(`${f.name}: no images inside`)
          // Nest under the archive's name unless it already has a single top-level folder.
          const tops = new Set(entries.map(e => e.path.split('/')[0]))
          const single = tops.size === 1 && entries.every(e => e.path.includes('/'))
          const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/') + 1) : ''
          for (const e of entries) push(e.file, `${dir}${single ? '' : `${stem(f.name)}/`}${e.path}`)
        }
        catch (e) {
          bad.push(`${f.name}: ${e instanceof Error ? e.message : 'could not open archive'}`)
        }
      }
      else if (accepts(f, imageAccepts)) push(f, rel)
      else bad.push(rel)
    }
  }
  finally {
    ingesting.value = false
  }
  skipped.value = bad
  if (next.length) items.value = [...items.value, ...next]
}

// Drag-and-drop (incl. folders) anywhere on the studio, plus paste.
const root = ref<HTMLElement | null>(null)
const fileInput = useFileInput({
  dropZone: root,
  launchQueue: true,
  onAdded: (added) => {
    void ingest(added)
    fileInput.clear() // the studio owns de-duplication
  },
})
const isOver = fileInput.isOverDropZone

const filesEl = ref<HTMLInputElement | null>(null)
const folderEl = ref<HTMLInputElement | null>(null)
const acceptAttr = [...imageAccepts, ...archiveAccepts].join(',')
function onPicked(e: Event) {
  const el = e.target as HTMLInputElement
  const list = Array.from(el.files ?? [])
  el.value = ''
  void ingest(list)
}

// ---------------------------------------------------------------------------
// jobs
// ---------------------------------------------------------------------------

const runner = useJobRunner<StudioJobInput, StudioJobResult>('image-studio', {
  createWorker: () => new Worker(new URL('../_image-engine/studio-worker.ts', import.meta.url), { type: 'module', name: 'image-studio' }),
})
const jobsStore = useJobsStore()

type RowStatus = 'ready' | 'stale' | JobMeta['status']
function jobOf(it: StudioItem): JobMeta | undefined {
  return it.jobId ? jobsStore.jobs[it.jobId] : undefined
}
function statusOf(it: StudioItem): RowStatus {
  const j = jobOf(it)
  if (!j) return 'ready'
  if (j.status === 'done' && it.runKey !== settingsKey.value) return 'stale'
  return j.status
}

const maxPixels = computed(() => {
  const caps = capsStore.caps ?? { deviceMemory: 4, isIOS: false }
  return Math.max(memoryBudgetBytes(caps) / 8, 24e6)
})

function submit(it: StudioItem) {
  if (it.jobId) runner.forget(it.jobId)
  const settingsCopy = JSON.parse(settingsKey.value) as StudioSettings
  const { id } = runner.submit(
    { file: it.file, name: it.file.name, settings: settingsCopy, maxPixels: maxPixels.value },
    { label: it.path, bytesIn: it.file.size, priority: 'batch' },
  )
  it.jobId = id
  it.runKey = settingsKey.value
}

const counts = computed(() => {
  const c = { total: items.value.length, ready: 0, stale: 0, queued: 0, running: 0, done: 0, error: 0, cancelled: 0 }
  for (const it of items.value) c[statusOf(it)]++
  return c
})
const active = computed(() => counts.value.queued + counts.value.running)
const todo = computed(() => counts.value.ready + counts.value.stale + counts.value.error + counts.value.cancelled)

function runAll() {
  for (const it of items.value) {
    const s = statusOf(it)
    if (s === 'ready' || s === 'stale' || s === 'error' || s === 'cancelled') submit(it)
  }
  triggerRef(items)
}
function retry(it: StudioItem) {
  submit(it)
  triggerRef(items)
}
function cancelAll() {
  runner.cancelAll()
}
function removeItem(it: StudioItem) {
  if (it.jobId) runner.forget(it.jobId)
  items.value = items.value.filter(x => x !== it)
}
function clearAll() {
  runner.clear()
  items.value = []
  skipped.value = []
  truncated.value = false
  page.value = 1
}
function clearDone() {
  const keep: StudioItem[] = []
  for (const it of items.value) {
    if (statusOf(it) === 'done') runner.forget(it.jobId!)
    else keep.push(it)
  }
  items.value = keep
}

// Overall progress across the current run.
const progress = computed(() => {
  let sum = 0
  let n = 0
  for (const it of items.value) {
    const j = jobOf(it)
    if (!j || it.runKey !== settingsKey.value) continue
    n++
    sum += j.status === 'queued' ? 0 : j.status === 'running' ? j.progress : 1
  }
  return n ? sum / n : 0
})

const totals = computed(() => {
  let inB = 0
  let outB = 0
  for (const it of items.value) {
    const j = jobOf(it)
    if (j?.status === 'done' && j.bytesOut != null) {
      inB += it.file.size
      outB += j.bytesOut
    }
  }
  return { inB, outB, saved: inB ? 1 - outB / inB : 0 }
})
const totalInput = computed(() => items.value.reduce((n, it) => n + it.file.size, 0))

// ---------------------------------------------------------------------------
// output
// ---------------------------------------------------------------------------

const out = useFileOutput()
const toast = useToast()
const saving = ref(false)

function nameFor(it: StudioItem, res: StudioJobResult) {
  return outputPath(it.path, res.format, { suffix: output.value.suffix, keepFolders: output.value.keepFolders })
}
function doneOutputs() {
  const list: { name: string; blob: Blob }[] = []
  for (const it of items.value) {
    if (jobOf(it)?.status !== 'done') continue
    const res = runner.result(it.jobId!)
    if (res) list.push({ name: nameFor(it, res), blob: res.blob })
  }
  return list
}
function downloadOne(it: StudioItem) {
  const res = it.jobId ? runner.result(it.jobId) : undefined
  if (!res) return
  const name = nameFor(it, res)
  out.download(res.blob, name.slice(name.lastIndexOf('/') + 1))
}
async function downloadZip() {
  const list = doneOutputs()
  if (!list.length) return
  saving.value = true
  try {
    const res = await out.downloadZip(list, 'toolify-images.zip')
    if (res !== 'cancelled') toast.add({ title: `Saved ${list.length} images as ZIP`, color: 'success', icon: 'i-lucide-circle-check' })
  }
  catch (e) {
    toast.add({ title: 'Could not create the ZIP', description: e instanceof Error ? e.message : String(e), color: 'error' })
  }
  finally {
    saving.value = false
  }
}
async function saveToFolder() {
  const list = doneOutputs()
  if (!list.length) return
  saving.value = true
  try {
    const res = await out.saveAllToFolder(list)
    if (res.status === 'saved') toast.add({ title: `Saved ${res.names.length} images`, color: 'success', icon: 'i-lucide-circle-check' })
  }
  catch (e) {
    toast.add({ title: 'Could not save to the folder', description: e instanceof Error ? e.message : String(e), color: 'error' })
  }
  finally {
    saving.value = false
  }
}

// ---------------------------------------------------------------------------
// list view
// ---------------------------------------------------------------------------

type Filter = 'all' | 'pending' | 'done' | 'error'
const filter = ref<Filter>('all')
const page = ref(1)
const filterItems = computed(() => [
  { label: `All (${counts.value.total})`, value: 'all' },
  { label: `To do (${todo.value + active.value})`, value: 'pending' },
  { label: `Done (${counts.value.done})`, value: 'done' },
  { label: `Failed (${counts.value.error})`, value: 'error' },
])
const filtered = computed(() => items.value.filter((it) => {
  const s = statusOf(it)
  if (filter.value === 'done') return s === 'done'
  if (filter.value === 'error') return s === 'error'
  if (filter.value === 'pending') return s !== 'done' && s !== 'error'
  return true
}))
watch([filter, () => items.value.length], () => {
  const pages = Math.max(1, Math.ceil(filtered.value.length / PAGE_SIZE))
  if (page.value > pages) page.value = pages
})
const visible = computed(() => filtered.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE))

const statusLabel: Record<RowStatus, string> = {
  ready: 'Ready', stale: 'Settings changed', queued: 'Queued', running: 'Working', done: 'Done', error: 'Failed', cancelled: 'Cancelled',
}
const statusColor = (s: RowStatus) => (s === 'done' ? 'success' : s === 'error' ? 'error' : s === 'stale' ? 'warning' : s === 'running' ? 'primary' : 'neutral')

function resultOf(it: StudioItem) {
  return it.jobId && jobOf(it)?.status === 'done' ? runner.result(it.jobId) : undefined
}

/** Predicted output (before running) so the list is informative straight away. */
function predicted(it: StudioItem) {
  return resolveFormat(settings.value.format, it.file.type, it.file.name).toUpperCase()
}

function bytes(n?: number) {
  if (n == null) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}
function pct(a: number, b: number) {
  if (!a) return ''
  const d = Math.round((1 - b / a) * 100)
  return d >= 0 ? `−${d}%` : `+${-d}%`
}

// ---------------------------------------------------------------------------
// preview
// ---------------------------------------------------------------------------

const previewOpen = ref(false)
const preview = shallowRef<{ before: string; after: string; title: string; res: StudioJobResult } | null>(null)
function openPreview(it: StudioItem) {
  const res = resultOf(it)
  if (!res) return
  closePreviewUrls()
  preview.value = { before: URL.createObjectURL(it.file), after: URL.createObjectURL(res.blob), title: it.path, res }
  previewOpen.value = true
}
function closePreviewUrls() {
  if (!preview.value) return
  URL.revokeObjectURL(preview.value.before)
  URL.revokeObjectURL(preview.value.after)
  preview.value = null
}
watch(previewOpen, (open) => { if (!open) closePreviewUrls() })
onBeforeUnmount(closePreviewUrls)

// Example output size for the settings summary.
const resizeHint = computed(() => {
  if (!r.value.enabled) return 'Original size'
  const p = planResize(4000, 3000, r.value)
  return `e.g. 4000 × 3000 → ${p.width} × ${p.height}`
})
</script>

<template>
  <div ref="root" class="relative mx-auto w-full max-w-7xl space-y-5 p-4 sm:p-6" data-testid="image-studio">
    <!-- Drop overlay -->
    <div
      v-if="isOver"
      class="pointer-events-none absolute inset-2 z-30 grid place-items-center rounded-xl border-2 border-dashed border-primary bg-primary/10 backdrop-blur-sm"
      aria-hidden="true"
    >
      <div class="flex flex-col items-center gap-2 text-primary">
        <UIcon name="i-lucide-folder-open" class="size-10" />
        <p class="font-semibold">Drop images, folders or archives</p>
      </div>
    </div>

    <header class="flex flex-wrap items-end justify-between gap-3">
      <div class="space-y-1">
        <h1 class="text-2xl font-semibold tracking-tight">{{ meta.title }}</h1>
        <p class="text-muted">{{ meta.description }}</p>
      </div>
    </header>

    <div class="grid gap-5 xl:grid-cols-[22rem_minmax(0,1fr)]">
      <!-- ============ Settings ============ -->
      <aside class="grid content-start gap-4 md:grid-cols-2 xl:grid-cols-1 xl:sticky xl:top-4 xl:self-start" aria-label="Processing settings">
        <!-- Resize -->
        <UCard :ui="{ body: 'space-y-4 p-4 sm:p-4' }">
          <div class="flex items-center justify-between gap-2">
            <div class="flex items-center gap-2">
              <UIcon name="i-lucide-scaling" class="size-5 text-primary" aria-hidden="true" />
              <h2 class="font-semibold">Resize</h2>
            </div>
            <USwitch v-model="settings.resize.enabled" aria-label="Resize images" data-testid="resize-toggle" />
          </div>
          <template v-if="r.enabled">
            <UTabs v-model="settings.resize.mode" :items="modeItems" :content="false" size="sm" class="w-full" />
            <div v-if="r.mode !== 'percent'" class="grid grid-cols-2 gap-3">
              <UFormField :label="r.mode === 'fit' ? 'Max width' : 'Width'">
                <UInputNumber v-model="settings.resize.width" :min="1" :max="20000" placeholder="Auto" :increment="false" :decrement="false" class="w-full" data-testid="resize-width" />
              </UFormField>
              <UFormField :label="r.mode === 'fit' ? 'Max height' : 'Height'">
                <UInputNumber v-model="settings.resize.height" :min="1" :max="20000" placeholder="Auto" :increment="false" :decrement="false" class="w-full" data-testid="resize-height" />
              </UFormField>
            </div>
            <UFormField v-else :label="`Scale ${r.percent}%`">
              <USlider v-model="settings.resize.percent" :min="5" :max="200" :step="5" aria-label="Scale percent" />
            </UFormField>
            <UFormField v-if="r.mode === 'exact' && r.width && r.height" label="When the shape differs">
              <USelect v-model="settings.resize.fit" :items="fitItems" class="w-full" />
            </UFormField>
            <USwitch v-if="r.mode !== 'exact'" v-model="settings.resize.noUpscale" label="Never enlarge smaller images" />
            <div class="flex items-center justify-between gap-2">
              <span class="text-xs text-muted">{{ resizeHint }}</span>
              <UDropdownMenu :items="presetMenu">
                <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-ruler" label="Presets" trailing-icon="i-lucide-chevron-down" />
              </UDropdownMenu>
            </div>
          </template>
          <p v-else class="text-sm text-muted">Images keep their dimensions.</p>
        </UCard>

        <!-- Format -->
        <UCard :ui="{ body: 'space-y-4 p-4 sm:p-4' }">
          <div class="flex items-center gap-2">
            <UIcon name="i-lucide-repeat" class="size-5 text-primary" aria-hidden="true" />
            <h2 class="font-semibold">Format</h2>
          </div>
          <UFormField label="Output format">
            <USelect v-model="format" :items="formatItems" class="w-full" data-testid="format" />
          </UFormField>
          <p v-if="format === 'same'" class="text-xs text-muted">HEIC becomes JPEG; GIF, BMP and ICO become PNG.</p>
          <div v-if="showBackground" class="space-y-2">
            <div class="flex items-center justify-between gap-3">
              <label :for="`${meta.slug}-bg`" class="text-sm font-medium">Background</label>
              <input
                :id="`${meta.slug}-bg`"
                v-model="bgColor"
                type="color"
                class="h-8 w-12 cursor-pointer rounded border border-default bg-transparent disabled:opacity-50"
                :disabled="transparentPad && format !== 'jpeg'"
              >
            </div>
            <p class="text-xs text-muted">Fills transparent areas in JPEGs and padding.</p>
            <USwitch v-if="format !== 'jpeg'" v-model="transparentPad" label="Keep padding transparent (PNG/WebP)" />
          </div>
        </UCard>

        <!-- Compression -->
        <UCard :ui="{ body: 'space-y-4 p-4 sm:p-4' }">
          <div class="flex items-center gap-2">
            <UIcon name="i-lucide-gauge" class="size-5 text-primary" aria-hidden="true" />
            <h2 class="font-semibold">Compression</h2>
          </div>
          <UFormField :label="lossyPossible ? `Quality ${settings.quality}` : 'Quality'" :help="lossyPossible ? '75–85 is a good balance for photos.' : 'PNG and lossless WebP keep every pixel.'">
            <USlider v-model="settings.quality" :min="1" :max="100" :disabled="!lossyPossible" aria-label="Quality" data-testid="quality" />
          </UFormField>
          <USwitch v-if="format === 'webp'" v-model="settings.lossless" label="Lossless WebP" />
          <div class="space-y-3 rounded-lg border border-default p-3">
            <USwitch v-model="settings.target.enabled" label="Target file size" description="Lower quality until each image fits." data-testid="target-toggle" />
            <template v-if="settings.target.enabled">
              <div class="flex items-center gap-2">
                <UInputNumber
                  v-model="settings.target.kb"
                  :min="10"
                  :max="50000"
                  :step="50"
                  aria-label="Target size in KB"
                  class="w-36"
                  data-testid="target-kb"
                />
                <span class="text-sm text-muted">KB per image</span>
              </div>
              <div class="flex flex-wrap gap-1">
                <UButton
                  v-for="p in [100, 250, 500, 1000, 2000]"
                  :key="p"
                  size="xs"
                  :color="settings.target.kb === p ? 'primary' : 'neutral'"
                  :variant="settings.target.kb === p ? 'soft' : 'outline'"
                  :label="p >= 1000 ? `${p / 1000} MB` : `${p} KB`"
                  @click="settings.target.kb = p"
                />
              </div>
              <USwitch v-model="settings.target.allowDownscale" label="Shrink dimensions if needed" />
              <p class="text-xs text-muted">
                {{ lossyPossible ? 'Uses the highest quality that fits, up to the quality above.' : 'PNG and lossless WebP can only get smaller by shrinking dimensions.' }}
              </p>
            </template>
          </div>
          <UFormField label="Encoder">
            <USelect v-model="settings.encoder" :items="encoderItems" class="w-full" data-testid="encoder" />
          </UFormField>
          <USwitch v-model="settings.keepIfLarger" label="Keep the original if it's already smaller" />
        </UCard>

        <!-- Output -->
        <UCard :ui="{ body: 'space-y-4 p-4 sm:p-4' }">
          <div class="flex items-center gap-2">
            <UIcon name="i-lucide-folder-tree" class="size-5 text-primary" aria-hidden="true" />
            <h2 class="font-semibold">Output</h2>
          </div>
          <UFormField label="File name suffix" help="e.g. -min → photo-min.jpg">
            <UInput v-model="output.suffix" placeholder="none" class="w-full" />
          </UFormField>
          <USwitch v-model="output.keepFolders" label="Keep folder structure" />
          <UButton size="sm" color="neutral" variant="ghost" icon="i-lucide-rotate-ccw" label="Reset settings" @click="resetSettings" />
        </UCard>
      </aside>

      <!-- ============ Intake + queue ============ -->
      <section class="min-w-0 space-y-4" aria-label="Images">
        <input ref="filesEl" type="file" multiple :accept="acceptAttr" class="sr-only" tabindex="-1" aria-hidden="true" data-testid="file-input" @change="onPicked">
        <input ref="folderEl" type="file" multiple webkitdirectory class="sr-only" tabindex="-1" aria-hidden="true" data-testid="folder-input" @change="onPicked">

        <div
          class="rounded-xl border border-dashed border-accented bg-elevated/40 transition-colors"
          :class="[isOver && 'border-primary bg-primary/5', items.length ? 'p-4' : 'px-4 py-10']"
        >
          <div class="flex flex-col items-center gap-3 text-center" :class="items.length ? 'sm:flex-row sm:text-left' : ''">
            <UIcon
              :name="ingesting ? 'i-lucide-loader-circle' : 'i-lucide-images'"
              class="size-9 shrink-0 text-muted"
              :class="ingesting && 'animate-spin motion-reduce:animate-none'"
              aria-hidden="true"
            />
            <div class="min-w-0 flex-1 space-y-1">
              <p class="font-medium text-highlighted">
                {{ ingesting ? 'Reading files…' : items.length ? 'Add more images' : 'Drop images, a folder or an archive' }}
              </p>
              <p class="text-xs text-muted">
                JPG, PNG, WebP, AVIF, GIF, BMP, ICO, HEIC · folders · ZIP, TAR, TAR.GZ · up to {{ MAX_ITEMS.toLocaleString() }} images. Files stay on your device.
              </p>
            </div>
            <div class="flex flex-wrap justify-center gap-2">
              <UButton icon="i-lucide-file-image" label="Add files" :disabled="ingesting" data-testid="add-files" @click="filesEl?.click()" />
              <UButton icon="i-lucide-folder-up" label="Add folder" color="neutral" variant="outline" :disabled="ingesting" data-testid="add-folder" @click="folderEl?.click()" />
            </div>
          </div>
        </div>

        <UAlert
          v-if="skipped.length || truncated || intakeError"
          color="warning"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          :title="truncated ? `Only the first ${MAX_ITEMS.toLocaleString()} images were added` : `${skipped.length} ${skipped.length === 1 ? 'file was' : 'files were'} skipped`"
          :close="true"
          role="alert"
          data-testid="skipped"
          @update:open="() => { skipped = []; truncated = false; intakeError = null }"
        >
          <template v-if="skipped.length" #description>
            <details>
              <summary class="cursor-pointer">Show details</summary>
              <ul class="mt-1 max-h-40 list-disc overflow-y-auto pl-5">
                <li v-for="m in skipped.slice(0, 200)" :key="m">{{ m }}</li>
                <li v-if="skipped.length > 200">…and {{ skipped.length - 200 }} more</li>
              </ul>
            </details>
          </template>
        </UAlert>

        <template v-if="items.length">
          <!-- Summary + actions -->
          <UCard :ui="{ body: 'space-y-3 p-4 sm:p-4' }">
            <div class="flex flex-wrap items-center justify-between gap-3">
              <dl class="flex flex-wrap gap-x-6 gap-y-1 text-sm">
                <div>
                  <dt class="text-muted">Images</dt>
                  <dd class="font-semibold" data-testid="count">{{ counts.total.toLocaleString() }} · {{ bytes(totalInput) }}</dd>
                </div>
                <div>
                  <dt class="text-muted">Done</dt>
                  <dd class="font-semibold" data-testid="done-count">{{ counts.done.toLocaleString() }}<span v-if="counts.error" class="text-error"> · {{ counts.error }} failed</span></dd>
                </div>
                <div v-if="counts.done">
                  <dt class="text-muted">Size</dt>
                  <dd class="font-semibold">
                    {{ bytes(totals.inB) }} → {{ bytes(totals.outB) }}
                    <span :class="totals.saved >= 0 ? 'text-success' : 'text-warning'">{{ pct(totals.inB, totals.outB) }}</span>
                  </dd>
                </div>
              </dl>
              <div class="flex flex-wrap gap-2">
                <UButton v-if="active" icon="i-lucide-square" color="neutral" variant="outline" label="Cancel" @click="cancelAll" />
                <UButton
                  v-if="todo"
                  icon="i-lucide-play"
                  :label="counts.done || counts.stale ? `Process ${todo.toLocaleString()} ${todo === 1 ? 'image' : 'images'}` : `Process ${todo.toLocaleString()}`"
                  data-testid="run"
                  @click="runAll"
                />
                <UButton
                  v-if="counts.done"
                  icon="i-lucide-file-archive"
                  :label="`Download ZIP (${counts.done.toLocaleString()})`"
                  :color="todo || active ? 'neutral' : 'primary'"
                  :variant="todo || active ? 'outline' : 'solid'"
                  :loading="saving"
                  data-testid="download-zip"
                  @click="downloadZip"
                />
                <UButton v-if="counts.done && out.canSaveToFolder.value" icon="i-lucide-folder-down" color="neutral" variant="outline" label="Save to folder" :disabled="saving" @click="saveToFolder" />
                <UDropdownMenu
                  :items="[[
                    { label: 'Remove finished', icon: 'i-lucide-list-checks', disabled: !counts.done, onSelect: clearDone },
                    { label: 'Remove all', icon: 'i-lucide-trash-2', color: 'error', onSelect: clearAll },
                  ]]"
                >
                  <UButton icon="i-lucide-ellipsis" color="neutral" variant="ghost" aria-label="More actions" />
                </UDropdownMenu>
              </div>
            </div>
            <UProgress v-if="active || (progress > 0 && progress < 1)" :model-value="progress * 100" :max="100" size="sm" aria-label="Batch progress" />
            <p v-if="counts.stale && !active" class="text-xs text-warning">Settings changed since the last run. Process again to apply them.</p>
          </UCard>

          <!-- Filter + list -->
          <div class="flex flex-wrap items-center justify-between gap-2">
            <UTabs v-model="filter" :items="filterItems" :content="false" size="sm" variant="pill" :ui="{ list: 'overflow-x-auto', trigger: 'shrink-0' }" />
          </div>

          <ul class="divide-y divide-default overflow-hidden rounded-lg border border-default" data-testid="queue">
            <li v-for="it in visible" :key="it.id" class="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 sm:flex-nowrap" data-testid="item">
              <div class="min-w-0 flex-1">
                <p class="truncate text-sm font-medium" :title="it.path">{{ it.path }}</p>
                <p class="truncate text-xs text-muted">
                  <template v-if="resultOf(it)">
                    {{ resultOf(it)!.srcWidth }}×{{ resultOf(it)!.srcHeight }} → {{ resultOf(it)!.width }}×{{ resultOf(it)!.height }} {{ resultOf(it)!.format.toUpperCase() }}
                    · {{ bytes(it.file.size) }} → {{ bytes(resultOf(it)!.bytesOut) }}
                    <span :class="resultOf(it)!.bytesOut <= it.file.size ? 'text-success' : 'text-warning'">{{ pct(it.file.size, resultOf(it)!.bytesOut) }}</span>
                    <span v-if="resultOf(it)!.warnings.length" :title="resultOf(it)!.warnings.join('\n')"> · {{ resultOf(it)!.warnings[0] }}</span>
                  </template>
                  <template v-else-if="jobOf(it)?.status === 'error'">
                    <span class="text-error" data-testid="error">{{ jobOf(it)!.error }}</span>
                  </template>
                  <template v-else>
                    {{ bytes(it.file.size) }} → {{ predicted(it) }}
                  </template>
                </p>
                <UProgress v-if="jobOf(it)?.status === 'running'" :model-value="(jobOf(it)!.progress || 0) * 100" size="xs" class="mt-1" />
              </div>
              <UBadge v-if="resultOf(it)" variant="subtle" color="neutral" size="sm" data-testid="path">{{ resultOf(it)!.path }}</UBadge>
              <UBadge :color="statusColor(statusOf(it))" variant="soft" size="sm" data-testid="status">{{ statusLabel[statusOf(it)] }}</UBadge>
              <div class="flex shrink-0 items-center gap-1">
                <UButton v-if="resultOf(it)" size="sm" color="neutral" variant="ghost" icon="i-lucide-eye" aria-label="Compare before and after" @click="openPreview(it)" />
                <UButton v-if="resultOf(it)" size="sm" color="neutral" variant="ghost" icon="i-lucide-download" aria-label="Download" @click="downloadOne(it)" />
                <UButton v-if="statusOf(it) === 'error' || statusOf(it) === 'cancelled'" size="sm" color="neutral" variant="ghost" icon="i-lucide-rotate-ccw" aria-label="Retry" @click="retry(it)" />
                <UButton
                  v-if="statusOf(it) === 'queued' || statusOf(it) === 'running'"
                  size="sm" color="neutral" variant="ghost" icon="i-lucide-x" aria-label="Cancel"
                  @click="runner.cancel(it.jobId!)"
                />
                <UButton v-else size="sm" color="neutral" variant="ghost" icon="i-lucide-trash-2" aria-label="Remove" @click="removeItem(it)" />
              </div>
            </li>
            <li v-if="!visible.length" class="px-3 py-6 text-center text-sm text-muted">Nothing here.</li>
          </ul>

          <div v-if="filtered.length > PAGE_SIZE" class="flex justify-center">
            <UPagination v-model:page="page" :total="filtered.length" :items-per-page="PAGE_SIZE" />
          </div>
        </template>

        <UEmpty
          v-else
          icon="i-lucide-layers"
          title="Resize, convert and optimise in one pass"
          description="Set up the pipeline on the left, add as many images as you like, then process them all at once and download a ZIP."
          variant="naked"
        />
      </section>
    </div>

    <UModal v-model:open="previewOpen" :title="preview?.title ?? 'Preview'" :description="preview ? `${preview.res.srcWidth}×${preview.res.srcHeight} → ${preview.res.width}×${preview.res.height} · ${bytes(preview.res.bytesIn)} → ${bytes(preview.res.bytesOut)}` : undefined" :ui="{ content: 'sm:max-w-4xl' }">
      <template #body>
        <ToolBeforeAfter v-if="preview" :before="preview.before" :after="preview.after" before-label="Original" :after-label="preview.res.format.toUpperCase()" />
      </template>
    </UModal>
  </div>
</template>
