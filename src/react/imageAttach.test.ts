import { describe, expect, it } from 'vitest'
import { fitDimensions, isImgMime, imgTooBig, sanitizeImg, imgDataUrl, IMG_MAX_BYTES, IMG_NAME_MAX } from './imageAttach'

describe('fitDimensions — shrink into a box, preserve aspect, never upscale', () => {
  it('leaves an image already within the box untouched', () => {
    expect(fitDimensions(800, 600, 1280)).toEqual({ w: 800, h: 600 })
  })
  it('scales the longest side down to maxDim, keeping the ratio', () => {
    expect(fitDimensions(4000, 3000, 1280)).toEqual({ w: 1280, h: 960 })
    expect(fitDimensions(3000, 4000, 1280)).toEqual({ w: 960, h: 1280 })
  })
  it('never produces a zero dimension and guards garbage input', () => {
    expect(fitDimensions(1, 1, 1280)).toEqual({ w: 1, h: 1 })
    const g = fitDimensions(0, -5, 1280)
    expect(g.w).toBeGreaterThanOrEqual(1)
    expect(g.h).toBeGreaterThanOrEqual(1)
  })
})

describe('isImgMime — allowlist only renderable image types', () => {
  it('accepts the common image mimes (case-insensitive)', () => {
    for (const m of ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif', 'IMAGE/PNG']) expect(isImgMime(m)).toBe(true)
  })
  it('rejects non-images and junk', () => {
    for (const m of ['text/html', 'image/svg+xml', 'application/pdf', '', 'image/', null, 42]) expect(isImgMime(m as never)).toBe(false)
  })
})

describe('sanitizeImg — the receive-side trust boundary for image content', () => {
  const ok = { mime: 'image/jpeg', data: 'AAAABBBBCCCC', name: 'beach.jpg', w: 1280, h: 960 }
  it('passes a well-formed payload and clamps the optional fields', () => {
    expect(sanitizeImg(ok)).toEqual({ mime: 'image/jpeg', data: 'AAAABBBBCCCC', name: 'beach.jpg', w: 1280, h: 960 })
  })
  it('drops a bad mime, empty/non-base64 data, and oversized data', () => {
    expect(sanitizeImg({ ...ok, mime: 'text/html' })).toBeNull()
    expect(sanitizeImg({ ...ok, data: '' })).toBeNull()
    expect(sanitizeImg({ ...ok, data: 'not base64!! <img>' })).toBeNull()
    expect(sanitizeImg({ ...ok, data: 'A'.repeat(IMG_MAX_BYTES + 1) })).toBeNull()
  })
  it('accepts base64 padding and omits absent/invalid dimensions + clamps the name', () => {
    const r = sanitizeImg({ mime: 'image/png', data: 'QQ==', name: 'x'.repeat(200), w: -3, h: 0 })
    expect(r).toEqual({ mime: 'image/png', data: 'QQ==', name: 'x'.repeat(IMG_NAME_MAX) })
    expect(r && 'w' in r).toBe(false)
  })
})

describe('imgTooBig — the serialized-message ceiling', () => {
  it('flags a message whose JSON exceeds the ceiling', () => {
    expect(imgTooBig({ k: 'img', mime: 'image/jpeg', data: 'A'.repeat(IMG_MAX_BYTES + 100) })).toBe(true)
  })
  it('passes a small message', () => {
    expect(imgTooBig({ k: 'img', mime: 'image/jpeg', data: 'AAAA' })).toBe(false)
  })
})

describe('imgDataUrl — render-ready data URL', () => {
  it('reconstructs the data: URL from mime + base64', () => {
    expect(imgDataUrl({ mime: 'image/jpeg', data: 'AAAA' })).toBe('data:image/jpeg;base64,AAAA')
  })
})
