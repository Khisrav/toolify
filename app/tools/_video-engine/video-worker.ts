/// <reference lib="webworker" />
/**
 * Video worker: one job = one Mediabunny conversion (two composable ones when the audio is replaced).
 * Output streams into an OPFS temp file when available, so long videos never sit in memory.
 */
import {
  ALL_FORMATS, BlobSource, BufferTarget, Conversion, Input, MkvOutputFormat, MovOutputFormat, Mp3OutputFormat,
  Mp4OutputFormat, OggOutputFormat, Output, Quality, StreamTarget,
  WavOutputFormat, WebMOutputFormat, canEncodeAudio, canEncodeVideo,
  type AudioCodec, type ConversionAudioOptions, type ConversionVideoOptions, type OutputFormat,
  type StreamTargetChunk, type Target, type VideoCodec,
} from 'mediabunny'
import { exposeTool, type JobContext } from '~/workers/expose'
import {
  TEMP_DIR, audioCodecPreference, copyableAudio, audioContainerForCodec, audioExt, mimeForExt, needsVideoTranscode,
  outputName, planAudioBitrate, planPresetBitrate, planResize, planTargetBitrate, rotatedSize, trimRange, videoCodecPreference, videoExt,
  type AudioContainer, type VideoContainer, type VideoJobInput, type VideoJobResult, type VideoSettings,
} from './video'

// ---------------------------------------------------------------------------
// encoders
// ---------------------------------------------------------------------------

let aacRegistered = false
let mp3Registered = false

/** WebCodecs first; the WASM fallback encoders (AAC for Firefox, MP3 everywhere) load only on demand. */
async function audioEncodable(codec: AudioCodec): Promise<boolean> {
  if (await canEncodeAudio(codec)) return true
  if (codec === 'aac' && !aacRegistered) {
    const { registerAacEncoder } = await import('@mediabunny/aac-encoder')
    registerAacEncoder()
    aacRegistered = true
    return canEncodeAudio(codec)
  }
  if (codec === 'mp3' && !mp3Registered) {
    const { registerMp3Encoder } = await import('@mediabunny/mp3-encoder')
    registerMp3Encoder()
    mp3Registered = true
    return canEncodeAudio(codec)
  }
  return false
}

async function pickVideoCodec(format: OutputFormat, s: VideoSettings, width: number, height: number): Promise<VideoCodec> {
  const supported = format.getSupportedVideoCodecs()
  for (const c of videoCodecPreference(s.container, s.videoCodec) as VideoCodec[]) {
    if (supported.includes(c) && await canEncodeVideo(c, { width, height })) return c
  }
  throw new Error(`This browser can't encode video for ${s.container.toUpperCase()} at ${width}×${height}. Try MP4 or WebM, or a smaller size.`)
}

async function pickAudioCodec(format: OutputFormat, pref: string[]): Promise<AudioCodec> {
  const supported = format.getSupportedAudioCodecs()
  for (const c of pref as AudioCodec[]) {
    if (supported.includes(c) && await audioEncodable(c)) return c
  }
  throw new Error('This browser has no audio encoder for this format.')
}

// ---------------------------------------------------------------------------
// output targets
// ---------------------------------------------------------------------------

interface OutTarget {
  target: Target
  tempName: string | null
  finish: (mime: string) => Promise<Blob>
  discard: () => Promise<void>
}

interface SyncHandle {
  write: (data: Uint8Array, opts: { at: number }) => number
  flush: () => void
  close: () => void
}


/** Other sessions' files are removed once they're old enough that no open tab can still be using them. */
const STALE_MS = 12 * 60 * 60 * 1000
let swept = false

async function sweep(dir: FileSystemDirectoryHandle, session: string) {
  if (swept) return
  swept = true
  const stale: string[] = []
  for await (const name of (dir as unknown as { keys: () => AsyncIterable<string> }).keys()) {
    if (name.startsWith(`${session}-`)) continue
    try {
      const f = await (await dir.getFileHandle(name)).getFile()
      if (Date.now() - f.lastModified > STALE_MS) stale.push(name)
    }
    catch { stale.push(name) }
  }
  for (const n of stale) await dir.removeEntry(n).catch(() => {})
}

async function createTarget(jobId: string, session: string, ext: string): Promise<OutTarget> {
  try {
    const root = await navigator.storage.getDirectory()
    const dir = await root.getDirectoryHandle(TEMP_DIR, { create: true })
    await sweep(dir, session)
    const name = `${session}-${jobId}.${ext}`
    const fh = await dir.getFileHandle(name, { create: true })
    const createSync = (fh as unknown as { createSyncAccessHandle?: () => Promise<SyncHandle> }).createSyncAccessHandle
    if (typeof createSync !== 'function') throw new Error('no sync handle')
    const handle = await createSync.call(fh)
    let open = true
    const closeHandle = () => {
      if (!open) return
      open = false
      try {
        handle.flush()
        handle.close()
      }
      catch { /* already closed */ }
    }
    const writable = new WritableStream<StreamTargetChunk>({
      write(chunk) { handle.write(chunk.data, { at: chunk.position }) },
      close: closeHandle,
      abort: closeHandle,
    })
    return {
      target: new StreamTarget(writable, { chunked: true }),
      tempName: name,
      async finish(mime) {
        closeHandle()
        const file = await fh.getFile()
        // Re-wrapping keeps the disk backing (no copy) and sets the right type.
        return new Blob([file], { type: mime })
      },
      async discard() {
        closeHandle()
        await dir.removeEntry(name).catch(() => {})
      },
    }
  }
  catch {
    const target = new BufferTarget()
    return {
      target,
      tempName: null,
      async finish(mime) {
        if (!target.buffer) throw new Error('The output is empty')
        return new Blob([target.buffer], { type: mime })
      },
      async discard() {},
    }
  }
}

// ---------------------------------------------------------------------------
// formats
// ---------------------------------------------------------------------------

function videoFormat(c: VideoContainer): OutputFormat {
  switch (c) {
    case 'mp4': return new Mp4OutputFormat()
    case 'mov': return new MovOutputFormat()
    case 'webm': return new WebMOutputFormat()
    case 'mkv': return new MkvOutputFormat()
  }
}

function audioFormat(c: Exclude<AudioContainer, 'auto'>): OutputFormat {
  switch (c) {
    case 'mp3': return new Mp3OutputFormat()
    case 'm4a': return new Mp4OutputFormat()
    case 'wav': return new WavOutputFormat()
    case 'ogg': return new OggOutputFormat()
  }
}

/** Average bitrate of a track (sampled), or null when unknown. */
async function trackBitrate(track: { computePacketStats: (n?: number) => Promise<{ averageBitrate: number }> } | null): Promise<number | null> {
  if (!track) return null
  try {
    const b = (await track.computePacketStats(600)).averageBitrate
    return Number.isFinite(b) && b > 0 ? b : null
  }
  catch {
    return null
  }
}

function audioQuality(s: VideoSettings, targetAudioBps: number | null, srcBps: number | null): Quality {
  return new Quality({ bitrate: targetAudioBps ?? planAudioBitrate(s.quality, srcBps) })
}

// ---------------------------------------------------------------------------
// job
// ---------------------------------------------------------------------------

function checkValid(c: Conversion, what: string, warnings: string[]) {
  for (const d of c.discardedTracks) {
    if (d.reason === 'discarded_by_user') continue
    warnings.push(`${what}: the ${d.track.type} track was dropped (${d.reason.replace(/_/g, ' ')}).`)
  }
  if (!c.isValid) {
    const reasons = c.discardedTracks.map(d => d.reason).join(', ')
    throw new Error(`This file can't be converted with these settings${reasons ? ` (${reasons.replace(/_/g, ' ')})` : ''}.`)
  }
}

async function run(job: VideoJobInput, ctx: JobContext): Promise<VideoJobResult> {
  const t0 = performance.now()
  const s = job.settings
  const warnings: string[] = []
  const input = new Input({ source: new BlobSource(job.file), formats: ALL_FORMATS })
  const audioInput = s.output === 'video' && s.audio === 'replace' && job.audioFile
    ? new Input({ source: new BlobSource(job.audioFile), formats: ALL_FORMATS })
    : null
  let out: OutTarget | null = null

  try {
    if (!(await input.canRead())) throw new Error('This file format is not supported.')
    const [vt, at] = await Promise.all([input.getPrimaryVideoTrack(), input.getPrimaryAudioTrack()])
    const duration = job.info.duration > 0 ? job.info.duration : await input.computeDuration()
    const { start, end } = trimRange(s.trim, duration)
    const trim = s.trim.enabled ? { start, end } : undefined
    const precise = s.trim.enabled && s.trim.precise
    let transcoded = false
    let width: number | null = null
    let height: number | null = null
    let videoCodec: string | null = null
    let audioCodec: string | null = null

    // ---------------- audio only ----------------
    if (s.output === 'audio') {
      if (!at) throw new Error('This file has no audio track.')
      const srcCodec = await at.getCodec()
      const container = s.audioContainer === 'auto' ? audioContainerForCodec(srcCodec) : s.audioContainer
      const ext = audioExt[container]
      const mime = mimeForExt[ext]!
      const format = audioFormat(container)
      const canCopy = !!srcCodec && format.getSupportedAudioCodecs().includes(srcCodec) && s.quality === 'original' && !precise
      const codec = canCopy ? srcCodec! : await pickAudioCodec(format, audioCodecPreference(container))
      out = await createTarget(ctx.jobId, job.session, ext)
      const output = new Output({ format, target: out.target })
      // Audio-only target: the whole budget goes to audio (within sane bounds).
      const target = s.quality === 'target'
        ? Math.round(Math.min(320_000, Math.max(32_000, (s.targetMB * 1024 * 1024 * 8 * 0.97) / Math.max(0.1, end - start))))
        : null
      const srcAudioBps = await trackBitrate(at)
      const conversion = await Conversion.init({
        input, output, trim, showWarnings: false,
        copy: precise ? false : {},
        video: { discard: true },
        audio: { codec, forceTranscode: !canCopy, quality: audioQuality(s, target, srcAudioBps) },
      })
      checkValid(conversion, 'Audio', warnings)
      const onAbort = () => { void conversion.cancel() }
      ctx.signal.addEventListener('abort', onAbort, { once: true })
      conversion.onProgress = p => ctx.progress({ ratio: Math.min(0.99, p), phase: canCopy ? 'Copying audio' : 'Encoding audio' })
      await conversion.execute()
      ctx.signal.removeEventListener('abort', onAbort)
      const blob = await out.finish(mime)
      return {
        blob, name: outputName(job.name, ext), mime, bytesIn: job.file.size, bytesOut: blob.size,
        path: canCopy ? 'copy' : 'transcode', ms: performance.now() - t0, warnings,
        width: null, height: null, duration: end - start, videoCodec: null, audioCodec: codec, tempName: out.tempName,
      }
    }

    // ---------------- video ----------------
    if (!vt) throw new Error('This file has no video track. Use "Extract audio" for audio files.')
    if (!(await vt.canDecode())) throw new Error(`This browser can't decode ${(await vt.getCodec()) ?? 'this'} video.`)
    const ext = videoExt[s.container]
    const mime = mimeForExt[ext]!
    const format = videoFormat(s.container)

    const srcW = await vt.getDisplayWidth()
    const srcH = await vt.getDisplayHeight()
    const rs = rotatedSize(srcW, srcH, s.rotate)
    const dims = planResize(rs.width, rs.height, s.resize)
    width = dims?.width ?? rs.width
    height = dims?.height ?? rs.height

    const srcVideoCodec = await vt.getCodec()
    const [srcVideoBps, srcAudioBps] = await Promise.all([trackBitrate(vt), trackBitrate(at)])
    let fpsIn: number | null = null
    try {
      const r = (await vt.computePacketStats(120)).averagePacketRate
      fpsIn = Number.isFinite(r) && r > 0 ? r : null
    }
    catch { /* unknown */ }
    const outDuration = end - start
    const keepAudio = s.audio === 'keep' && !!at
    const replaceAudio = !!audioInput
    const target = s.quality === 'target' ? planTargetBitrate(outDuration, s.targetMB, keepAudio || replaceAudio) : null
    if (target?.tooSmall) warnings.push('The target size is very small for this length; the file may end up larger than requested.')

    let transcodeVideo = needsVideoTranscode(s, srcW, srcH, srcVideoCodec)
      || !srcVideoCodec || !format.getSupportedVideoCodecs().includes(srcVideoCodec)
    const vCodec = transcodeVideo ? await pickVideoCodec(format, s, width, height) : srcVideoCodec!
    if (vCodec !== srcVideoCodec) transcodeVideo = true
    if (s.videoCodec !== 'auto' && vCodec !== s.videoCodec) {
      warnings.push(`${s.videoCodec.toUpperCase()} encoding isn't available here (or not in ${s.container.toUpperCase()}); used ${vCodec.toUpperCase()} instead.`)
    }
    videoCodec = vCodec

    const videoOpts: ConversionVideoOptions = {
      codec: vCodec,
      forceTranscode: transcodeVideo,
      rotate: s.rotate || undefined,
      flip: s.flip || undefined,
      frameRate: s.fps ?? undefined,
      ...(dims ? { width: dims.width, height: dims.height, fit: dims.fit } : {}),
      ...(transcodeVideo
        ? { quality: new Quality({ bitrate: target?.video ?? planPresetBitrate(s.quality === 'target' ? 'medium' : s.quality, { width, height }, s.fps ?? fpsIn, { width: rs.width, height: rs.height, bitrate: srcVideoBps, fps: fpsIn }) }) }
        : {}),
    }

    // Audio for the main conversion.
    let audioOpts: ConversionAudioOptions = { discard: true }
    let transcodeAudio = false
    if (keepAudio && !replaceAudio) {
      const srcCodec = await at!.getCodec()
      const wantReencode = s.quality === 'low' || s.quality === 'target'
      // A frame-accurate trim disables copying for every track, so the audio needs an encoder too.
      const canCopy = copyableAudio(s.container, srcCodec) && format.getSupportedAudioCodecs().includes(srcCodec!) && !wantReencode && !precise
      const aCodec = canCopy ? srcCodec! : await pickAudioCodec(format, audioCodecPreference(s.container))
      transcodeAudio = !canCopy
      audioCodec = aCodec
      // Mediabunny may still re-encode a "copied" track (e.g. timestamp alignment); make sure an encoder exists.
      if (canCopy) await audioEncodable(aCodec as AudioCodec).catch(() => false)
      audioOpts = { codec: aCodec, forceTranscode: transcodeAudio, ...(transcodeAudio ? { quality: audioQuality(s, target?.audio ?? null, srcAudioBps) } : {}) }
    }

    out = await createTarget(ctx.jobId, job.session, ext)
    const output = new Output({ format, target: out.target })
    const copy = precise ? false as const : {}
    const conversions: { c: Conversion, weight: number, p: number }[] = []
    const onAbort = () => {
      for (const x of conversions) void x.c.cancel()
      void output.cancel()
    }
    ctx.signal.addEventListener('abort', onAbort, { once: true })

    const main = await Conversion.init({
      input, output, trim, copy, showWarnings: false, composable: replaceAudio,
      video: videoOpts, audio: audioOpts,
    })
    checkValid(main, 'Video', warnings)
    conversions.push({ c: main, weight: 0.85, p: 0 })

    if (audioInput) {
      if (!(await audioInput.canRead())) throw new Error('The audio file format is not supported.')
      const newTrack = await audioInput.getPrimaryAudioTrack()
      if (!newTrack) throw new Error('The audio file has no audio track.')
      const audioDur = await audioInput.computeDuration([newTrack])
      if (audioDur + 0.05 < outDuration) warnings.push('The new audio is shorter than the video; the rest is silent.')
      const srcCodec = await newTrack.getCodec()
      const newAudioBps = await trackBitrate(newTrack)
      const canCopy = copyableAudio(s.container, srcCodec) && format.getSupportedAudioCodecs().includes(srcCodec!) && s.quality !== 'low' && s.quality !== 'target'
      const aCodec = canCopy ? srcCodec! : await pickAudioCodec(format, audioCodecPreference(s.container))
      transcodeAudio = !canCopy
      audioCodec = aCodec
      if (canCopy) await audioEncodable(aCodec as AudioCodec).catch(() => false)
      const audioEnd = Math.min(audioDur, outDuration)
      const second = await Conversion.init({
        input: audioInput, output, composable: true, showWarnings: false,
        trim: audioEnd < audioDur ? { start: 0, end: audioEnd } : undefined,
        copy: canCopy ? {} : false,
        video: { discard: true },
        audio: { codec: aCodec, forceTranscode: !canCopy, ...(canCopy ? {} : { quality: audioQuality(s, target?.audio ?? null, newAudioBps) }) },
      })
      checkValid(second, 'New audio', warnings)
      conversions.push({ c: second, weight: 0.15, p: 0 })
    }

    const report = () => {
      const ratio = conversions.reduce((n, x) => n + x.weight * x.p, 0) / conversions.reduce((n, x) => n + x.weight, 0)
      ctx.progress({ ratio: Math.min(0.99, ratio), phase: transcodeVideo ? 'Encoding video' : 'Copying video' })
    }
    for (const x of conversions) x.c.onProgress = (p) => { x.p = p; report() }

    if (replaceAudio) {
      await output.start()
      await Promise.all(conversions.map(x => x.c.execute()))
      ctx.progress({ ratio: 0.99, phase: 'Finishing' })
      await output.finalize()
    }
    else {
      await main.execute()
    }
    ctx.signal.removeEventListener('abort', onAbort)
    transcoded = transcodeVideo || transcodeAudio

    const blob = await out.finish(mime)
    return {
      blob, name: outputName(job.name, ext), mime, bytesIn: job.file.size, bytesOut: blob.size,
      path: transcoded ? 'transcode' : 'copy', ms: performance.now() - t0, warnings,
      width, height, duration: outDuration, videoCodec, audioCodec, tempName: out.tempName,
    }
  }
  catch (err) {
    await out?.discard()
    throw err
  }
  finally {
    input.dispose()
    audioInput?.dispose()
  }
}

exposeTool<VideoJobInput, VideoJobResult>(run)
