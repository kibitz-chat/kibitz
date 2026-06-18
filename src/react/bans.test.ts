import { describe, expect, it } from 'vitest'
import { banKey, parseBans, serializeBans } from './bans'

describe('banKey', () => {
  it('namespaces per room', () => {
    expect(banKey('standup')).toBe('kibitz.bans.standup')
    expect(banKey('standup')).not.toBe(banKey('other'))
  })
})

describe('parseBans', () => {
  it('round-trips a set (lowercased)', () => {
    const set = new Set(['a@x.com', 'b@y.com'])
    expect(parseBans(serializeBans(set))).toEqual(set)
  })
  it('lowercases on parse so case never lets a banned email back in', () => {
    expect(parseBans(JSON.stringify(['Alice@ACME.com']))).toEqual(new Set(['alice@acme.com']))
  })
  it('tolerates null / garbage / wrong shape', () => {
    expect(parseBans(null)).toEqual(new Set())
    expect(parseBans('{not json')).toEqual(new Set())
    expect(parseBans(JSON.stringify({ a: 1 }))).toEqual(new Set())
    expect(parseBans(JSON.stringify(['ok@x', 5, null]))).toEqual(new Set(['ok@x']))
  })
})

describe('serializeBans', () => {
  it('keeps only the most-recent cap entries', () => {
    const set = new Set(Array.from({ length: 10 }, (_, i) => `u${i}@x`))
    expect(JSON.parse(serializeBans(set, 3))).toEqual(['u7@x', 'u8@x', 'u9@x'])
  })
})
