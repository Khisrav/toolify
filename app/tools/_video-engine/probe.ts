/**
 * Main-thread media inspection: reads only container headers (cheap), plus a few
 * decoded frames for the trim filmstrip. Heavy work stays in video-worker.ts.
 */
import { ALL_FORMATS, BlobSource, CanvasSink, Input } from 'mediabunny'
import type { MediaInfo } from './video'

export function hasWebCodecs(): boolean {
  return typeof globalThis.VideoDecoder === 'function' && typeof globalThis.VideoEncoder === 'function'
    && typeof globalThis.AudioDecoder === 'function'
}

export async function probeMedia(file: Blob): Promise<MediaInfo> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS })
  try {
    if (!(await input.canRead())) throw new Error('This file format is not supported.')
    const [format, vt, at] = await Promise.all([input.getFormat(), input.getPrimaryVideoTrack(), input.getPrimaryAudioTrack()])
    const duration = (await input.getDurationFromMetadata().catch(() => null)) ?? await input.computeDuration()
    let fps: number | null = null
    if (vt) {
      try {
        const stats = await vt.computePacketStats(120)
        fps = stats.averagePacketRate > 0 ? Math.round(stats.averagePacketRate * 100) / 100 : null
      }
      catch { /* unknown */ }
    }
    return {
      duration,
      container: format.name,
      mime: await input.getMimeType().catch(() => format.mimeType),
      hasVideo: !!vt,
      hasAudio: !!at,
      width: vt ? await vt.getDisplayWidth() : 0,
      height: vt ? await vt.getDisplayHeight() : 0,
      videoCodec: vt ? await vt.getCodec() : null,
      audioCodec: at ? await at.getCodec() : null,
      fps,
      sampleRate: at ? await at.getSampleRate() : null,
      channels: at ? await at.getNumberOfChannels() : null,
      canDecodeVideo: vt ? await vt.canDecode() : false,
      canDecodeAudio: at ? await at.canDecode() : false,
    }
  }
  finally {
    input.dispose()
  }
}

/**
 * Evenly spaced thumbnails as object URLs (caller revokes them).
 * Stops early when `signal` aborts; failures yield fewer frames, never an error.
 */
export async function filmstrip(file: Blob, duration: number, count: number, height: number, signal?: AbortSignal): Promise<string[]> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS })
  const urls: string[] = []
  try {
    const vt = await input.getPrimaryVideoTrack()
    if (!vt || !(await vt.canDecode())) return urls
    const sink = new CanvasSink(vt, { height, fit: 'contain' })
    const first = await vt.getFirstTimestamp().catch(() => 0)
    const step = duration / count
    const times = Array.from({ length: count }, (_, i) => first + step * (i + 0.5))
    for await (const wrapped of sink.canvasesAtTimestamps(times)) {
      if (signal?.aborted) break
      if (!wrapped) continue
      const c = wrapped.canvas
      const blob = c instanceof HTMLCanvasElement
        ? await new Promise<Blob | null>(r => c.toBlob(r, 'image/jpeg', 0.7))
        : await (c as OffscreenCanvas).convertToBlob({ type: 'image/jpeg', quality: 0.7 })
      if (blob) urls.push(URL.createObjectURL(blob))
    }
  }
  catch { /* best effort */ }
  finally {
    input.dispose()
  }
  return urls
}
