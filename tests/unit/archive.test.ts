// @vitest-environment node
import { deflateRawSync, gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { extractArchive, isArchive, isJunkPath, safeEntryPath } from '~/lib/archive'

const enc = new TextEncoder()

/** Minimal ZIP writer (stored or deflated), enough to exercise the reader. */
function zip(entries: { name: string; data: Uint8Array; deflate?: boolean }[]): Uint8Array {
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0
  for (const e of entries) {
    const name = enc.encode(e.name)
    const body = e.deflate ? new Uint8Array(deflateRawSync(e.data)) : e.data
    const lh = new DataView(new ArrayBuffer(30))
    lh.setUint32(0, 0x04034B50, true)
    lh.setUint16(4, 20, true)
    lh.setUint16(6, 0x800, true)
    lh.setUint16(8, e.deflate ? 8 : 0, true)
    lh.setUint32(18, body.length, true)
    lh.setUint32(22, e.data.length, true)
    lh.setUint16(26, name.length, true)
    const local = new Uint8Array([...new Uint8Array(lh.buffer), ...name, ...body])
    const ch = new DataView(new ArrayBuffer(46))
    ch.setUint32(0, 0x02014B50, true)
    ch.setUint16(8, 0x800, true)
    ch.setUint16(10, e.deflate ? 8 : 0, true)
    ch.setUint16(14, (44 << 9) | (1 << 5) | 1, true)
    ch.setUint32(20, body.length, true)
    ch.setUint32(24, e.data.length, true)
    ch.setUint16(28, name.length, true)
    ch.setUint32(42, offset, true)
    centrals.push(new Uint8Array([...new Uint8Array(ch.buffer), ...name]))
    locals.push(local)
    offset += local.length
  }
  const cd = centrals.flatMap(c => [...c])
  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054B50, true)
  end.setUint16(8, entries.length, true)
  end.setUint16(10, entries.length, true)
  end.setUint32(12, cd.length, true)
  end.setUint32(16, offset, true)
  return new Uint8Array([...locals.flatMap(l => [...l]), ...cd, ...new Uint8Array(end.buffer)])
}

/** Minimal ustar writer. */
function tar(entries: { name: string; data: Uint8Array; type?: string }[]): Uint8Array {
  const blocks: number[] = []
  for (const e of entries) {
    const h = new Uint8Array(512)
    h.set(enc.encode(e.name.slice(0, 100)), 0)
    h.set(enc.encode('0000644\0'), 100)
    h.set(enc.encode(`${e.data.length.toString(8).padStart(11, '0')}\0`), 124)
    h.set(enc.encode(`${(1_700_000_000).toString(8).padStart(11, '0')}\0`), 136)
    h.set(enc.encode('        '), 148)
    h[156] = (e.type ?? '0').charCodeAt(0)
    h.set(enc.encode('ustar\0' + '00'), 257)
    const sum = h.reduce((a, b) => a + b, 0)
    h.set(enc.encode(`${sum.toString(8).padStart(6, '0')}\0 `), 148)
    blocks.push(...h, ...e.data, ...new Uint8Array((512 - (e.data.length % 512)) % 512))
  }
  blocks.push(...new Uint8Array(1024))
  return new Uint8Array(blocks)
}

const asFile = (bytes: Uint8Array, name: string) => new File([bytes], name)
const text = async (f: File) => new TextDecoder().decode(await f.arrayBuffer())

describe('archive detection', () => {
  it('recognises archive names and types', () => {
    expect(isArchive({ name: 'a.ZIP', type: '' })).toBe(true)
    expect(isArchive({ name: 'a.tar.gz', type: '' })).toBe(true)
    expect(isArchive({ name: 'a.tgz', type: '' })).toBe(true)
    expect(isArchive({ name: 'a', type: 'application/x-zip-compressed' })).toBe(true)
    expect(isArchive({ name: 'a.jpg', type: 'image/jpeg' })).toBe(false)
  })
  it('flags junk and unsafe paths', () => {
    expect(isJunkPath('__MACOSX/x/._a.jpg')).toBe(true)
    expect(isJunkPath('a/.DS_Store')).toBe(true)
    expect(isJunkPath('a/b.jpg')).toBe(false)
    expect(safeEntryPath('../etc/passwd')).toBeNull()
    expect(safeEntryPath('/a//./b\\c.jpg')).toBe('a/b/c.jpg')
  })
})

describe('zip', () => {
  it('reads stored and deflated entries with folders, skipping junk', async () => {
    const big = enc.encode('x'.repeat(5000))
    const file = asFile(zip([
      { name: 'photos/', data: new Uint8Array() },
      { name: 'photos/a.jpg', data: enc.encode('AAA') },
      { name: 'photos/sub/b.png', data: big, deflate: true },
      { name: '__MACOSX/photos/._a.jpg', data: enc.encode('junk') },
      { name: 'readme.txt', data: enc.encode('hi') },
    ]), 'set.zip')
    const entries = await extractArchive(file, { filter: p => /\.(jpg|png)$/.test(p) })
    expect(entries.map(e => e.path)).toEqual(['photos/a.jpg', 'photos/sub/b.png'])
    expect(await text(entries[0]!.file)).toBe('AAA')
    expect(entries[1]!.file.size).toBe(5000)
    expect(entries[1]!.file.type).toBe('image/png')
    expect(entries[1]!.file.name).toBe('b.png')
  })
  it('honours maxEntries and rejects garbage', async () => {
    const file = asFile(zip([1, 2, 3].map(i => ({ name: `${i}.jpg`, data: enc.encode(String(i)) }))), 'n.zip')
    expect(await extractArchive(file, { maxEntries: 2 })).toHaveLength(2)
    await expect(extractArchive(asFile(enc.encode('not a zip'), 'bad.zip'))).rejects.toThrow(/valid ZIP/)
  })
  it('drops path-traversal entries', async () => {
    const file = asFile(zip([{ name: '../evil.jpg', data: enc.encode('x') }, { name: 'ok.jpg', data: enc.encode('y') }]), 't.zip')
    expect((await extractArchive(file)).map(e => e.path)).toEqual(['ok.jpg'])
  })
})

describe('tar', () => {
  const data = tar([
    { name: 'shots/', data: new Uint8Array(), type: '5' },
    { name: 'shots/one.webp', data: enc.encode('one') },
    { name: 'shots/two.jpg', data: enc.encode('x'.repeat(700)) },
  ])
  it('reads plain tar', async () => {
    const entries = await extractArchive(asFile(data, 'a.tar'))
    expect(entries.map(e => e.path)).toEqual(['shots/one.webp', 'shots/two.jpg'])
    expect(await text(entries[0]!.file)).toBe('one')
    expect(entries[1]!.file.size).toBe(700)
    expect(entries[0]!.file.lastModified).toBe(1_700_000_000_000)
  })
  it('reads tar.gz', async () => {
    const entries = await extractArchive(asFile(new Uint8Array(gzipSync(data)), 'a.tar.gz'))
    expect(entries.map(e => e.path)).toEqual(['shots/one.webp', 'shots/two.jpg'])
  })
})
