/// <reference lib="webworker" />
/**
 * Image Studio worker: decode → resize → flatten → encode (→ fit a target size) for one file per job.
 * Native canvas encoders are the fast path; MozJPEG / libwebp (jSquash WASM) give smaller files.
 * Each WASM codec is a separate dynamic import, so it downloads only when first used.
 */
import { exposeTool } from '~/workers/expose'
import {
  MIN_TARGET_QUALITY, formatMime, planResize, resolveFormat, sameFormat, searchQuality,
  type OutputFormat, type ResizePlan, type StudioJobInput, type StudioJobResult, type StudioSettings,
} from './studio'

type Canvas2D = OffscreenCanvasRenderingContext2D
type Source = ImageBitmap | OffscreenCanvas

function context(canvas: OffscreenCanvas): Canvas2D {
  const g = canvas.getContext('2d', { willReadFrequently: true })
  if (!g) throw new Error('2D canvas is not available in this worker')
  g.imageSmoothingEnabled = true
  g.imageSmoothingQuality = 'high'
  return g
}

function release(c: OffscreenCanvas) {
  c.width = 0
  c.height = 0
}

/**
 * Draw `src` per `plan`. Large reductions are done in ≤2× halving steps, which avoids the
 * aliasing a single bilinear pass produces when shrinking a lot. `src` itself is never released.
 */
function render(src: Source, plan: ResizePlan, background: string | null): OffscreenCanvas {
  let source: Source = src
  let { sx, sy, sw, sh } = plan
  while (sw / 2 >= plan.dw && sh / 2 >= plan.dh) {
    const w = Math.max(plan.dw, Math.round(sw / 2))
    const h = Math.max(plan.dh, Math.round(sh / 2))
    const step = new OffscreenCanvas(w, h)
    context(step).drawImage(source, sx, sy, sw, sh, 0, 0, w, h)
    if (source !== src) release(source as OffscreenCanvas)
    source = step
    sx = 0
    sy = 0
    sw = w
    sh = h
  }
  const out = new OffscreenCanvas(plan.width, plan.height)
  const g = context(out)
  if (background) {
    g.fillStyle = background
    g.fillRect(0, 0, plan.width, plan.height)
  }
  g.drawImage(source, sx, sy, sw, sh, plan.dx, plan.dy, plan.dw, plan.dh)
  if (source !== src) release(source as OffscreenCanvas)
  return out
}

function scaled(src: OffscreenCanvas, k: number): OffscreenCanvas {
  const w = Math.max(1, Math.round(src.width * k))
  const h = Math.max(1, Math.round(src.height * k))
  return render(src, { width: w, height: h, sx: 0, sy: 0, sw: src.width, sh: src.height, dx: 0, dy: 0, dw: w, dh: h }, null)
}

async function encodeNative(canvas: OffscreenCanvas, format: OutputFormat, quality: number): Promise<Blob> {
  const type = formatMime[format]
  const blob = await canvas.convertToBlob({ type, quality: quality / 100 })
  // Unsupported types silently come back as PNG.
  if (blob.type !== type) throw new Error(`This browser cannot encode ${format.toUpperCase()}`)
  return blob
}

async function encodeWasm(canvas: OffscreenCanvas, format: 'jpeg' | 'webp', quality: number, lossless: boolean): Promise<Blob> {
  const data = context(canvas).getImageData(0, 0, canvas.width, canvas.height)
  if (format === 'webp') {
    const { default: encode } = await import('@jsquash/webp/encode')
    return new Blob([await encode(data, { quality, lossless: lossless ? 1 : 0 })], { type: 'image/webp' })
  }
  const { default: encode } = await import('@jsquash/jpeg/encode')
  return new Blob([await encode(data, { quality, progressive: true, optimize_coding: true })], { type: 'image/jpeg' })
}

/** Encoder for one job: picks native/WASM once, falling back to native if WASM fails to load. */
function makeEncoder(format: OutputFormat, s: StudioSettings, warnings: string[]) {
  let path: 'native' | 'wasm' = (format === 'jpeg' || format === 'webp') && s.encoder !== 'native' ? 'wasm' : 'native'
  if (s.encoder === 'wasm' && path === 'native' && format !== 'png') warnings.push(`No optimised ${format.toUpperCase()} encoder; used the browser encoder`)
  return {
    get path() { return path },
    async encode(canvas: OffscreenCanvas, quality: number): Promise<Blob> {
      if (path === 'wasm') {
        try {
          return await encodeWasm(canvas, format as 'jpeg' | 'webp', quality, s.lossless)
        }
        catch (e) {
          if (s.encoder === 'wasm') throw e
          warnings.push('Optimised encoder unavailable; used the browser encoder')
          path = 'native'
        }
      }
      return encodeNative(canvas, format, quality)
    },
  }
}

const kb = (n: number) => `${Math.round(n / 1024)} KB`

exposeTool<StudioJobInput, StudioJobResult>(async (input, ctx) => {
  const t0 = performance.now()
  const { settings: s } = input
  const warnings: string[] = []
  ctx.progress({ ratio: 0.05, phase: 'decode' })

  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(input.file, { imageOrientation: 'from-image' })
  }
  catch {
    throw new Error('Could not read this image (unsupported or corrupt file)')
  }
  const srcWidth = bitmap.width
  const srcHeight = bitmap.height
  if (srcWidth * srcHeight > input.maxPixels) {
    bitmap.close()
    throw new Error(`Too large for this device (${Math.round((srcWidth * srcHeight) / 1e6)} MP)`)
  }
  ctx.signal.throwIfAborted()

  const format = resolveFormat(s.format, input.file.type, input.name)
  const same = sameFormat(input.file.type, input.name)
  if (s.format === 'same' && !same.exact) warnings.push(`Saved as ${format.toUpperCase()} (the original format cannot be written)`)

  const plan = planResize(srcWidth, srcHeight, s.resize)
  const padded = plan.dw !== plan.width || plan.dh !== plan.height
  // JPEG has no alpha, so it is always flattened. Alpha formats keep transparency unless padding asks for a colour.
  const solid = s.background === 'transparent' ? '#ffffff' : s.background
  const background = format === 'jpeg' ? solid : padded && s.background !== 'transparent' ? s.background : null
  ctx.progress({ ratio: 0.2, phase: 'resize' })
  const canvas = render(bitmap, plan, background)
  bitmap.close()
  ctx.signal.throwIfAborted()

  ctx.progress({ ratio: 0.35, phase: 'encode' })
  const encoder = makeEncoder(format, s, warnings)
  let blob = await encoder.encode(canvas, s.quality)
  ctx.signal.throwIfAborted()

  // --- target file size ---
  let width = canvas.width
  let height = canvas.height
  const targetBytes = s.target.enabled ? Math.max(1, s.target.kb) * 1024 : Infinity
  if (blob.size > targetBytes) {
    const lossy = format !== 'png' && !(format === 'webp' && s.lossless)
    const base = canvas
    let smallest = { blob, width, height }
    let fitted = false
    let k = 1
    // Round 0 searches quality at full size; later rounds shrink first (only if allowed).
    const rounds = s.target.allowDownscale ? 6 : 1
    for (let round = 0; round < rounds && !fitted; round++) {
      ctx.signal.throwIfAborted()
      ctx.progress({ ratio: 0.4 + (0.55 * round) / rounds, phase: 'fit size' })
      let current = base
      if (round > 0) {
        // Bytes scale roughly with pixel count: shrink by √(target / smallest), with headroom.
        k *= Math.min(0.9, Math.sqrt(targetBytes / smallest.blob.size) * 0.95)
        if (Math.round(base.width * k) < 16 || Math.round(base.height * k) < 16) break
        current = scaled(base, k)
      }
      let attempt: Blob
      let quality = s.quality
      if (lossy) {
        const found = await searchQuality(q => encoder.encode(current, q), MIN_TARGET_QUALITY, Math.max(MIN_TARGET_QUALITY, s.quality - 1), targetBytes)
        attempt = found.result
        quality = found.quality
      }
      else {
        attempt = round > 0 ? await encoder.encode(current, s.quality) : blob
      }
      const dims = { width: current.width, height: current.height }
      if (current !== base) release(current)
      if (attempt.size < smallest.blob.size) smallest = { blob: attempt, ...dims }
      if (attempt.size <= targetBytes) {
        fitted = true
        blob = attempt
        width = dims.width
        height = dims.height
        if (quality < s.quality) warnings.push(`Quality ${quality} to fit ${kb(targetBytes)}`)
        if (round > 0) warnings.push(`Scaled to ${width}×${height} to fit ${kb(targetBytes)}`)
      }
    }
    if (!fitted) {
      ;({ blob, width, height } = smallest)
      warnings.push(`Could not reach ${kb(targetBytes)}; smallest was ${kb(blob.size)}`)
    }
  }
  release(canvas)
  ctx.signal.throwIfAborted()

  const unchangedShape = width === srcWidth && height === srcHeight
  const originalFits = input.file.size <= targetBytes
  if (s.keepIfLarger && same.exact && same.format === format && unchangedShape && originalFits && blob.size >= input.file.size) {
    blob = input.file.slice(0, input.file.size, formatMime[format])
    width = srcWidth
    height = srcHeight
    warnings.length = 0
    warnings.push('Already well compressed; kept the original file (including its metadata)')
    return result('original')
  }
  return result(encoder.path)

  function result(path: StudioJobResult['path']): StudioJobResult {
    return {
      blob, format, width, height, srcWidth, srcHeight,
      bytesIn: input.file.size, bytesOut: blob.size, path,
      ms: Math.round(performance.now() - t0), warnings,
    }
  }
})
