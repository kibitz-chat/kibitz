import { describe, expect, it } from 'vitest'
import { APP_MAX_BYTES, appPayloadTooBig, appendChat, evictedBlobUrls, asContent, asBinaryChunk, rosterName, type ChatItem } from './useCall'
import { encodeChunkFrame } from '../core/contentXfer'
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
    expect(asContent({ k: 'xaccept', id: 't1' })?.k).toBe('xaccept')
    expect(asContent({ k: 'xdecline', id: 't1' })?.k).toBe('xdecline')
    expect(asContent({ k: 'xresume', id: 't1', have: 5 })?.k).toBe('xresume')
    expect(asContent({ k: 'xack', id: 't1' })?.k).toBe('xack')
    expect(asContent({ k: 'idtoken', jwt: 'x.y.z' })?.k).toBe('idtoken')
    expect(asContent({ k: 'caps', grants: { v1: { perceive: [], act: [] } } })?.k).toBe('caps')
    expect(asContent({ k: 'schema', name: 'app.view', version: '1', schema: {} })?.k).toBe('schema')
    expect(asContent({ k: 'widget', id: 'w1', kind: 'kbz.map', data: {} })?.k).toBe('widget')
    expect(asContent({ k: 'wevt', id: 'w1', e: { t: 'pin' } })?.k).toBe('wevt')
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

describe('asBinaryChunk — an xfer.v2 binary frame normalizes to an xchunk content msg', () => {
  it('decodes a binary frame into { k:xchunk, id, i, bytes }', () => {
    const frame = encodeChunkFrame('t1', 3, new Uint8Array([5, 6, 7]))
    const c = asBinaryChunk(frame)
    expect(c?.k).toBe('xchunk')
    expect(c?.id).toBe('t1')
    expect(c?.i).toBe(3)
    expect(c?.bytes && [...c.bytes]).toEqual([5, 6, 7])
    expect(c?.data).toBeUndefined() // binary path carries no base64
  })
  it('accepts an ArrayBuffer too, and returns null for a JSON object / non-binary', () => {
    const frame = encodeChunkFrame('t2', 0, new Uint8Array([9]))
    expect(asBinaryChunk(frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength))?.id).toBe('t2')
    expect(asBinaryChunk({ k: 'xchunk', id: 't', i: 0, data: 'AA==' })).toBeNull() // a JSON msg → asContent handles it
    expect(asBinaryChunk('hi')).toBeNull()
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

describe('evictedBlobUrls — free a transfer blob URL when its line leaves the buffer', () => {
  const att = (id: number, url?: string): ChatItem => ({
    from: 'v1',
    name: 'Ada',
    text: '',
    id,
    self: false,
    attachment: { xid: `x${id}`, kind: 'image', mime: 'image/jpeg', size: 1000, progress: 1, state: 'done', ...(url ? { url } : {}) },
  })
  it('returns blob: urls present in prev but gone from next (evicted)', () => {
    expect(evictedBlobUrls([att(1, 'blob:a'), att(2, 'blob:b')], [att(2, 'blob:b')])).toEqual(['blob:a'])
  })
  it('keeps a url that is still live in next', () => {
    expect(evictedBlobUrls([att(1, 'blob:a')], [att(1, 'blob:a')])).toEqual([])
  })
  it('ignores a NEW url that appears in next (a placeholder getting its blob)', () => {
    expect(evictedBlobUrls([att(1)], [att(1, 'blob:a')])).toEqual([])
  })
  it('only revokes blob: urls — data:/http:/missing are left alone', () => {
    const prev = [att(1, 'data:image/png;base64,AA'), att(2, 'https://x/y.png'), att(3)]
    expect(evictedBlobUrls(prev, [])).toEqual([])
  })
  it('catches the real path: appendChat dropping attachment lines past the cap', () => {
    let list: readonly ChatItem[] = []
    for (let i = 0; i < 4; i++) list = appendChat(list, att(i, `blob:${i}`), 2)
    expect(list.map((l) => l.attachment?.url)).toEqual(['blob:2', 'blob:3']) // only the last 2 survive
    expect(evictedBlobUrls([att(0, 'blob:0'), att(1, 'blob:1')], list)).toEqual(['blob:0', 'blob:1'])
  })
})
