import { describe, expect, it } from 'vitest'
import { reactive } from 'vue'
import {
  applyQuickAction, audioContainerForCodec, copyableAudio, copyableVideo, defaultVideoSettings, formatTime, needsVideoTranscode, outputName,
  parseTime, planAudioBitrate, planPresetBitrate, planResize, planTargetBitrate, rotatedSize, suggestShortSide, trimRange, videoCodecPreference,
  type ResizeSettings,
} from '~/tools/_video-engine/video'

const rs = (p: Partial<ResizeSettings>): ResizeSettings => ({ ...defaultVideoSettings().resize, enabled: true, ...p })

describe('planResize', () => {
  it('keeps the source size when disabled', () => {
    expect(planResize(1920, 1080, rs({ enabled: false }))).toBeNull()
  })
  it('scales the short side for presets and never enlarges', () => {
    expect(planResize(1920, 1080, rs({ preset: 720 }))).toEqual({ width: 1280, height: 720, fit: 'fill' })
    expect(planResize(1080, 1920, rs({ preset: 720 }))).toEqual({ width: 720, height: 1280, fit: 'fill' })
    expect(planResize(1280, 720, rs({ preset: 1080 }))).toBeNull()
    expect(planResize(1280, 720, rs({ preset: 720 }))).toBeNull()
  })
  it('rounds to even dimensions', () => {
    const p = planResize(1918, 1078, rs({ preset: 480 }))!
    expect(p.width % 2).toBe(0)
    expect(p.height % 2).toBe(0)
  })
  it('supports a custom box with one side or both', () => {
    expect(planResize(1920, 1080, rs({ preset: 'custom', width: 640, height: null }))).toEqual({ width: 640, height: 360, fit: 'fill' })
    expect(planResize(1920, 1080, rs({ preset: 'custom', width: null, height: 480 }))).toEqual({ width: 854, height: 480, fit: 'fill' })
    expect(planResize(1920, 1080, rs({ preset: 'custom', width: 1080, height: 1080, fit: 'cover' }))).toEqual({ width: 1080, height: 1080, fit: 'cover' })
    expect(planResize(1920, 1080, rs({ preset: 'custom', width: null, height: null }))).toBeNull()
  })
})

describe('rotatedSize', () => {
  it('swaps sides for quarter turns', () => {
    expect(rotatedSize(1920, 1080, 90)).toEqual({ width: 1080, height: 1920 })
    expect(rotatedSize(1920, 1080, 180)).toEqual({ width: 1920, height: 1080 })
  })
})

describe('trimRange', () => {
  const t = (p: Partial<ReturnType<typeof defaultVideoSettings>['trim']>) => ({ ...defaultVideoSettings().trim, enabled: true, ...p })
  it('is the whole file when off', () => {
    expect(trimRange(t({ enabled: false, start: 3, end: 5 }), 10)).toEqual({ start: 0, end: 10 })
  })
  it('clamps to the duration', () => {
    expect(trimRange(t({ start: -1, end: 99 }), 10)).toEqual({ start: 0, end: 10 })
    expect(trimRange(t({ start: 2, end: 0 }), 10)).toEqual({ start: 2, end: 10 })
  })
  it('never returns an empty range', () => {
    const r = trimRange(t({ start: 5, end: 5 }), 10)
    expect(r.end).toBeGreaterThan(r.start)
  })
})

describe('planTargetBitrate', () => {
  it('fits video + audio into the target', () => {
    const p = planTargetBitrate(60, 10, true)
    const bytes = ((p.video + p.audio) * 60) / 8
    expect(bytes).toBeLessThanOrEqual(10 * 1024 * 1024)
    expect(bytes).toBeGreaterThan(8.8 * 1024 * 1024)
    expect(p.tooSmall).toBe(false)
  })
  it('gives no audio budget to silent videos', () => {
    expect(planTargetBitrate(60, 10, false).audio).toBe(0)
  })
  it('flags impossible targets', () => {
    const p = planTargetBitrate(3600, 1, true)
    expect(p.tooSmall).toBe(true)
    expect(p.video).toBe(100_000)
  })
})

describe('planPresetBitrate', () => {
  const hd = { width: 1920, height: 1080 }
  it('orders presets high > medium > low', () => {
    const src = { ...hd, bitrate: null }
    const h = planPresetBitrate('high', hd, 30, src)
    const m = planPresetBitrate('medium', hd, 30, src)
    const l = planPresetBitrate('low', hd, 30, src)
    expect(h).toBeGreaterThan(m)
    expect(m).toBeGreaterThan(l)
  })
  it('never exceeds the source bitrate, so compressing never inflates', () => {
    const src = { width: 640, height: 360, bitrate: 300_000 }
    expect(planPresetBitrate('medium', src, 30, src)).toBeLessThanOrEqual(300_000)
    expect(planPresetBitrate('high', src, 30, src)).toBeLessThan(300_000)
  })
  it('scales the cap with resolution', () => {
    const src = { ...hd, bitrate: 8_000_000 }
    const half = planPresetBitrate('original', { width: 960, height: 540 }, 30, src)
    expect(half).toBeLessThanOrEqual(2_000_000)
  })
  it('spends less when the frame rate drops', () => {
    const src = { ...hd, bitrate: 6_000_000, fps: 30 }
    expect(planPresetBitrate('original', hd, 15, src)).toBeLessThanOrEqual(3_000_000)
    expect(planPresetBitrate('original', hd, null, src)).toBe(6_000_000)
  })
  it('has a floor', () => {
    expect(planPresetBitrate('low', { width: 160, height: 90 }, 15, { width: 160, height: 90, bitrate: 10_000 })).toBe(150_000)
  })
})

describe('planAudioBitrate', () => {
  it('uses the preset when the source is unknown or richer', () => {
    expect(planAudioBitrate('medium', null)).toBe(128_000)
    expect(planAudioBitrate('high', 320_000)).toBe(192_000)
  })
  it('never goes above the source', () => {
    expect(planAudioBitrate('high', 64_000)).toBe(64_000)
    expect(planAudioBitrate('low', 64_000)).toBe(48_000)
  })
})

describe('suggestShortSide', () => {
  it('suggests a lower resolution for tight bitrates', () => {
    expect(suggestShortSide(8_000_000, 1920, 1080)).toBeNull()
    expect(suggestShortSide(800_000, 1920, 1080)).toBe(480)
    expect(suggestShortSide(1_500_000, 1920, 1080)).toBe(720)
  })
})

describe('needsVideoTranscode', () => {
  const base = defaultVideoSettings()
  it('copies by default', () => {
    expect(needsVideoTranscode(base, 1920, 1080)).toBe(false)
    expect(needsVideoTranscode({ ...base, rotate: 90 }, 1920, 1080)).toBe(false)
    expect(needsVideoTranscode({ ...base, trim: { ...base.trim, enabled: true, precise: false } }, 1920, 1080)).toBe(false)
  })
  it('re-encodes for resize, fps, quality and precise trims', () => {
    expect(needsVideoTranscode({ ...base, resize: rs({ preset: 720 }) }, 1920, 1080)).toBe(true)
    expect(needsVideoTranscode({ ...base, resize: rs({ preset: 1080 }) }, 1280, 720)).toBe(false)
    expect(needsVideoTranscode({ ...base, fps: 30 }, 1920, 1080)).toBe(true)
    expect(needsVideoTranscode({ ...base, quality: 'medium' }, 1920, 1080)).toBe(true)
    expect(needsVideoTranscode({ ...base, trim: { ...base.trim, enabled: true, precise: true } }, 1920, 1080)).toBe(true)
  })
  it('re-encodes rotation for containers without transform metadata', () => {
    expect(needsVideoTranscode({ ...base, container: 'mp4', rotate: 90 }, 1920, 1080, 'avc')).toBe(false)
    expect(needsVideoTranscode({ ...base, container: 'mkv', rotate: 90 }, 1920, 1080, 'avc')).toBe(true)
    expect(needsVideoTranscode({ ...base, container: 'webm', flip: true }, 1920, 1080, 'vp9')).toBe(true)
  })
  it('re-encodes codecs that would hurt MP4 compatibility, or a different chosen codec', () => {
    expect(needsVideoTranscode({ ...base, container: 'mp4' }, 1920, 1080, 'vp9')).toBe(true)
    expect(needsVideoTranscode({ ...base, container: 'mkv' }, 1920, 1080, 'vp9')).toBe(false)
    expect(needsVideoTranscode({ ...base, container: 'mp4', videoCodec: 'hevc' }, 1920, 1080, 'avc')).toBe(true)
    expect(needsVideoTranscode({ ...base, container: 'mp4', videoCodec: 'avc' }, 1920, 1080, 'avc')).toBe(false)
  })
})

describe('codecs and containers', () => {
  it('puts the chosen codec first when the container allows it', () => {
    expect(videoCodecPreference('mp4', 'auto')[0]).toBe('avc')
    expect(videoCodecPreference('mp4', 'av1')[0]).toBe('av1')
    expect(videoCodecPreference('webm', 'avc')[0]).toBe('vp9')
  })
  it('only copies widely playable codecs into MP4/MOV', () => {
    expect(copyableVideo('mp4', 'avc')).toBe(true)
    expect(copyableVideo('mp4', 'vp9')).toBe(false)
    expect(copyableVideo('mkv', 'vp9')).toBe(true)
    expect(copyableAudio('mp4', 'opus')).toBe(false)
    expect(copyableAudio('webm', 'opus')).toBe(true)
    expect(copyableAudio('mp4', null)).toBe(false)
  })
  it('picks a lossless audio container for the source codec', () => {
    expect(audioContainerForCodec('aac')).toBe('m4a')
    expect(audioContainerForCodec('mp3')).toBe('mp3')
    expect(audioContainerForCodec('opus')).toBe('ogg')
    expect(audioContainerForCodec('pcm-s16')).toBe('wav')
    expect(audioContainerForCodec('ac3')).toBe('m4a')
  })
})

describe('outputName', () => {
  it('swaps the extension, or adds a suffix when it is unchanged', () => {
    expect(outputName('clip.mov', 'mp4')).toBe('clip.mp4')
    expect(outputName('clip.mp4', 'mp4')).toBe('clip-edited.mp4')
    expect(outputName('my.holiday.MP4', 'mp4')).toBe('my.holiday-edited.mp4')
    expect(outputName('noext', 'mp3')).toBe('noext.mp3')
    expect(outputName('a.mp4', 'mp4', '-small')).toBe('a-small.mp4')
  })
})

describe('applyQuickAction', () => {
  it('sets sensible defaults without mutating the input', () => {
    const s = defaultVideoSettings()
    expect(applyQuickAction(s, 'extract-audio').output).toBe('audio')
    expect(applyQuickAction(s, 'compress').quality).toBe('medium')
    expect(applyQuickAction({ ...s, quality: 'low' }, 'compress').quality).toBe('low')
    expect(applyQuickAction(s, 'add-audio').audio).toBe('replace')
    const t = applyQuickAction(s, 'trim', { duration: 12 })
    expect(t.trim).toMatchObject({ enabled: true, start: 0, end: 12 })
    expect(s.trim.enabled).toBe(false)
  })
  it('accepts Vue reactive settings (the UI passes a proxy)', () => {
    const s = reactive(defaultVideoSettings())
    expect(applyQuickAction(s, 'compress').quality).toBe('medium')
    expect(s.quality).toBe('original')
  })
})

describe('time formatting', () => {
  it('formats and parses round-trip', () => {
    expect(formatTime(75.25)).toBe('1:15.25')
    expect(formatTime(3725, 0)).toBe('1:02:05')
    expect(formatTime(5)).toBe('0:05.00')
    expect(parseTime('1:15.25')).toBeCloseTo(75.25)
    expect(parseTime('75,5')).toBeCloseTo(75.5)
    expect(parseTime('1:02:05')).toBe(3725)
    expect(parseTime(formatTime(42.37))).toBeCloseTo(42.37)
  })
  it('rejects junk', () => {
    expect(parseTime('')).toBeNull()
    expect(parseTime('abc')).toBeNull()
    expect(parseTime('1:2:3:4')).toBeNull()
    expect(parseTime('-5')).toBeNull()
  })
})
