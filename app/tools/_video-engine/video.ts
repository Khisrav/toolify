/**
 * Video engine types and pure helpers, shared by the UI and the worker (no DOM, no Mediabunny import).
 * One job = one input file (+ optional replacement audio) → one output file, driven by `VideoSettings`.
 */

export type VideoContainer = 'mp4' | 'webm' | 'mkv' | 'mov'
/** `auto` keeps the source audio codec where possible (no re-encode). */
export type AudioContainer = 'auto' | 'mp3' | 'm4a' | 'wav' | 'ogg'
export type VideoCodecChoice = 'auto' | 'avc' | 'hevc' | 'vp9' | 'av1' | 'vp8'
export type QualityChoice = 'original' | 'high' | 'medium' | 'low' | 'target'
export type AudioMode = 'keep' | 'remove' | 'replace'
export type ResizeFit = 'contain' | 'cover' | 'fill'
/** Short-side presets (1080 = 1080p for landscape, 1080 px wide for portrait). */
export type ResizePreset = 2160 | 1440 | 1080 | 720 | 480 | 360 | 'custom'
export type Rotation = 0 | 90 | 180 | 270

export type QuickAction = 'trim' | 'resize' | 'compress' | 'convert' | 'extract-audio' | 'add-audio'

export interface TrimSettings {
  enabled: boolean
  /** Seconds in the source timeline. */
  start: number
  end: number
  /** Frame-accurate (re-encodes). Off = cut at the nearest keyframes without re-encoding. */
  precise: boolean
}

export interface ResizeSettings {
  enabled: boolean
  preset: ResizePreset
  /** Custom box; either side may be null (keeps aspect ratio). */
  width: number | null
  height: number | null
  fit: ResizeFit
}

export interface VideoSettings {
  output: 'video' | 'audio'
  container: VideoContainer
  videoCodec: VideoCodecChoice
  audioContainer: AudioContainer
  trim: TrimSettings
  resize: ResizeSettings
  rotate: Rotation
  flip: boolean
  quality: QualityChoice
  /** Target output size in MB (1 MB = 1024 × 1024 bytes) when `quality === 'target'`. */
  targetMB: number
  /** null = keep the source frame rate. */
  fps: number | null
  audio: AudioMode
}

/** What the UI learned about the input (see probe.ts). The worker re-reads the file itself. */
export interface MediaInfo {
  duration: number
  container: string
  mime: string
  hasVideo: boolean
  hasAudio: boolean
  /** Display size (after rotation metadata). */
  width: number
  height: number
  videoCodec: string | null
  audioCodec: string | null
  fps: number | null
  sampleRate: number | null
  channels: number | null
  canDecodeVideo: boolean
  canDecodeAudio: boolean
}

export interface VideoJobInput {
  file: Blob
  name: string
  /** Replacement audio when `settings.audio === 'replace'`. */
  audioFile?: Blob | null
  settings: VideoSettings
  info: Pick<MediaInfo, 'duration' | 'width' | 'height' | 'hasAudio' | 'hasVideo'>
  /** Per page-load id; temp files from other sessions are swept. */
  session: string
}

export interface VideoJobResult {
  blob: Blob
  name: string
  mime: string
  bytesIn: number
  bytesOut: number
  /** 'copy' = no re-encode at all; 'transcode' = at least one track was re-encoded. */
  path: 'copy' | 'transcode'
  ms: number
  warnings: string[]
  width: number | null
  height: number | null
  duration: number
  videoCodec: string | null
  audioCodec: string | null
  /** OPFS temp file backing `blob` (in `TEMP_DIR`), to delete once the result is discarded. */
  tempName: string | null
}

export const TEMP_DIR = 'toolify-video'

export const defaultVideoSettings = (): VideoSettings => ({
  output: 'video',
  container: 'mp4',
  videoCodec: 'auto',
  audioContainer: 'auto',
  trim: { enabled: false, start: 0, end: 0, precise: false },
  resize: { enabled: false, preset: 1080, width: 1280, height: 720, fit: 'contain' },
  rotate: 0,
  flip: false,
  quality: 'original',
  targetMB: 25,
  fps: null,
  audio: 'keep',
})

// ---------------------------------------------------------------------------
// planning helpers
// ---------------------------------------------------------------------------

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2)

/**
 * Output dimensions for a resize, or null to keep the source size.
 * Presets scale the short side and never enlarge. Sizes are rounded to even numbers (codec requirement).
 * `srcW`/`srcH` are the display size after `rotate` has been applied.
 */
export function planResize(srcW: number, srcH: number, r: ResizeSettings): { width: number, height: number, fit: ResizeFit } | null {
  if (!r.enabled || srcW <= 0 || srcH <= 0) return null
  if (r.preset !== 'custom') {
    const short = Math.min(srcW, srcH)
    if (r.preset >= short) return null
    const k = r.preset / short
    return { width: even(srcW * k), height: even(srcH * k), fit: 'fill' }
  }
  const w = r.width && r.width > 0 ? r.width : null
  const h = r.height && r.height > 0 ? r.height : null
  if (!w && !h) return null
  if (w && h) return { width: even(w), height: even(h), fit: r.fit }
  if (w) return { width: even(w), height: even((srcH * w) / srcW), fit: 'fill' }
  return { width: even((srcW * h!) / srcH), height: even(h!), fit: 'fill' }
}

/** Size after a clockwise rotation. */
export function rotatedSize(w: number, h: number, rotate: Rotation): { width: number, height: number } {
  return rotate === 90 || rotate === 270 ? { width: h, height: w } : { width: w, height: h }
}

/** Clamped trim range in seconds (whole file when trimming is off). */
export function trimRange(t: TrimSettings, duration: number): { start: number, end: number } {
  if (!t.enabled || !(duration > 0)) return { start: 0, end: Math.max(0, duration) }
  const start = Math.min(Math.max(0, t.start), duration)
  let end = t.end > 0 ? Math.min(t.end, duration) : duration
  if (end - start < 0.05) end = Math.min(duration, start + 0.05)
  return { start, end }
}

export const AUDIO_BITRATE = { high: 192_000, medium: 128_000, low: 96_000 } as const

/**
 * Bitrates (bits/s) that make `durationSec` of media land near `targetMB`.
 * Aims slightly under the target; audio gets a share that shrinks for tiny targets.
 */
export function planTargetBitrate(durationSec: number, targetMB: number, hasAudio: boolean): { video: number, audio: number, tooSmall: boolean } {
  // Aim ~8 % under: container overhead plus typical encoder overshoot.
  const totalBits = Math.max(0, targetMB) * 1024 * 1024 * 8 * 0.92
  const total = durationSec > 0 ? totalBits / durationSec : 0
  let audio = 0
  if (hasAudio) audio = total > 1_500_000 ? 128_000 : total > 400_000 ? 96_000 : 64_000
  const MIN_VIDEO = 100_000
  const video = Math.max(MIN_VIDEO, Math.floor(total - audio))
  return { video, audio, tooSmall: total - audio < MIN_VIDEO }
}

const PRESET_BPP = { original: 0.12, high: 0.1, medium: 0.06, low: 0.035 } as const
/** Share of the (resolution-scaled) source bitrate each preset may use, so "compress" never inflates a file. */
const PRESET_SHARE = { original: 1, high: 0.85, medium: 0.6, low: 0.4 } as const

/**
 * Video bitrate (bits/s) for a quality preset: a bits-per-pixel budget for the output size,
 * capped by the source's own bitrate scaled to the new resolution.
 */
export function planPresetBitrate(
  quality: Exclude<QualityChoice, 'target'>,
  out: { width: number, height: number },
  fps: number | null,
  src: { width: number, height: number, bitrate: number | null, fps?: number | null },
): number {
  const f = Math.min(60, Math.max(15, fps ?? src.fps ?? 30))
  const budget = PRESET_BPP[quality] * out.width * out.height * f
  let bps = budget
  if (src.bitrate && Number.isFinite(src.bitrate) && src.width > 0 && src.height > 0) {
    const fpsScale = fps && src.fps ? Math.min(1, fps / src.fps) : 1
    const scale = Math.min(1, (out.width * out.height) / (src.width * src.height)) * fpsScale
    bps = Math.min(budget, src.bitrate * scale * PRESET_SHARE[quality])
  }
  return Math.max(150_000, Math.round(bps))
}

/** Audio bitrate for a preset, never above the source's (re-encoding can't add quality). */
export function planAudioBitrate(quality: QualityChoice, srcBitrate: number | null): number {
  const want = quality === 'low' ? AUDIO_BITRATE.low : quality === 'medium' ? AUDIO_BITRATE.medium : AUDIO_BITRATE.high
  if (!srcBitrate || !Number.isFinite(srcBitrate)) return want
  const share = quality === 'low' ? 0.75 : quality === 'medium' ? 0.9 : 1
  return Math.max(48_000, Math.min(want, Math.round((srcBitrate * share) / 8000) * 8000))
}

/**
 * Suggested short side for a video bitrate so the picture doesn't fall apart
 * (rough H.264 bits-per-pixel heuristic at 30 fps). null = any size is fine.
 */
export function suggestShortSide(videoBps: number, srcW: number, srcH: number, fps = 30): number | null {
  const bppFloor = 0.05
  const short = Math.min(srcW, srcH)
  for (const side of [2160, 1440, 1080, 720, 480, 360]) {
    if (side > short) continue
    const k = side / short
    const px = srcW * k * srcH * k
    if (videoBps / (px * fps) >= bppFloor) return side === short ? null : side
  }
  return 360 < short ? 360 : null
}

/**
 * Codecs worth copying into each container as-is. Stricter than what the container can technically hold:
 * MP4/MOV promise "plays everywhere", so VP9/Opus sources get re-encoded rather than copied in.
 * Matroska and WebM accept whatever they support (checked separately against the muxer).
 */
const COPY_VIDEO: Partial<Record<VideoContainer, string[]>> = { mp4: ['avc', 'hevc', 'av1'], mov: ['avc', 'hevc', 'prores'] }
const COPY_AUDIO: Partial<Record<VideoContainer, string[]>> = { mp4: ['aac', 'mp3'], mov: ['aac', 'mp3'] }

export function copyableVideo(container: VideoContainer, codec: string | null): boolean {
  if (!codec) return false
  return COPY_VIDEO[container]?.includes(codec) ?? true
}
export function copyableAudio(container: VideoContainer, codec: string | null): boolean {
  if (!codec) return false
  return COPY_AUDIO[container]?.includes(codec) ?? true
}

/** Only MP4/MOV store rotation/flip as metadata; elsewhere the frames themselves must be turned. */
export const metadataTransforms = (c: VideoContainer) => c === 'mp4' || c === 'mov'

/**
 * True when the settings require decoding and re-encoding the picture.
 * `srcCodec` (when known) also catches codecs that shouldn't be copied into the chosen container.
 */
export function needsVideoTranscode(s: VideoSettings, srcW: number, srcH: number, srcCodec?: string | null): boolean {
  const rs = rotatedSize(srcW, srcH, s.rotate)
  return planResize(rs.width, rs.height, s.resize) !== null
    || s.fps !== null
    || s.quality !== 'original'
    || (s.trim.enabled && s.trim.precise)
    || ((s.rotate !== 0 || s.flip) && !metadataTransforms(s.container))
    || (s.videoCodec !== 'auto' && srcCodec !== undefined && s.videoCodec !== srcCodec)
    || (srcCodec !== undefined && !copyableVideo(s.container, srcCodec))
}

/** Lossless "auto" audio container for a source codec. */
export function audioContainerForCodec(codec: string | null): Exclude<AudioContainer, 'auto'> {
  if (!codec) return 'm4a'
  if (codec === 'mp3') return 'mp3'
  if (codec === 'opus' || codec === 'vorbis') return 'ogg'
  if (codec.startsWith('pcm-') || codec === 'ulaw' || codec === 'alaw') return 'wav'
  return 'm4a'
}

export const videoExt: Record<VideoContainer, string> = { mp4: 'mp4', webm: 'webm', mkv: 'mkv', mov: 'mov' }
export const audioExt: Record<Exclude<AudioContainer, 'auto'>, string> = { mp3: 'mp3', m4a: 'm4a', wav: 'wav', ogg: 'ogg' }
export const mimeForExt: Record<string, string> = {
  mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', mov: 'video/quicktime',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg',
}

/** Encoder preference per container, best compatibility first. */
export function videoCodecPreference(container: VideoContainer, choice: VideoCodecChoice): string[] {
  const base: Record<VideoContainer, string[]> = {
    mp4: ['avc', 'hevc', 'av1', 'vp9'],
    mov: ['avc', 'hevc', 'prores'],
    webm: ['vp9', 'av1', 'vp8'],
    mkv: ['avc', 'hevc', 'vp9', 'av1', 'vp8'],
  }
  const list = base[container]
  return choice !== 'auto' && list.includes(choice) ? [choice, ...list.filter(c => c !== choice)] : list
}

export function audioCodecPreference(container: VideoContainer | Exclude<AudioContainer, 'auto'>): string[] {
  switch (container) {
    case 'mp4': case 'mov': case 'm4a': return ['aac', 'opus', 'mp3']
    case 'webm': return ['opus', 'vorbis']
    case 'mkv': return ['aac', 'opus', 'mp3', 'vorbis']
    case 'mp3': return ['mp3']
    case 'ogg': return ['opus', 'vorbis']
    case 'wav': return ['pcm-s16']
  }
}

/** `clip.mov` + `mp4` → `clip.mp4`; same extension → `clip-edited.mp4`. */
export function outputName(name: string, ext: string, suffix = ''): string {
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const old = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  const sfx = suffix || (old === ext ? '-edited' : '')
  return `${stem}${sfx}.${ext}`
}

/** Applies a quick action's sensible defaults on top of the current settings. */
export function applyQuickAction(s: VideoSettings, action: QuickAction, info?: Pick<MediaInfo, 'duration'>): VideoSettings {
  // JSON clone: settings are plain data, and structuredClone rejects Vue's reactive proxies.
  const n = JSON.parse(JSON.stringify(s)) as VideoSettings
  switch (action) {
    case 'trim':
      n.output = 'video'
      n.trim.enabled = true
      if (info && !(n.trim.end > n.trim.start)) n.trim = { ...n.trim, start: 0, end: info.duration }
      break
    case 'resize':
      n.output = 'video'
      n.resize.enabled = true
      break
    case 'compress':
      n.output = 'video'
      if (n.quality === 'original') n.quality = 'medium'
      break
    case 'convert':
      n.output = 'video'
      break
    case 'extract-audio':
      n.output = 'audio'
      break
    case 'add-audio':
      n.output = 'video'
      n.audio = 'replace'
      break
  }
  return n
}

// ---------------------------------------------------------------------------
// time formatting
// ---------------------------------------------------------------------------

/** 75.25 → "1:15.25"; 3725 → "1:02:05.00". */
export function formatTime(sec: number, decimals = 2): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0
  const factor = 10 ** decimals
  const total = Math.round(sec * factor) / factor
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const ss = (decimals ? s.toFixed(decimals) : String(Math.floor(s))).padStart(decimals ? decimals + 3 : 2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** Parses "1:15.25", "75.25", "1:02:05" → seconds, or null when invalid. */
export function parseTime(text: string): number | null {
  const t = text.trim()
  if (!t) return null
  const parts = t.split(':')
  if (parts.length > 3) return null
  let sec = 0
  for (const p of parts) {
    if (!/^\d+(?:[.,]\d+)?$/.test(p)) return null
    sec = sec * 60 + Number(p.replace(',', '.'))
  }
  return sec
}
