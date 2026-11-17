/**
 * Hardware/browser capability probing. Runs in the main thread or a worker
 * (no DOM access except where guarded). Every probe is defensive: a failing probe = `false`.
 */

export interface Capabilities {
  crossOriginIsolated: boolean
  sharedArrayBuffer: boolean
  hardwareConcurrency: number
  /** GiB, Chromium only (coarsened). Defaults to 4 when unknown. */
  deviceMemory: number
  deviceMemoryKnown: boolean
  isIOS: boolean
  isMobile: boolean
  offscreenCanvas: boolean
  imageDecoder: boolean
  webgpu: boolean
  opfs: boolean
  fileSystemAccess: boolean
  directoryPicker: boolean
  webShareFiles: boolean
  wasmSimd: boolean
  /** VideoDecoder + VideoEncoder + AudioDecoder (needed by the video tools). */
  webCodecs: boolean
  /** Formats `OffscreenCanvas.convertToBlob` can really encode (checked via `blob.type`). */
  nativeEncode: { jpeg: boolean; png: boolean; webp: boolean; avif: boolean }
}

export type CapabilityKey = Exclude<keyof Capabilities, 'hardwareConcurrency' | 'deviceMemory' | 'nativeEncode'>

const g = globalThis as typeof globalThis & {
  navigator?: Navigator & { deviceMemory?: number; gpu?: unknown; userAgentData?: { mobile?: boolean } }
}

function detectIOS(): boolean {
  const nav = g.navigator
  if (!nav) return false
  const ua = nav.userAgent ?? ''
  // iPadOS reports as Mac; touch points disambiguate.
  return /iPad|iPhone|iPod/.test(ua) || (ua.includes('Macintosh') && (nav.maxTouchPoints ?? 0) > 1)
}

// Minimal module using a v128 SIMD instruction (from wasm-feature-detect).
const SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
])

async function probeEncode(type: string): Promise<boolean> {
  if (typeof OffscreenCanvas === 'undefined') return false
  try {
    const canvas = new OffscreenCanvas(1, 1)
    const ctx = canvas.getContext('2d')
    if (!ctx) return false
    ctx.fillRect(0, 0, 1, 1)
    const blob = await canvas.convertToBlob({ type, quality: 0.8 })
    // Unsupported types silently fall back to PNG.
    return blob.type === type
  }
  catch {
    return false
  }
}

/** Cheap, synchronous checks. Safe to call during setup. */
export function detectSyncCapabilities(): Omit<Capabilities, 'nativeEncode'> {
  const nav = g.navigator
  const deviceMemory = nav?.deviceMemory
  const isIOS = detectIOS()
  let wasmSimd = false
  try {
    wasmSimd = typeof WebAssembly !== 'undefined' && WebAssembly.validate(SIMD_PROBE)
  }
  catch { /* ignore */ }

  return {
    crossOriginIsolated: g.crossOriginIsolated === true,
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined' && g.crossOriginIsolated === true,
    hardwareConcurrency: nav?.hardwareConcurrency || 2,
    deviceMemory: typeof deviceMemory === 'number' ? deviceMemory : 4,
    deviceMemoryKnown: typeof deviceMemory === 'number',
    isIOS,
    isMobile: isIOS || nav?.userAgentData?.mobile === true || /Android|Mobi/i.test(nav?.userAgent ?? ''),
    offscreenCanvas: typeof OffscreenCanvas !== 'undefined',
    imageDecoder: typeof (g as { ImageDecoder?: unknown }).ImageDecoder !== 'undefined',
    webgpu: !!nav?.gpu,
    opfs: typeof nav?.storage?.getDirectory === 'function',
    fileSystemAccess: typeof (g as { showSaveFilePicker?: unknown }).showSaveFilePicker === 'function',
    directoryPicker: typeof (g as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function',
    webShareFiles: typeof nav?.canShare === 'function',
    wasmSimd,
    webCodecs: typeof (g as { VideoDecoder?: unknown }).VideoDecoder === 'function'
      && typeof (g as { VideoEncoder?: unknown }).VideoEncoder === 'function'
      && typeof (g as { AudioDecoder?: unknown }).AudioDecoder === 'function',
  }
}

/** Full probe, including async encoder checks. */
export async function detectCapabilities(): Promise<Capabilities> {
  const base = detectSyncCapabilities()
  const [jpeg, png, webp, avif] = await Promise.all([
    probeEncode('image/jpeg'),
    probeEncode('image/png'),
    probeEncode('image/webp'),
    probeEncode('image/avif'),
  ])
  return { ...base, nativeEncode: { jpeg, png, webp, avif } }
}

/** Rough per-job memory budget in bytes (see PLAN §3.3). */
export function memoryBudgetBytes(caps: Pick<Capabilities, 'deviceMemory' | 'isIOS'>): number {
  const MB = 1024 * 1024
  if (caps.isIOS) return 256 * MB
  return Math.min(caps.deviceMemory * 128 * MB, 1024 * MB)
}

/** Worker pool size for CPU-bound tools. */
export function poolSize(caps: Pick<Capabilities, 'hardwareConcurrency' | 'deviceMemory' | 'isIOS'>, heavy = false): number {
  if (heavy || caps.isIOS || caps.deviceMemory <= 4) {
    return heavy ? 1 : Math.min(2, Math.max(1, caps.hardwareConcurrency - 1))
  }
  return Math.min(4, Math.max(1, caps.hardwareConcurrency - 1))
}
