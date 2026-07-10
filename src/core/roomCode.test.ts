import { describe, it, expect } from 'vitest'
import { randomCode } from './roomCode'

describe('randomCode', () => {
  it('returns exactly the requested length', () => {
    for (const n of [1, 4, 10, 16, 40]) expect(randomCode(n)).toHaveLength(n)
  })

  it('uses only base-36 lowercase glyphs', () => {
    expect(randomCode(500)).toMatch(/^[a-z0-9]+$/)
  })

  it('is collision-free across many 10-char draws (un-guessable keyspace)', () => {
    const draws = 10_000
    const seen = new Set(Array.from({ length: draws }, () => randomCode(10)))
    expect(seen.size).toBe(draws)
  })

  it('spreads roughly evenly over all 36 glyphs (no modulo bias)', () => {
    const sample = randomCode(36_000)
    const counts = new Map<string, number>()
    for (const ch of sample) counts.set(ch, (counts.get(ch) ?? 0) + 1)
    expect(counts.size).toBe(36) // every glyph appears
    // Each glyph should land near 1000; a biased `b % 36` would push the first
    // four toward ~1140 and the rest toward ~980. Allow generous slack for noise.
    for (const c of counts.values()) expect(c).toBeGreaterThan(820)
  })
})
