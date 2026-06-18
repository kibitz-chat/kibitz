import { describe, expect, it } from 'vitest'
import { containRect, fromNorm, inkColor, toNorm } from './ink'

describe('containRect — letterboxed content area of a contain-fit video', () => {
  it('pillarboxes a 16:9 video in a square box (bars left/right)', () => {
    const r = containRect(400, 400, 1600, 900) // scale 0.25 → 400×225
    expect(r).toEqual({ x: 0, y: 87.5, w: 400, h: 225 })
  })
  it('letterboxes a tall video in a wide box (bars top/bottom… here left/right)', () => {
    const r = containRect(800, 400, 1000, 1000) // square video in 2:1 box → 400×400 centered
    expect(r).toEqual({ x: 200, y: 0, w: 400, h: 400 })
  })
  it('falls back to the whole element when intrinsic size is unknown', () => {
    expect(containRect(300, 200, 0, 0)).toEqual({ x: 0, y: 0, w: 300, h: 200 })
  })
})

describe('toNorm / fromNorm — round-trip within the content rect', () => {
  const r = { x: 100, y: 50, w: 200, h: 100 }
  it('maps the content-rect centre to (0.5, 0.5) and back', () => {
    expect(toNorm(200, 100, r)).toEqual({ x: 0.5, y: 0.5 })
    expect(fromNorm(0.5, 0.5, r)).toEqual({ x: 200, y: 100 })
  })
  it('clamps points outside the picture to the edges', () => {
    expect(toNorm(0, 0, r)).toEqual({ x: 0, y: 0 }) // up-left of the content → corner
    expect(toNorm(9999, 9999, r)).toEqual({ x: 1, y: 1 })
  })
})

describe('inkColor — stable per id', () => {
  it('is deterministic and an hsl colour', () => {
    expect(inkColor('abc')).toBe(inkColor('abc'))
    expect(inkColor('abc')).toMatch(/^hsl\(\d+ 85% 62%\)$/)
  })
})
