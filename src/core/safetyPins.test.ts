import { describe, expect, it } from 'vitest'
import {
  dropPin,
  parsePins,
  pinKeyForName,
  pinStatus,
  serializePins,
  withPin,
  type SafetyPins,
} from './safetyPins'

describe('pinKeyForName', () => {
  it('trims + lowercases so trivial display differences share a contact', () => {
    expect(pinKeyForName('  Alice ')).toBe('alice')
    expect(pinKeyForName('ALICE')).toBe('alice')
  })
  it('empty/blank/nullish → "" so the caller skips pinning', () => {
    expect(pinKeyForName('')).toBe('')
    expect(pinKeyForName('   ')).toBe('')
    expect(pinKeyForName(undefined)).toBe('')
    expect(pinKeyForName(null)).toBe('')
  })
})

describe('pinStatus', () => {
  const pins: SafetyPins = { alice: 'fp-1' }
  it('unpinned when there is no pin (or an empty key)', () => {
    expect(pinStatus(pins, 'bob', 'fp-x')).toBe('unpinned')
    expect(pinStatus(pins, '', 'fp-1')).toBe('unpinned')
    expect(pinStatus({}, 'alice', 'fp-1')).toBe('unpinned')
  })
  it('match when the live fingerprint equals the pinned one', () => {
    expect(pinStatus(pins, 'alice', 'fp-1')).toBe('match')
  })
  it('mismatch when a known contact shows a DIFFERENT key (the cross-call alarm)', () => {
    expect(pinStatus(pins, 'alice', 'fp-2')).toBe('mismatch')
  })
})

describe('withPin / dropPin (immutable)', () => {
  it('adds a pin without mutating the input', () => {
    const a: SafetyPins = {}
    const b = withPin(a, 'alice', 'fp-1')
    expect(a).toEqual({})
    expect(b).toEqual({ alice: 'fp-1' })
  })
  it('re-verifying moves a contact to most-recent (re-inserted last)', () => {
    const pins = withPin(withPin(withPin({}, 'alice', 'fp-a'), 'bob', 'fp-b'), 'alice', 'fp-a2')
    expect(Object.keys(pins)).toEqual(['bob', 'alice']) // alice re-added at the end
    expect(pins.alice).toBe('fp-a2') // and to the new key
  })
  it('an empty key is a no-op', () => {
    const a: SafetyPins = { alice: 'fp-1' }
    expect(withPin(a, '', 'fp-x')).toBe(a)
  })
  it('dropPin removes a pin immutably; unknown/empty key is a no-op', () => {
    const a: SafetyPins = { alice: 'fp-1', bob: 'fp-2' }
    expect(dropPin(a, 'alice')).toEqual({ bob: 'fp-2' })
    expect(a).toEqual({ alice: 'fp-1', bob: 'fp-2' })
    expect(dropPin(a, 'carol')).toBe(a)
    expect(dropPin(a, '')).toBe(a)
  })
})

describe('parse/serialize round-trip', () => {
  it('round-trips a normal store', () => {
    const pins: SafetyPins = { alice: 'fp-1', bob: 'fp-2' }
    expect(parsePins(serializePins(pins))).toEqual(pins)
  })
  it('tolerates junk → empty', () => {
    expect(parsePins(null)).toEqual({})
    expect(parsePins('not json')).toEqual({})
    expect(parsePins('[1,2,3]')).toEqual({}) // array, not a map
    expect(parsePins('123')).toEqual({})
  })
  it('drops non-string values defensively', () => {
    expect(parsePins(JSON.stringify({ alice: 'fp-1', bob: 42, '': 'x' }))).toEqual({ alice: 'fp-1' })
  })
  it('caps to the most-recent N (oldest insertion dropped first)', () => {
    let pins: SafetyPins = {}
    for (let i = 0; i < 5; i++) pins = withPin(pins, `c${i}`, `fp-${i}`)
    const kept = parsePins(serializePins(pins, 3))
    expect(Object.keys(kept)).toEqual(['c2', 'c3', 'c4'])
  })
})
