import { describe, it, expect } from 'vitest'
import { freshRoom, roomFromInput } from './roomName'

const FRESH = /^[a-z]+-[a-z0-9]{10}$/ // word + 10-char code

describe('freshRoom', () => {
  it('is a sayable word + 10-char code, already normalized', () => {
    const r = freshRoom()
    expect(r).toMatch(FRESH)
  })
  it('is essentially never the same twice (the suffix is crypto-random)', () => {
    const seen = new Set(Array.from({ length: 50 }, () => freshRoom()))
    expect(seen.size).toBe(50)
  })
})

describe('roomFromInput — creator-chosen id, normalized, with a random fallback', () => {
  it('normalizes a typed name the same way every room id is', () => {
    expect(roomFromInput('Team Standup')).toBe('team-standup')
    expect(roomFromInput('  Friday   Game!! ')).toBe('friday-game')
  })
  it('falls back to a fresh room when the name is blank/whitespace', () => {
    expect(roomFromInput('')).toMatch(FRESH)
    expect(roomFromInput('   ')).toMatch(FRESH)
    expect(roomFromInput(undefined)).toMatch(FRESH)
  })
  it('falls back when the name normalizes to nothing (symbols only)', () => {
    expect(roomFromInput('!!!')).toMatch(FRESH)
    expect(roomFromInput('—')).toMatch(FRESH)
  })
  it('caps an over-long name to the room-id limit (40 chars)', () => {
    expect(roomFromInput('x'.repeat(80)).length).toBe(40)
  })
})
