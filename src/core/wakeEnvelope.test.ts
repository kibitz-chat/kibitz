import { describe, expect, it } from 'vitest'
import { parseWakeEnvelope } from './wakeEnvelope'

describe('parseWakeEnvelope — the untrusted wake-push wire contract', () => {
  const ok = { v: 1, kind: 'wake', roomId: 'team-standup-42', label: 'Alice is calling' }

  it('accepts a well-formed envelope and returns roomId + label', () => {
    expect(parseWakeEnvelope(ok)).toEqual({ roomId: 'team-standup-42', label: 'Alice is calling' })
  })

  it('defaults label to empty when absent or not a string', () => {
    expect(parseWakeEnvelope({ v: 1, kind: 'wake', roomId: 'abc-1' })).toEqual({ roomId: 'abc-1', label: '' })
    expect(parseWakeEnvelope({ ...ok, label: 123 })).toEqual({ roomId: ok.roomId, label: '' })
  })

  it('clamps an over-long label to 80 chars', () => {
    const got = parseWakeEnvelope({ ...ok, label: 'x'.repeat(500) })
    expect(got?.label.length).toBe(80)
  })

  it('drops an unknown version or verb (forward-compat: old SW ignores new kinds)', () => {
    expect(parseWakeEnvelope({ ...ok, v: 2 })).toBeNull()
    expect(parseWakeEnvelope({ ...ok, kind: 'something-else' })).toBeNull()
    expect(parseWakeEnvelope({ kind: 'wake', roomId: 'abc-1' })).toBeNull() // missing v
  })

  it('rejects a missing, non-string, or out-of-charset room id', () => {
    expect(parseWakeEnvelope({ v: 1, kind: 'wake' })).toBeNull()
    expect(parseWakeEnvelope({ v: 1, kind: 'wake', roomId: 42 })).toBeNull()
    expect(parseWakeEnvelope({ v: 1, kind: 'wake', roomId: 'Has Spaces' })).toBeNull()
    expect(parseWakeEnvelope({ v: 1, kind: 'wake', roomId: '../etc/passwd' })).toBeNull()
    expect(parseWakeEnvelope({ v: 1, kind: 'wake', roomId: 'UPPER' })).toBeNull() // not normalizeRoom output
  })

  it('rejects an over-long or too-short room id (bounds the URL the SW opens)', () => {
    expect(parseWakeEnvelope({ v: 1, kind: 'wake', roomId: 'ab' })).toBeNull()
    expect(parseWakeEnvelope({ v: 1, kind: 'wake', roomId: 'a'.repeat(65) })).toBeNull()
  })

  it('rejects non-objects', () => {
    for (const x of [null, undefined, 'wake', 42, true, []]) expect(parseWakeEnvelope(x)).toBeNull()
  })
})
