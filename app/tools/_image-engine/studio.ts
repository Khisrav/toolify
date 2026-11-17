/**
 * Image Studio pipeline types and pure helpers (shared by the UI and the worker; no DOM access).
 * One job = decode → resize? → flatten? → encode, driven by a single settings object for the whole batch.
 */

export type OutputFormat = 'jpeg' | 'png' | 'webp' | 'avif'
export type FormatChoice = 'same' | OutputFormat
export type EncoderChoice = 'auto' | 'native' | 'wasm'
export type ResizeMode = 'fit' | 'exact' | 'percent'
export type ResizeFit = 'cover' | 'contain' | 'fill'

export interface ResizeSettings {
  enabled: boolean
  mode: ResizeMode
  /** fit: bounding box (either side optional). exact: target size. */
  width: number | null
  height: number | null
  percent: number
  fit: ResizeFit
  /** Never enlarge (fit / percent modes). */
  noUpscale: boolean
}

export interface StudioSettings {
  resize: ResizeSettings
  format: FormatChoice
  /** 1–100, for lossy formats. */
  quality: number
  /** Lossless WebP. */
  lossless: boolean
  encoder: EncoderChoice
  /** Fill for transparent pixels when the output has no alpha (JPEG) or when padding. */
  background: string
  /** Keep the original when re-encoding in the same format and size would make it bigger. */
  keepIfLarger: boolean
  /** Aim for a file size: lower quality (and, if allowed, dimensions) until the output fits. */
  target: TargetSettings
}

export interface TargetSettings {
  enabled: boolean
  /** Target size in KB (1 KB = 1024 bytes). */
  kb: number
  /** When even the lowest quality is too big (or the format is lossless), shrink the image. */
  allowDownscale: boolean
}

export interface StudioJobInput {
  file: Blob
  name: string
  settings: StudioSettings
  /** Refuse inputs above this many pixels (memory guard). */
  maxPixels: number
}

export interface StudioJobResult {
  blob: Blob
  format: OutputFormat
  width: number
  height: number
  srcWidth: number
  srcHeight: number
  bytesIn: number
  bytesOut: number
  path: 'native' | 'wasm' | 'original'
  ms: number
  warnings: string[]
}

export const defaultStudioSettings = (): StudioSettings => ({
  resize: { enabled: false, mode: 'fit', width: 1920, height: 1920, percent: 50, fit: 'cover', noUpscale: true },
  format: 'same',
  quality: 80,
  lossless: false,
  encoder: 'auto',
  background: '#ffffff',
  keepIfLarger: true,
  target: { enabled: false, kb: 500, allowDownscale: true },
})

/** Lowest quality the target-size search will go to; below this, artefacts are rarely worth it. */
export const MIN_TARGET_QUALITY = 10

/**
 * Find the highest quality in [lo, hi] whose encoded size fits `maxBytes`, by binary search.
 * `encode` must be (roughly) monotonic in quality. Returns the best fit, or the smallest attempt
 * (`fits: false`) when nothing fits. At most `maxTries` encodes.
 */
export async function searchQuality<T extends { size: number }>(
  encode: (q: number) => Promise<T>,
  lo: number,
  hi: number,
  maxBytes: number,
  maxTries = 7,
): Promise<{ result: T; quality: number; fits: boolean; tries: number }> {
  let best: { result: T; quality: number } | null = null
  let smallest: { result: T; quality: number } | null = null
  let tries = 0
  while (lo <= hi && tries < maxTries) {
    const q = Math.round((lo + hi) / 2)
    const result = await encode(q)
    tries++
    if (!smallest || result.size < smallest.result.size) smallest = { result, quality: q }
    if (result.size <= maxBytes) {
      if (!best || q > best.quality) best = { result, quality: q }
      lo = q + 1
    }
    else {
      hi = q - 1
    }
  }
  if (best) return { ...best, fits: true, tries }
  return { ...smallest!, fits: false, tries }
}

export const formatExt: Record<OutputFormat, string> = { jpeg: 'jpg', png: 'png', webp: 'webp', avif: 'avif' }
export const formatMime: Record<OutputFormat, string> = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', avif: 'image/avif' }

/** Input MIME (or name) → the format `same` encodes to. Formats we cannot write fall back to PNG. */
export function sameFormat(type: string, name = ''): { format: OutputFormat; exact: boolean } {
  const t = type.toLowerCase()
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  if (t === 'image/jpeg' || ['jpg', 'jpeg', 'jfif'].includes(ext)) return { format: 'jpeg', exact: true }
  if (t === 'image/png' || ext === 'png') return { format: 'png', exact: true }
  if (t === 'image/webp' || ext === 'webp') return { format: 'webp', exact: true }
  if (t === 'image/avif' || ext === 'avif') return { format: 'avif', exact: true }
  // HEIC/HEIF photos → JPEG; GIF/BMP/ICO/other → PNG (lossless, keeps alpha).
  if (t.includes('heic') || t.includes('heif') || ext === 'heic' || ext === 'heif') return { format: 'jpeg', exact: false }
  return { format: 'png', exact: false }
}

export function resolveFormat(choice: FormatChoice, type: string, name = ''): OutputFormat {
  return choice === 'same' ? sameFormat(type, name).format : choice
}

export interface ResizePlan {
  /** Output canvas size. */
  width: number
  height: number
  /** Source rectangle (cover crops). */
  sx: number
  sy: number
  sw: number
  sh: number
  /** Destination rectangle inside the canvas (contain pads). */
  dx: number
  dy: number
  dw: number
  dh: number
}

const clampDim = (n: number) => Math.max(1, Math.round(n))

/** Work out output size and draw rectangles for a source of `w × h`. Pure; unit-tested. */
export function planResize(w: number, h: number, r: ResizeSettings): ResizePlan {
  const identity = (): ResizePlan => ({ width: w, height: h, sx: 0, sy: 0, sw: w, sh: h, dx: 0, dy: 0, dw: w, dh: h })
  const scaled = (s: number): ResizePlan => {
    const k = r.noUpscale ? Math.min(1, s) : s
    const W = clampDim(w * k)
    const H = clampDim(h * k)
    return { width: W, height: H, sx: 0, sy: 0, sw: w, sh: h, dx: 0, dy: 0, dw: W, dh: H }
  }
  if (!r.enabled) return identity()

  if (r.mode === 'percent') return scaled(Math.max(1, r.percent) / 100)

  const bw = r.width && r.width > 0 ? r.width : null
  const bh = r.height && r.height > 0 ? r.height : null

  if (r.mode === 'fit') {
    if (!bw && !bh) return identity()
    const s = Math.min(bw ? bw / w : Infinity, bh ? bh / h : Infinity)
    return scaled(s)
  }

  // exact: a missing side is derived from the aspect ratio.
  if (!bw && !bh) return identity()
  const W = clampDim(bw ?? (w * bh!) / h)
  const H = clampDim(bh ?? (h * bw!) / w)
  if (!bw || !bh || r.fit === 'fill') return { width: W, height: H, sx: 0, sy: 0, sw: w, sh: h, dx: 0, dy: 0, dw: W, dh: H }

  if (r.fit === 'cover') {
    // Scale so the source covers W × H, then crop the overflow evenly from both sides.
    const s = Math.max(W / w, H / h)
    const sw = Math.min(w, W / s)
    const sh = Math.min(h, H / s)
    return { width: W, height: H, sx: (w - sw) / 2, sy: (h - sh) / 2, sw, sh, dx: 0, dy: 0, dw: W, dh: H }
  }

  // contain: letterbox inside W × H.
  const s = Math.min(W / w, H / h)
  const dw = clampDim(w * s)
  const dh = clampDim(h * s)
  return { width: W, height: H, sx: 0, sy: 0, sw: w, sh: h, dx: Math.floor((W - dw) / 2), dy: Math.floor((H - dh) / 2), dw, dh }
}

/** Output path for an input path: new extension, optional suffix, optionally flattened. */
export function outputPath(inputPath: string, format: OutputFormat, opts: { suffix?: string; keepFolders?: boolean } = {}): string {
  const path = opts.keepFolders === false ? inputPath.slice(inputPath.lastIndexOf('/') + 1) : inputPath
  const slash = path.lastIndexOf('/')
  const dir = slash >= 0 ? path.slice(0, slash + 1) : ''
  const base = path.slice(slash + 1)
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  return `${dir}${stem}${opts.suffix ?? ''}.${formatExt[format]}`
}
