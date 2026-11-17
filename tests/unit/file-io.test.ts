import { describe, expect, it } from 'vitest'
import { accepts, dedupeFiles, describeAccept, parseAccept, replaceExtension, uniqueName } from '../../app/lib/files'

const f = (name: string, type = '', size = 1, lastModified = 1) => new File(['x'.repeat(size)], name, { type, lastModified })

describe('accepts', () => {
  it('accepts everything for an empty list or wildcard', () => {
    expect(accepts(f('a.bin'), [])).toBe(true)
    expect(accepts(f('a.bin'), undefined)).toBe(true)
    expect(accepts(f('a.bin'), ['*/*'])).toBe(true)
  })
  it('matches MIME globs and exact MIME', () => {
    expect(accepts(f('a.png', 'image/png'), ['image/*'])).toBe(true)
    expect(accepts(f('a.pdf', 'application/pdf'), ['image/*'])).toBe(false)
    expect(accepts(f('a.pdf', 'application/pdf'), ['application/pdf'])).toBe(true)
  })
  it('matches extensions case-insensitively, even with empty MIME', () => {
    expect(accepts(f('IMG_1.HEIC', ''), ['.heic'])).toBe(true)
    expect(accepts(f('a.heic.txt', ''), ['.heic'])).toBe(false)
  })
  it('does not treat image/* as prefix of imagex/', () => {
    expect(accepts(f('a', 'imagex/png'), ['image/*'])).toBe(false)
  })
})

describe('parseAccept / describeAccept', () => {
  it('splits and labels', () => {
    expect(parseAccept('image/*, .heic,')).toEqual(['image/*', '.heic'])
    expect(describeAccept(['image/*', '.heic', 'application/pdf'])).toEqual(['Images', 'HEIC', 'PDF'])
  })
})

describe('uniqueName', () => {
  it('returns the name when free', () => {
    expect(uniqueName('photo.jpg', new Set())).toBe('photo.jpg')
  })
  it('appends -1, -2', () => {
    expect(uniqueName('photo.jpg', new Set(['photo.jpg']))).toBe('photo-1.jpg')
    expect(uniqueName('photo.jpg', new Set(['photo.jpg', 'photo-1.jpg']))).toBe('photo-2.jpg')
  })
  it('is case-insensitive and handles no extension / dotfiles', () => {
    expect(uniqueName('Photo.JPG', new Set(['photo.jpg']))).toBe('Photo-1.JPG')
    expect(uniqueName('README', new Set(['README']))).toBe('README-1')
    expect(uniqueName('.env', new Set(['.env']))).toBe('.env-1')
    expect(uniqueName('a.tar.gz', new Set(['a.tar.gz']))).toBe('a.tar-1.gz')
  })
})

describe('replaceExtension', () => {
  it('replaces or adds', () => {
    expect(replaceExtension('photo.heic', 'jpg')).toBe('photo.jpg')
    expect(replaceExtension('photo.heic', '.webp')).toBe('photo.webp')
    expect(replaceExtension('photo', 'png')).toBe('photo.png')
    expect(replaceExtension('a.b.c.png', 'jpg')).toBe('a.b.c.jpg')
    expect(replaceExtension('.hidden', 'png')).toBe('.hidden.png')
  })
})

describe('dedupeFiles', () => {
  it('drops files with identical name+size+lastModified, including within the batch', () => {
    const a = f('a.png', 'image/png', 3, 10)
    const aAgain = f('a.png', 'image/png', 3, 10)
    const aEdited = f('a.png', 'image/png', 3, 11)
    const { merged, added } = dedupeFiles([a], [aAgain, aEdited, aEdited])
    expect(added).toEqual([aEdited])
    expect(merged).toEqual([a, aEdited])
  })
})
