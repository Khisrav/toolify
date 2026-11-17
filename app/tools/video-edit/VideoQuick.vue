<script setup lang="ts">
/**
 * Video quick actions: one file in, one file out. Trim, resize, compress, convert,
 * extract audio and add/replace audio all edit the same settings, so they combine freely.
 */
import { useEventListener, useLocalStorage } from '@vueuse/core'
import { canEncodeVideo } from 'mediabunny'
import type { ToolMeta } from '~/tools/meta'
import {
  applyQuickAction, copyableAudio, defaultVideoSettings, formatTime, needsVideoTranscode, parseTime, planResize, planTargetBitrate,
  rotatedSize, suggestShortSide, TEMP_DIR, trimRange,
  type MediaInfo, type QuickAction, type ResizePreset, type VideoJobInput, type VideoJobResult, type VideoSettings,
} from '~/tools/_video-engine/video'
import { filmstrip, hasWebCodecs, probeMedia } from '~/tools/_video-engine/probe'
import { isCancelled } from '~/workers/types'
import { videoSession } from './state'

const props = defineProps<{ meta: ToolMeta, initialAction?: QuickAction }>()

const videoAccepts = ['video/*', 'audio/*', '.mp4', '.m4v', '.mov', '.webm', '.mkv', '.ts', '.mp3', '.m4a', '.wav', '.ogg', '.opus', '.flac', '.aac']
const audioAccepts = ['audio/*', 'video/*', '.mp3', '.m4a', '.wav', '.ogg', '.opus', '.flac', '.aac', '.mp4', '.webm', '.mkv']

// ---------------------------------------------------------------------------
// settings (persisted, except the per-file trim range)
// ---------------------------------------------------------------------------

const settings = useLocalStorage<VideoSettings>('toolify:video', defaultVideoSettings(), {
  mergeDefaults: (stored, defaults) => ({
    ...defaults,
    ...stored,
    trim: { ...defaults.trim, precise: stored?.trim?.precise ?? false },
    resize: { ...defaults.resize, ...stored?.resize },
  }),
})
const s = settings

const action = ref<QuickAction | null>(props.initialAction ?? null)
const actions: { id: QuickAction, label: string, icon: string, hint: string }[] = [
  { id: 'trim', label: 'Trim', icon: 'i-lucide-scissors', hint: 'Keep only part of the video' },
  { id: 'compress', label: 'Compress', icon: 'i-lucide-minimize-2', hint: 'Make the file smaller' },
  { id: 'resize', label: 'Resize', icon: 'i-lucide-scaling', hint: 'Change resolution, rotate or flip' },
  { id: 'convert', label: 'Convert', icon: 'i-lucide-repeat', hint: 'MP4, WebM, MKV or MOV' },
  { id: 'extract-audio', label: 'Extract audio', icon: 'i-lucide-music', hint: 'Save the soundtrack as MP3, M4A, WAV or OGG' },
  { id: 'add-audio', label: 'Add audio', icon: 'i-lucide-audio-lines', hint: 'Replace or add a soundtrack' },
]
function choose(a: QuickAction) {
  action.value = a
  settings.value = applyQuickAction(settings.value, a, info.value ?? undefined)
  nextTick(() => document.getElementById(`video-section-${sectionFor(a)}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }))
}
function sectionFor(a: QuickAction) {
  return a === 'trim' ? 'trim' : a === 'compress' ? 'quality' : a === 'resize' ? 'resize' : a === 'add-audio' ? 'audio' : 'output'
}

function resetSettings() {
  const trim = settings.value.trim
  settings.value = { ...defaultVideoSettings(), trim: { ...trim, enabled: false } }
  action.value = null
}

const containerItems = [
  { label: 'MP4 (plays everywhere)', value: 'mp4' },
  { label: 'WebM', value: 'webm' },
  { label: 'MKV', value: 'mkv' },
  { label: 'MOV (Apple)', value: 'mov' },
]
const audioContainerItems = [
  { label: 'Original (no re-encode)', value: 'auto' },
  { label: 'MP3', value: 'mp3' },
  { label: 'M4A (AAC)', value: 'm4a' },
  { label: 'WAV (uncompressed)', value: 'wav' },
  { label: 'OGG (Opus)', value: 'ogg' },
]
const qualityItems = computed(() => [
  { label: 'Original', value: 'original', description: 'No re-encode when possible: fastest, no quality loss.' },
  { label: 'High', value: 'high', description: 'Visually close to the original.' },
  { label: 'Medium', value: 'medium', description: 'Good balance of size and quality.' },
  { label: 'Low', value: 'low', description: 'Smallest files; visible softening.' },
  { label: 'Target size', value: 'target', description: 'Pick the file size; the bitrate is worked out for you.' },
])
const presetItems = [
  { label: '4K (2160p)', value: 2160 },
  { label: '1440p', value: 1440 },
  { label: 'Full HD (1080p)', value: 1080 },
  { label: 'HD (720p)', value: 720 },
  { label: 'SD (480p)', value: 480 },
  { label: '360p', value: 360 },
  { label: 'Custom size', value: 'custom' },
]
const fitItems = [
  { label: 'Fit with black bars', value: 'contain' },
  { label: 'Crop to fill', value: 'cover' },
  { label: 'Stretch', value: 'fill' },
]
const fpsItems = [
  { label: 'Same as source', value: 0 },
  { label: '60 fps', value: 60 },
  { label: '30 fps', value: 30 },
  { label: '25 fps', value: 25 },
  { label: '24 fps', value: 24 },
  { label: '15 fps', value: 15 },
]
const fps = computed({
  get: () => s.value.fps ?? 0,
  set: (v: number) => { s.value.fps = v ? v : null },
})
const audioModeItems = [
  { label: 'Keep', value: 'keep' },
  { label: 'Remove', value: 'remove' },
  { label: 'Replace', value: 'replace' },
]

// Encoders this browser really has (probed once; labels say what's missing).
const encodable = ref<Record<string, boolean>>({})
async function probeEncoders() {
  const out: Record<string, boolean> = {}
  await Promise.all(['avc', 'hevc', 'vp9', 'av1', 'vp8'].map(async (c) => {
    out[c] = await canEncodeVideo(c as 'avc', { width: 1280, height: 720 }).catch(() => false)
  }))
  encodable.value = out
}
const codecItems = computed(() => {
  const names: Record<string, string> = { avc: 'H.264', hevc: 'H.265 / HEVC', vp9: 'VP9', av1: 'AV1', vp8: 'VP8' }
  const per: Record<string, string[]> = { mp4: ['avc', 'hevc', 'av1', 'vp9'], mov: ['avc', 'hevc'], webm: ['vp9', 'av1', 'vp8'], mkv: ['avc', 'hevc', 'vp9', 'av1', 'vp8'] }
  return [
    { label: 'Automatic', value: 'auto', disabled: false },
    ...per[s.value.container]!.map(c => ({
      label: encodable.value[c] === false ? `${names[c]} (not supported here)` : names[c]!,
      value: c,
      disabled: encodable.value[c] === false,
    })),
  ]
})
watch(() => s.value.container, () => {
  if (s.value.videoCodec !== 'auto' && !codecItems.value.some(i => i.value === s.value.videoCodec && !i.disabled)) s.value.videoCodec = 'auto'
})

// ---------------------------------------------------------------------------
// input file
// ---------------------------------------------------------------------------

const supported = ref(true)
const file = shallowRef<File | null>(null)
const info = ref<MediaInfo | null>(null)
const loading = ref(false)
const loadError = ref<string | null>(null)
const sourceUrl = ref<string | null>(null)
const thumbs = ref<string[]>([])
let thumbAbort: AbortController | null = null
const fileEl = ref<HTMLInputElement | null>(null)

onMounted(() => {
  supported.value = hasWebCodecs()
  if (supported.value) void probeEncoders()
})

function revokeThumbs() {
  thumbAbort?.abort()
  for (const u of thumbs.value) URL.revokeObjectURL(u)
  thumbs.value = []
}

async function load(f: File) {
  clearResult()
  revokeThumbs()
  if (sourceUrl.value) URL.revokeObjectURL(sourceUrl.value)
  file.value = f
  info.value = null
  loadError.value = null
  loading.value = true
  sourceUrl.value = URL.createObjectURL(f)
  try {
    const i = await probeMedia(f)
    if (!i.hasVideo && !i.hasAudio) throw new Error('This file has no audio or video tracks.')
    info.value = i
    s.value.trim = { ...s.value.trim, enabled: action.value === 'trim', start: 0, end: i.duration }
    if (!i.hasVideo) s.value.output = 'audio'
    if (i.hasVideo && !i.canDecodeVideo) loadError.value = `This browser can't decode ${i.videoCodec ?? 'this'} video. Try Chrome or Edge, or convert the file elsewhere first.`
    if (i.hasVideo && i.canDecodeVideo) {
      thumbAbort = new AbortController()
      const signal = thumbAbort.signal
      void filmstrip(f, i.duration, 12, 54, signal).then((urls) => {
        if (signal.aborted) urls.forEach(u => URL.revokeObjectURL(u))
        else thumbs.value = urls
      })
    }
  }
  catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e)
  }
  finally {
    loading.value = false
  }
}

function onFiles(list: File[]) {
  const f = list[0]
  if (f) void load(f)
}
function onPicked(ev: Event) {
  const el = ev.target as HTMLInputElement
  if (el.files?.length) onFiles([...el.files])
  el.value = ''
}

onBeforeUnmount(() => {
  revokeThumbs()
  if (sourceUrl.value) URL.revokeObjectURL(sourceUrl.value)
  clearResult()
})

const isVideoOut = computed(() => s.value.output === 'video')
const hasVideo = computed(() => info.value?.hasVideo ?? false)

// ---------------------------------------------------------------------------
// preview + trim
// ---------------------------------------------------------------------------

const player = ref<HTMLVideoElement | null>(null)
const playhead = ref(0)
let stopAt: number | null = null

const duration = computed(() => info.value?.duration ?? 0)
const range = computed({
  get: () => [s.value.trim.start, s.value.trim.end || duration.value],
  set: (v: number[]) => {
    const [a = 0, b = duration.value] = v
    if (a !== s.value.trim.start) seek(a)
    else if (b !== s.value.trim.end) seek(b)
    s.value.trim.start = a
    s.value.trim.end = b
    s.value.trim.enabled = true
  },
})
const trimmed = computed(() => trimRange(s.value.trim, duration.value))
const outDuration = computed(() => trimmed.value.end - trimmed.value.start)

function seek(t: number) {
  if (player.value) player.value.currentTime = t
}
function onTimeUpdate() {
  const p = player.value
  if (!p) return
  playhead.value = p.currentTime
  if (stopAt !== null && p.currentTime >= stopAt) {
    p.pause()
    stopAt = null
  }
}
function setStart() {
  s.value.trim.enabled = true
  s.value.trim.start = Math.min(playhead.value, (s.value.trim.end || duration.value) - 0.1)
}
function setEnd() {
  s.value.trim.enabled = true
  s.value.trim.end = Math.max(playhead.value, s.value.trim.start + 0.1)
}
function playSelection() {
  const p = player.value
  if (!p) return
  p.currentTime = trimmed.value.start
  stopAt = trimmed.value.end
  void p.play()
}

// Text inputs for exact times.
const startText = ref('')
const endText = ref('')
watch(() => [s.value.trim.start, s.value.trim.end], () => {
  startText.value = formatTime(s.value.trim.start)
  endText.value = formatTime(s.value.trim.end || duration.value)
}, { immediate: true })
function commitTime(which: 'start' | 'end') {
  const v = parseTime(which === 'start' ? startText.value : endText.value)
  if (v === null) {
    startText.value = formatTime(s.value.trim.start)
    endText.value = formatTime(s.value.trim.end || duration.value)
    return
  }
  const clamped = Math.min(Math.max(0, v), duration.value)
  s.value.trim.enabled = true
  if (which === 'start') s.value.trim.start = Math.min(clamped, (s.value.trim.end || duration.value) - 0.1)
  else s.value.trim.end = Math.max(clamped, s.value.trim.start + 0.1)
}

// ---------------------------------------------------------------------------
// resize / quality planning
// ---------------------------------------------------------------------------

const srcSize = computed(() => info.value ? rotatedSize(info.value.width, info.value.height, s.value.rotate) : null)
const outSize = computed(() => {
  if (!srcSize.value) return null
  const p = planResize(srcSize.value.width, srcSize.value.height, s.value.resize)
  return p ?? srcSize.value
})
const presetNoop = computed(() => {
  const r = s.value.resize
  return !!srcSize.value && r.enabled && r.preset !== 'custom' && r.preset >= Math.min(srcSize.value.width, srcSize.value.height)
})
const preset = computed({
  get: () => s.value.resize.preset,
  set: (v: ResizePreset) => { s.value.resize.preset = v },
})
function rotate(by: 90 | -90) {
  s.value.rotate = (((s.value.rotate + by) % 360 + 360) % 360) as VideoSettings['rotate']
}

const targetPlan = computed(() => {
  if (s.value.quality !== 'target' || !outDuration.value) return null
  const hasAudio = isVideoOut.value ? (s.value.audio === 'keep' ? !!info.value?.hasAudio : s.value.audio === 'replace') : true
  const plan = planTargetBitrate(outDuration.value, s.value.targetMB, hasAudio)
  const size = outSize.value
  const suggest = isVideoOut.value && size ? suggestShortSide(plan.video, size.width, size.height, info.value?.fps ?? 30) : null
  return { ...plan, suggest }
})
function applySuggestion(side: number) {
  s.value.resize = { ...s.value.resize, enabled: true, preset: side as ResizePreset }
}
const kbps = (bps: number) => (bps >= 1_000_000 ? `${(bps / 1_000_000).toFixed(1)} Mbit/s` : `${Math.round(bps / 1000)} kbit/s`)

const willReencode = computed(() => {
  if (!info.value) return false
  if (!isVideoOut.value) return s.value.quality !== 'original' || s.value.audioContainer !== 'auto'
  return needsVideoTranscode(s.value, info.value.width, info.value.height, info.value.videoCodec)
    || (s.value.audio === 'keep' && info.value.hasAudio && !copyableAudio(s.value.container, info.value.audioCodec))
})

// ---------------------------------------------------------------------------
// replacement audio
// ---------------------------------------------------------------------------

const audioFile = shallowRef<File | null>(null)
const audioInfo = ref<MediaInfo | null>(null)
const audioError = ref<string | null>(null)
const audioEl = ref<HTMLInputElement | null>(null)
async function onAudioPicked(ev: Event) {
  const el = ev.target as HTMLInputElement
  const f = el.files?.[0]
  el.value = ''
  if (!f) return
  audioError.value = null
  try {
    const i = await probeMedia(f)
    if (!i.hasAudio) throw new Error('That file has no audio track.')
    audioFile.value = f
    audioInfo.value = i
  }
  catch (e) {
    audioError.value = e instanceof Error ? e.message : String(e)
  }
}
function clearAudio() {
  audioFile.value = null
  audioInfo.value = null
}

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------

const runner = useJobRunner<VideoJobInput, VideoJobResult>('video', {
  createWorker: () => new Worker(new URL('../_video-engine/video-worker.ts', import.meta.url), { type: 'module', name: 'video' }),
  heavy: true,
})
const jobId = ref<string | null>(null)
const job = computed(() => (jobId.value ? runner.jobs.value.find(j => j.id === jobId.value) : undefined))
const running = computed(() => job.value?.status === 'queued' || job.value?.status === 'running')
const result = shallowRef<VideoJobResult | null>(null)
const resultUrl = ref<string | null>(null)
const exportError = ref<string | null>(null)
const startedAt = ref(0)
const now = ref(Date.now())
let clock: ReturnType<typeof setInterval> | undefined

const blockers = computed(() => {
  const list: string[] = []
  if (!info.value) return ['Choose a file first.']
  if (loadError.value) list.push(loadError.value)
  if (isVideoOut.value && !hasVideo.value) list.push('This file has no video. Choose "Audio only" to export its sound.')
  if (!isVideoOut.value && !info.value.hasAudio) list.push('This file has no audio track.')
  if (isVideoOut.value && s.value.audio === 'replace' && !audioFile.value) list.push('Choose the audio file to add.')
  return list
})

const summary = computed(() => {
  if (!info.value) return ''
  const parts: string[] = []
  if (s.value.trim.enabled) parts.push(`${formatTime(trimmed.value.start, 1)}–${formatTime(trimmed.value.end, 1)}`)
  if (isVideoOut.value) {
    parts.push(s.value.container.toUpperCase())
    if (outSize.value && (s.value.resize.enabled || s.value.rotate)) parts.push(`${outSize.value.width}×${outSize.value.height}`)
    if (s.value.audio === 'remove') parts.push('no audio')
    if (s.value.audio === 'replace') parts.push('new audio')
  }
  else {
    parts.push(s.value.audioContainer === 'auto' ? 'audio (original codec)' : s.value.audioContainer.toUpperCase())
  }
  parts.push(s.value.quality === 'target' ? `~${s.value.targetMB} MB` : `${s.value.quality} quality`)
  return parts.join(' · ')
})

let wakeLock: { release: () => Promise<void> } | null = null
async function holdWakeLock(on: boolean) {
  try {
    if (on) wakeLock = await (navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } }).wakeLock?.request('screen') ?? null
    else {
      await wakeLock?.release()
      wakeLock = null
    }
  }
  catch { /* not available or denied */ }
}

async function deleteTemp(name: string | null) {
  if (!name) return
  try {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(TEMP_DIR)
    await dir.removeEntry(name)
  }
  catch { /* already gone */ }
}

function clearResult() {
  if (resultUrl.value) URL.revokeObjectURL(resultUrl.value)
  resultUrl.value = null
  if (result.value) void deleteTemp(result.value.tempName)
  result.value = null
  exportError.value = null
  if (jobId.value) runner.forget(jobId.value)
  jobId.value = null
}

async function exportFile() {
  if (!file.value || !info.value || blockers.value.length) return
  clearResult()
  const input: VideoJobInput = {
    file: file.value,
    name: file.value.name,
    audioFile: isVideoOut.value && s.value.audio === 'replace' ? audioFile.value : null,
    settings: JSON.parse(JSON.stringify(s.value)) as VideoSettings,
    info: { duration: info.value.duration, width: info.value.width, height: info.value.height, hasAudio: info.value.hasAudio, hasVideo: info.value.hasVideo },
    session: videoSession,
  }
  const { id, done } = runner.submit(input, { label: file.value.name, bytesIn: file.value.size, priority: 'interactive' })
  jobId.value = id
  startedAt.value = Date.now()
  now.value = Date.now()
  clock = setInterval(() => { now.value = Date.now() }, 500)
  void holdWakeLock(true)
  try {
    const res = await done
    result.value = res
    resultUrl.value = URL.createObjectURL(res.blob)
  }
  catch (e) {
    if (!isCancelled(e)) exportError.value = job.value?.error ?? (e instanceof Error ? e.message : String(e))
  }
  finally {
    clearInterval(clock)
    void holdWakeLock(false)
  }
}

function cancelExport() {
  if (jobId.value) runner.cancel(jobId.value)
}

const eta = computed(() => {
  const p = job.value?.progress ?? 0
  const elapsed = (now.value - startedAt.value) / 1000
  if (p < 0.03 || elapsed < 2) return null
  return Math.max(0, elapsed / p - elapsed)
})

useEventListener(import.meta.client ? window : null, 'beforeunload', (e: BeforeUnloadEvent) => {
  if (running.value) e.preventDefault()
})

const out = useFileOutput()
const toast = useToast()
async function save() {
  if (!result.value) return
  const r = await out.saveAs(result.value.blob, result.value.name)
  if (r === 'saved') toast.add({ title: `Saved ${result.value.name}`, color: 'success', icon: 'i-lucide-circle-check' })
}

// ---------------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------------

function bytes(n?: number | null) {
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
const codecName = (c: string | null) => ({ avc: 'H.264', hevc: 'HEVC', vp9: 'VP9', av1: 'AV1', vp8: 'VP8', aac: 'AAC', opus: 'Opus', mp3: 'MP3', vorbis: 'Vorbis', flac: 'FLAC', 'pcm-s16': 'PCM' } as Record<string, string>)[c ?? ''] ?? (c ?? '—')
const selPct = computed(() => {
  const d = duration.value || 1
  return { left: `${(trimmed.value.start / d) * 100}%`, width: `${((trimmed.value.end - trimmed.value.start) / d) * 100}%`, head: `${(playhead.value / d) * 100}%` }
})
</script>

<template>
  <div class="mx-auto w-full max-w-7xl space-y-5 p-4 sm:p-6" data-testid="video-tool">
    <header class="space-y-1">
      <h1 class="text-2xl font-semibold tracking-tight">{{ meta.title }}</h1>
      <p class="text-muted">{{ meta.description }}</p>
    </header>

    <UAlert
      v-if="!supported"
      color="warning"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      title="This browser can't process video"
      description="Video tools need WebCodecs. Use a recent Chrome, Edge, Firefox or Safari."
      data-testid="unsupported"
    />

    <input ref="fileEl" type="file" :accept="videoAccepts.join(',')" class="sr-only" tabindex="-1" aria-hidden="true" data-testid="file-input" @change="onPicked">
    <input ref="audioEl" type="file" :accept="audioAccepts.join(',')" class="sr-only" tabindex="-1" aria-hidden="true" data-testid="audio-input" @change="onAudioPicked">

    <!-- ============ Intake ============ -->
    <template v-if="!file">
      <div class="grid gap-2 sm:grid-cols-3 lg:grid-cols-6" role="group" aria-label="What do you want to do?">
        <UButton
          v-for="a in actions"
          :key="a.id"
          :icon="a.icon"
          :label="a.label"
          :color="action === a.id ? 'primary' : 'neutral'"
          :variant="action === a.id ? 'soft' : 'outline'"
          class="justify-center"
          :aria-pressed="action === a.id"
          @click="choose(a.id)"
        />
      </div>
      <ToolDropZone
        :accept="videoAccepts"
        :multiple="false"
        label="Drop a video here"
        description="MP4, MOV, WebM, MKV and audio files. Nothing is uploaded."
        @files="onFiles"
      />
    </template>

    <div v-else class="grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <!-- ============ Preview, trim, result ============ -->
      <section class="min-w-0 space-y-4" aria-label="Preview">
        <UCard :ui="{ body: 'space-y-3 p-3 sm:p-4' }">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div class="min-w-0">
              <p class="truncate font-medium text-highlighted" data-testid="file-name">{{ file.name }}</p>
              <p v-if="info" class="text-xs text-muted" data-testid="file-info">
                {{ formatTime(info.duration, 1) }}
                <template v-if="info.hasVideo"> · {{ info.width }}×{{ info.height }} · {{ codecName(info.videoCodec) }}<template v-if="info.fps"> · {{ info.fps }} fps</template></template>
                <template v-if="info.hasAudio"> · {{ codecName(info.audioCodec) }}<template v-if="info.channels">&nbsp;{{ info.channels === 1 ? 'mono' : info.channels === 2 ? 'stereo' : `${info.channels} ch` }}</template></template>
                · {{ bytes(file.size) }}
              </p>
              <p v-else-if="loading" class="text-xs text-muted">Reading file…</p>
            </div>
            <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-file-video" label="Change file" :disabled="running" data-testid="change-file" @click="fileEl?.click()" />
          </div>

          <div class="overflow-hidden rounded-lg bg-black">
            <video
              v-if="sourceUrl && (info?.hasVideo ?? true)"
              ref="player"
              :src="sourceUrl"
              controls
              playsinline
              preload="metadata"
              class="mx-auto block max-h-[55vh] w-full"
              data-testid="player"
              @timeupdate="onTimeUpdate"
              @seeked="onTimeUpdate"
            />
            <audio v-else-if="sourceUrl" ref="player" :src="sourceUrl" controls class="w-full" @timeupdate="onTimeUpdate" />
          </div>

          <UAlert v-if="loadError" color="error" variant="subtle" icon="i-lucide-circle-x" :title="loadError" role="alert" data-testid="load-error" />
        </UCard>

        <!-- Trim -->
        <UCard v-if="info" id="video-section-trim" :ui="{ body: 'space-y-4 p-3 sm:p-4' }">
          <div class="flex items-center justify-between gap-2">
            <div class="flex items-center gap-2">
              <UIcon name="i-lucide-scissors" class="size-5 text-primary" aria-hidden="true" />
              <h2 class="font-semibold">Trim</h2>
            </div>
            <USwitch v-model="s.trim.enabled" aria-label="Trim the video" data-testid="trim-toggle" />
          </div>

          <div class="relative h-14 overflow-hidden rounded-md border border-default bg-elevated" aria-hidden="true">
            <div class="flex h-full">
              <img v-for="(t, i) in thumbs" :key="i" :src="t" alt="" class="h-full min-w-0 flex-1 object-cover" draggable="false">
            </div>
            <template v-if="s.trim.enabled">
              <div class="absolute inset-y-0 left-0 bg-black/60" :style="{ width: selPct.left }" />
              <div class="absolute inset-y-0 right-0 bg-black/60" :style="{ left: `calc(${selPct.left} + ${selPct.width})` }" />
              <div class="absolute inset-y-0 border-x-4 border-primary" :style="{ left: selPct.left, width: selPct.width }" />
            </template>
            <div class="absolute inset-y-0 w-0.5 bg-white shadow" :style="{ left: selPct.head }" />
          </div>

          <USlider v-model="range" :min="0" :max="duration" :step="0.01" :min-steps-between-thumbs="10" aria-label="Trim range" data-testid="trim-range" />

          <div class="grid gap-3 sm:grid-cols-2">
            <UFormField label="Start">
              <div class="flex gap-2">
                <UInput v-model="startText" class="w-full font-mono" aria-label="Start time" data-testid="trim-start" @change="commitTime('start')" @keydown.enter="commitTime('start')" />
                <UButton color="neutral" variant="outline" icon="i-lucide-arrow-down-to-line" aria-label="Set start to the current playhead" title="Start at playhead" @click="setStart" />
              </div>
            </UFormField>
            <UFormField label="End">
              <div class="flex gap-2">
                <UInput v-model="endText" class="w-full font-mono" aria-label="End time" data-testid="trim-end" @change="commitTime('end')" @keydown.enter="commitTime('end')" />
                <UButton color="neutral" variant="outline" icon="i-lucide-arrow-down-to-line" aria-label="Set end to the current playhead" title="End at playhead" @click="setEnd" />
              </div>
            </UFormField>
          </div>
          <div class="flex flex-wrap items-center justify-between gap-3">
            <p class="text-sm text-muted">Length: <span class="font-medium text-default" data-testid="trim-length">{{ formatTime(outDuration, 2) }}</span></p>
            <UButton size="sm" color="neutral" variant="soft" icon="i-lucide-play" label="Play selection" :disabled="!s.trim.enabled" @click="playSelection" />
          </div>
          <USwitch
            v-model="s.trim.precise"
            label="Frame-accurate cut"
            :description="s.trim.precise ? 'Cuts exactly where you set it; re-encodes the video.' : 'Fast and lossless: cuts at the nearest keyframe, which can be up to a few seconds off.'"
          />
        </UCard>

        <!-- Progress / result -->
        <UCard v-if="job || result || exportError" :ui="{ body: 'space-y-3 p-3 sm:p-4' }" data-testid="result">
          <template v-if="running">
            <div class="flex items-center justify-between gap-2">
              <p class="font-medium" data-testid="phase">{{ job?.phase ?? (job?.status === 'queued' ? 'Waiting…' : 'Starting…') }}</p>
              <p class="text-sm text-muted">{{ Math.round((job?.progress ?? 0) * 100) }}%<template v-if="eta !== null"> · about {{ formatTime(eta, 0) }} left</template></p>
            </div>
            <UProgress :model-value="Math.round((job?.progress ?? 0) * 100)" :max="100" aria-label="Export progress" />
            <div class="flex items-center justify-between gap-2">
              <p class="text-xs text-muted">Keep this tab open. Processing runs on your device.</p>
              <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-x" label="Cancel" data-testid="cancel" @click="cancelExport" />
            </div>
          </template>

          <UAlert v-else-if="exportError" color="error" variant="subtle" icon="i-lucide-circle-x" title="Export failed" :description="exportError" role="alert" data-testid="export-error" />

          <p v-else-if="job?.status === 'cancelled'" class="text-sm text-muted" data-testid="cancelled">Export cancelled.</p>

          <template v-else-if="result && resultUrl">
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div class="min-w-0 space-y-1">
                <p class="flex items-center gap-2 font-medium text-highlighted">
                  <UIcon name="i-lucide-circle-check" class="size-5 text-success" aria-hidden="true" />
                  <span class="truncate" data-testid="result-name">{{ result.name }}</span>
                </p>
                <p class="text-sm text-muted" data-testid="result-size">
                  {{ bytes(result.bytesIn) }} → <span class="font-medium text-default">{{ bytes(result.bytesOut) }}</span>
                  &nbsp;<span :class="result.bytesOut <= result.bytesIn ? 'text-success' : 'text-warning'">{{ pct(result.bytesIn, result.bytesOut) }}</span>
                  · {{ formatTime(result.duration, 1) }}
                  <template v-if="result.width"> · {{ result.width }}×{{ result.height }}</template>
                  · {{ [result.videoCodec, result.audioCodec].filter(Boolean).map(codecName).join(' + ') }}
                  · {{ result.ms < 1000 ? `${Math.max(1, Math.round(result.ms))} ms` : `${(result.ms / 1000).toFixed(1)} s` }}
                </p>
                <UBadge :color="result.path === 'copy' ? 'success' : 'neutral'" variant="subtle" size="sm" data-testid="result-path">
                  {{ result.path === 'copy' ? 'No re-encode (lossless)' : 'Re-encoded' }}
                </UBadge>
              </div>
              <div class="flex flex-wrap gap-2">
                <UButton icon="i-lucide-download" label="Download" data-testid="download" @click="out.download(result.blob, result.name)" />
                <UButton color="neutral" variant="outline" icon="i-lucide-save" label="Save as…" @click="save" />
              </div>
            </div>
            <ul v-if="result.warnings.length" class="list-disc space-y-1 pl-5 text-sm text-warning" data-testid="warnings">
              <li v-for="w in result.warnings" :key="w">{{ w }}</li>
            </ul>
            <video v-if="result.width" :src="resultUrl" controls playsinline class="mx-auto block max-h-80 w-full rounded-lg bg-black" data-testid="result-player" />
            <audio v-else :src="resultUrl" controls class="w-full" data-testid="result-player" />
          </template>
        </UCard>
      </section>

      <!-- ============ Settings ============ -->
      <aside class="space-y-4 lg:sticky lg:top-4 lg:self-start" aria-label="Export settings">
        <UCard :ui="{ body: 'space-y-3 p-4 sm:p-4' }">
          <h2 class="font-semibold">What do you want to do?</h2>
          <div class="grid grid-cols-2 gap-2" role="group" aria-label="Quick actions">
            <UButton
              v-for="a in actions"
              :key="a.id"
              :icon="a.icon"
              :label="a.label"
              :title="a.hint"
              size="sm"
              :color="action === a.id ? 'primary' : 'neutral'"
              :variant="action === a.id ? 'soft' : 'outline'"
              :aria-pressed="action === a.id"
              :disabled="a.id !== 'extract-audio' && !hasVideo && !!info"
              :data-testid="`action-${a.id}`"
              @click="choose(a.id)"
            />
          </div>
          <p class="text-xs text-muted">Actions combine: trim, compress and convert in one export.</p>
        </UCard>

        <!-- Output -->
        <UCard id="video-section-output" :ui="{ body: 'space-y-4 p-4 sm:p-4' }">
          <div class="flex items-center gap-2">
            <UIcon name="i-lucide-file-output" class="size-5 text-primary" aria-hidden="true" />
            <h2 class="font-semibold">Output</h2>
          </div>
          <UTabs
            v-model="s.output"
            :items="[{ label: 'Video', value: 'video', disabled: !hasVideo && !!info }, { label: 'Audio only', value: 'audio' }]"
            :content="false"
            size="sm"
            class="w-full"
            data-testid="output-type"
          />
          <template v-if="isVideoOut">
            <UFormField label="Format">
              <USelect v-model="s.container" :items="containerItems" class="w-full" data-testid="container" />
            </UFormField>
            <UFormField label="Video codec" help="Automatic picks the most compatible codec this browser can encode.">
              <USelect v-model="s.videoCodec" :items="codecItems" class="w-full" data-testid="codec" />
            </UFormField>
          </template>
          <UFormField v-else label="Audio format">
            <USelect v-model="s.audioContainer" :items="audioContainerItems" class="w-full" data-testid="audio-container" />
          </UFormField>
        </UCard>

        <!-- Resize -->
        <UCard v-if="isVideoOut" id="video-section-resize" :ui="{ body: 'space-y-4 p-4 sm:p-4' }">
          <div class="flex items-center justify-between gap-2">
            <div class="flex items-center gap-2">
              <UIcon name="i-lucide-scaling" class="size-5 text-primary" aria-hidden="true" />
              <h2 class="font-semibold">Size</h2>
            </div>
            <USwitch v-model="s.resize.enabled" aria-label="Resize the video" data-testid="resize-toggle" />
          </div>
          <template v-if="s.resize.enabled">
            <UFormField label="Resolution">
              <USelect v-model="preset" :items="presetItems" class="w-full" data-testid="resize-preset" />
            </UFormField>
            <template v-if="s.resize.preset === 'custom'">
              <div class="grid grid-cols-2 gap-3">
                <UFormField label="Width">
                  <UInputNumber v-model="s.resize.width" :min="16" :max="7680" :step="2" placeholder="Auto" :increment="false" :decrement="false" class="w-full" data-testid="resize-width" />
                </UFormField>
                <UFormField label="Height">
                  <UInputNumber v-model="s.resize.height" :min="16" :max="4320" :step="2" placeholder="Auto" :increment="false" :decrement="false" class="w-full" data-testid="resize-height" />
                </UFormField>
              </div>
              <UFormField v-if="s.resize.width && s.resize.height" label="When the shape differs">
                <USelect v-model="s.resize.fit" :items="fitItems" class="w-full" />
              </UFormField>
            </template>
            <p v-if="presetNoop" class="text-xs text-muted">The video is already this size or smaller, so it won't be enlarged.</p>
          </template>
          <div class="flex flex-wrap items-center gap-2">
            <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-rotate-ccw" aria-label="Rotate left" title="Rotate left" @click="rotate(-90)" />
            <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-rotate-cw" aria-label="Rotate right" title="Rotate right" data-testid="rotate-right" @click="rotate(90)" />
            <USwitch v-model="s.flip" label="Mirror" size="sm" />
            <span v-if="s.rotate" class="text-xs text-muted">{{ s.rotate }}°</span>
          </div>
          <p v-if="outSize" class="text-xs text-muted" data-testid="out-size">Output: {{ outSize.width }} × {{ outSize.height }}</p>
        </UCard>

        <!-- Quality -->
        <UCard id="video-section-quality" :ui="{ body: 'space-y-4 p-4 sm:p-4' }">
          <div class="flex items-center gap-2">
            <UIcon name="i-lucide-gauge" class="size-5 text-primary" aria-hidden="true" />
            <h2 class="font-semibold">Quality &amp; size</h2>
          </div>
          <URadioGroup v-model="s.quality" :items="qualityItems" size="sm" data-testid="quality" />
          <div v-if="s.quality === 'target'" class="space-y-2 rounded-lg border border-default p-3">
            <div class="flex items-center gap-2">
              <UInputNumber v-model="s.targetMB" :min="1" :max="4000" :step="1" aria-label="Target size in MB" class="w-32" data-testid="target-mb" />
              <span class="text-sm text-muted">MB</span>
            </div>
            <div class="flex flex-wrap gap-1">
              <UButton
                v-for="p in [8, 10, 25, 50, 100]"
                :key="p"
                size="xs"
                :color="s.targetMB === p ? 'primary' : 'neutral'"
                :variant="s.targetMB === p ? 'soft' : 'outline'"
                :label="`${p} MB`"
                @click="s.targetMB = p"
              />
            </div>
            <p v-if="targetPlan" class="text-xs text-muted" data-testid="target-plan">
              About {{ kbps(targetPlan.video) }} video<template v-if="targetPlan.audio"> + {{ kbps(targetPlan.audio) }} audio</template>.
            </p>
            <div v-if="targetPlan?.suggest && !(s.resize.enabled && s.resize.preset === targetPlan.suggest)" class="flex flex-wrap items-center justify-between gap-2 text-xs">
              <span class="text-warning">That's tight for this resolution; {{ targetPlan.suggest }}p will look better.</span>
              <UButton size="xs" color="neutral" variant="outline" :label="`Use ${targetPlan.suggest}p`" @click="applySuggestion(targetPlan.suggest)" />
            </div>
            <p v-if="targetPlan?.tooSmall" class="text-xs text-warning">This is very small for the length; the result may be larger.</p>
          </div>
          <UFormField v-if="isVideoOut" label="Frame rate">
            <USelect v-model="fps" :items="fpsItems" class="w-full" data-testid="fps" />
          </UFormField>
        </UCard>

        <!-- Audio -->
        <UCard v-if="isVideoOut" id="video-section-audio" :ui="{ body: 'space-y-4 p-4 sm:p-4' }">
          <div class="flex items-center gap-2">
            <UIcon name="i-lucide-volume-2" class="size-5 text-primary" aria-hidden="true" />
            <h2 class="font-semibold">Audio</h2>
          </div>
          <UTabs v-model="s.audio" :items="audioModeItems" :content="false" size="sm" class="w-full" data-testid="audio-mode" />
          <p v-if="s.audio === 'keep' && info && !info.hasAudio" class="text-xs text-muted">This video has no sound. Choose Replace to add some.</p>
          <div v-if="s.audio === 'replace'" class="space-y-2">
            <div v-if="audioFile" class="flex items-center justify-between gap-2 rounded-lg border border-default p-2">
              <div class="min-w-0">
                <p class="truncate text-sm font-medium" data-testid="audio-name">{{ audioFile.name }}</p>
                <p v-if="audioInfo" class="text-xs text-muted">{{ formatTime(audioInfo.duration, 1) }} · {{ codecName(audioInfo.audioCodec) }}</p>
              </div>
              <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-x" aria-label="Remove the audio file" @click="clearAudio" />
            </div>
            <UButton v-else block color="neutral" variant="outline" icon="i-lucide-music" label="Choose audio file" data-testid="choose-audio" @click="audioEl?.click()" />
            <p v-if="audioError" class="text-xs text-error" role="alert">{{ audioError }}</p>
            <p class="text-xs text-muted">The new audio starts with the video and is cut to its length.</p>
          </div>
        </UCard>

        <!-- Export -->
        <UCard :ui="{ body: 'space-y-3 p-4 sm:p-4' }">
          <p v-if="summary" class="text-sm text-muted" data-testid="summary">{{ summary }}</p>
          <p v-if="info && !willReencode" class="text-xs text-success">No re-encode needed: this will be quick and lossless.</p>
          <ul v-if="info && blockers.length" class="space-y-1 text-xs text-warning" data-testid="blockers">
            <li v-for="b in blockers" :key="b">{{ b }}</li>
          </ul>
          <UButton
            block
            size="lg"
            icon="i-lucide-clapperboard"
            :label="running ? 'Exporting…' : 'Export'"
            :loading="running"
            :disabled="!info || blockers.length > 0 || running || !supported"
            data-testid="export"
            @click="exportFile"
          />
          <UButton size="sm" color="neutral" variant="ghost" icon="i-lucide-rotate-ccw" label="Reset settings" :disabled="running" @click="resetSettings" />
        </UCard>
      </aside>
    </div>
  </div>
</template>
