import { describe, expect, it } from 'vitest'
import { APP_MAX_BYTES, appPayloadTooBig, appendChat, asContent, rosterName, type ChatItem } from './useCall'
import type { CallMember } from '../core/protocol'

const roster: CallMember[] = [
  { id: 'v1', name: 'Ada', cam: false },
  { id: 'v2', name: 'Bo', cam: false },
]

describe('rosterName — attribute a sender from the roster (not the wire)', () => {
  it('returns the roster name for a known id', () => {
    expect(rosterName(roster, 'v1')).toBe('Ada')
    expect(rosterName(roster, 'v2')).toBe('Bo')
  })
  it("falls back to 'Guest' for an unknown id", () => {
    expect(rosterName(roster, 'nope')).toBe('Guest')
    expect(rosterName([], 'v1')).toBe('Guest')
  })
})

describe('asContent — narrow an opaque mesh message', () => {
  it('accepts the known content kinds', () => {
    expect(asContent({ k: 'chat', text: 'hi' })).toEqual({ k: 'chat', text: 'hi' })
    expect(asContent({ k: 'app', data: { x: 1 } })?.k).toBe('app')
    expect(asContent({ k: 'pay', url: 'https://x' })?.k).toBe('pay')
    expect(asContent({ k: 'ink', e: { k: 'clear' } })?.k).toBe('ink')
    expect(asContent({ k: 'idtoken', jwt: 'x.y.z' })?.k).toBe('idtoken')
    expect(asContent({ k: 'caps', grants: { v1: { perceive: [], act: [] } } })?.k).toBe('caps')
    expect(asContent({ k: 'schema', name: 'app.view', version: '1', schema: {} })?.k).toBe('schema')
  })
  it('preserves the dm flag on a directed message', () => {
    expect(asContent({ k: 'chat', text: 'psst', dm: true })).toEqual({ k: 'chat', text: 'psst', dm: true })
    expect((asContent({ k: 'pay', url: 'https://x', dm: true }) as { dm?: boolean })?.dm).toBe(true)
  })
  it('rejects junk / unknown kinds', () => {
    expect(asContent(null)).toBeNull()
    expect(asContent('hi')).toBeNull()
    expect(asContent({})).toBeNull()
    expect(asContent({ k: 'evil' })).toBeNull()
  })
})

describe('appPayloadTooBig — app-message DoS backstop', () => {
  it('passes normal app payloads (co-browse / game state)', () => {
    expect(appPayloadTooBig({ page: 'https://example.com/docs', scroll: 1200 })).toBe(false)
    expect(appPayloadTooBig({ hand: ['7♠', 'K♥'], turn: 3 })).toBe(false)
  })
  it('flags a payload over the size cap', () => {
    expect(appPayloadTooBig({ blob: 'x'.repeat(APP_MAX_BYTES + 1) })).toBe(true)
  })
  it('lets non-JSON-serializable payloads through (cannot measure cheaply — app bounds those)', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(appPayloadTooBig(cyclic)).toBe(false)
  })
})

describe('appendChat — capped buffer', () => {
  const line = (id: number): ChatItem => ({ from: 'v1', name: 'Ada', text: `m${id}`, id, self: false })
  it('drops the oldest past the cap', () => {
    let list: readonly ChatItem[] = []
    for (let i = 0; i < 5; i++) list = appendChat(list, line(i), 3)
    expect(list.map((l) => l.id)).toEqual([2, 3, 4])
  })
})
