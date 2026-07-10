import { describe, expect, it } from 'vitest'
import { boardFromStrokes, containRect, fromNorm, inkColor, stageImageKey, switchDoodle, toNorm, type StrokeMap } from './ink'

describe('stageImageKey — stable opaque key for a staged image', () => {
  it('is deterministic, opaque (no source leak), and distinct per image', () => {
    const a = stageImageKey('photo.png:12345:1700000000')
    expect(a).toBe(stageImageKey('photo.png:12345:1700000000')) // same input → same key (doodle returns)
    expect(a).toMatch(/^img-[a-z0-9]+$/) // opaque — no filename/bytes
    expect(a).not.toBe(stageImageKey('other.png:999:1700000001')) // different image → different key
  })
})

describe('boardFromStrokes — apply a synced restore replay', () => {
  it('builds a keyed board from the replayed strokes, deep-copied', () => {
    const src = [{ color: 'red', pts: [{ x: 0.1, y: 0.2 }] }]
    const board = boardFromStrokes(src)
    expect([...board.keys()]).toEqual(['restore:0'])
    expect(board.get('restore:0')?.color).toBe('red')
    board.get('restore:0')?.pts.push({ x: 0.9, y: 0.9 }) // mutate the result
    expect(src[0].pts.length).toBe(1) // source untouched (deep copy)
  })
  it('handles an empty/absent replay', () => {
    expect(boardFromStrokes([]).size).toBe(0)
  })
})

const board = (entries: [string, string][]): StrokeMap => new Map(entries.map(([k, color]) => [k, { color, pts: [{ x: 0.1, y: 0.2 }] }]))

describe('switchDoodle — per-image doodle persistence', () => {
  it('saves the leaving image and starts the new image with a clean board', () => {
    const saved = new Map<string, StrokeMap>()
    const next = switchDoodle(saved, board([['me:1', 'red']]), 'imgA', 'imgB')
    expect(next.size).toBe(0) // imgB is fresh
    expect(saved.get('imgA')?.get('me:1')?.color).toBe('red') // imgA's doodle remembered
  })
  it('restores a previously-doodled image when it comes back', () => {
    const saved = new Map<string, StrokeMap>()
    switchDoodle(saved, board([['me:1', 'red']]), 'imgA', 'imgB') // leave A (saved), enter B
    const back = switchDoodle(saved, board([['me:2', 'blue']]), 'imgB', 'imgA') // leave B, RE-ENTER A
    expect(back.get('me:1')?.color).toBe('red') // A's doodle is back
    expect(saved.get('imgB')?.get('me:2')?.color).toBe('blue') // B got saved too
  })
  it('image → live screen-share (undefined) saves the image and clears the board', () => {
    const saved = new Map<string, StrokeMap>()
    const next = switchDoodle(saved, board([['me:1', 'red']]), 'imgA', undefined)
    expect(next.size).toBe(0)
    expect(saved.has('imgA')).toBe(true)
  })
  it('the restored board is a DEEP COPY — drawing more never mutates the saved snapshot', () => {
    const saved = new Map<string, StrokeMap>()
    switchDoodle(saved, board([['me:1', 'red']]), 'imgA', 'imgB')
    const back = switchDoodle(saved, new Map(), 'imgB', 'imgA')
    back.get('me:1')?.pts.push({ x: 0.9, y: 0.9 }) // draw more after restore
    expect(saved.get('imgA')?.get('me:1')?.pts.length).toBe(1) // snapshot untouched
  })
})

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
