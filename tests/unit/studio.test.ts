import { describe, expect, it } from 'vitest'
import { defaultStudioSettings, outputPath, planResize, resolveFormat, searchQuality, type ResizeSettings } from '~/tools/_image-engine/studio'

const rs = (p: Partial<ResizeSettings>): ResizeSettings => ({ ...defaultStudioSettings().resize, enabled: true, ...p })

describe('planResize', () => {
  it('is identity when disabled', () => {
    expect(planResize(400, 300, rs({ enabled: false }))).toMatchObject({ width: 400, height: 300 })
  })
  it('fits inside a box and never upscales by default', () => {
    expect(planResize(4000, 3000, rs({ mode: 'fit', width: 1920, height: 1920 }))).toMatchObject({ width: 1920, height: 1440 })
    expect(planResize(3000, 4000, rs({ mode: 'fit', width: 1920, height: null }))).toMatchObject({ width: 1920, height: 2560 })
    expect(planResize(800, 600, rs({ mode: 'fit', width: 1920, height: 1920 }))).toMatchObject({ width: 800, height: 600 })
    expect(planResize(800, 600, rs({ mode: 'fit', width: 1600, height: null, noUpscale: false }))).toMatchObject({ width: 1600, height: 1200 })
  })
  it('scales by percent', () => {
    expect(planResize(1000, 500, rs({ mode: 'percent', percent: 25 }))).toMatchObject({ width: 250, height: 125 })
  })
  it('crops to cover an exact size', () => {
    const p = planResize(4000, 3000, rs({ mode: 'exact', width: 1080, height: 1080, fit: 'cover' }))
    expect(p).toMatchObject({ width: 1080, height: 1080, sw: 3000, sh: 3000, sx: 500, sy: 0, dw: 1080, dh: 1080 })
  })
  it('pads to contain an exact size', () => {
    const p = planResize(4000, 2000, rs({ mode: 'exact', width: 1000, height: 1000, fit: 'contain' }))
    expect(p).toMatchObject({ width: 1000, height: 1000, dw: 1000, dh: 500, dx: 0, dy: 250 })
  })
  it('derives a missing side in exact mode', () => {
    expect(planResize(4000, 2000, rs({ mode: 'exact', width: 1000, height: null }))).toMatchObject({ width: 1000, height: 500 })
  })
})

describe('naming and formats', () => {
  it('maps "same" to a writable format', () => {
    expect(resolveFormat('same', 'image/jpeg')).toBe('jpeg')
    expect(resolveFormat('same', '', 'x.HEIC')).toBe('jpeg')
    expect(resolveFormat('same', 'image/gif')).toBe('png')
    expect(resolveFormat('webp', 'image/png')).toBe('webp')
  })
  it('builds output paths', () => {
    expect(outputPath('trip/day1/IMG_1.HEIC', 'jpeg')).toBe('trip/day1/IMG_1.jpg')
    expect(outputPath('trip/a.png', 'webp', { suffix: '-min' })).toBe('trip/a-min.webp')
    expect(outputPath('trip/a.png', 'webp', { keepFolders: false })).toBe('a.webp')
    expect(outputPath('noext', 'png')).toBe('noext.png')
  })
})

describe('searchQuality', () => {
  // Fake encoder: size grows linearly with quality (10 KB per step).
  const enc = (calls: number[]) => async (q: number) => {
    calls.push(q)
    return { size: q * 10_240, q }
  }
  it('finds the highest quality that fits within 7 encodes', async () => {
    const calls: number[] = []
    const r = await searchQuality(enc(calls), 10, 79, 500 * 1024)
    expect(r).toMatchObject({ fits: true, quality: 50 })
    expect(calls.length).toBeLessThanOrEqual(7)
  })
  it('reports the smallest attempt when nothing fits', async () => {
    const r = await searchQuality(enc([]), 10, 79, 50 * 1024)
    expect(r.fits).toBe(false)
    expect(r.quality).toBe(10)
  })
})
