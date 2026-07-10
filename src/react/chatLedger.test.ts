import { describe, it, expect } from 'vitest'
import { chatToLedger, ledgerToChat, DEFAULT_CHAT_TTL_MS } from './chatLedger'
import { mergeLedger, type LedgerState, type OwnedEntry } from '../core/roomLedger'
import { blobHash } from '../core/blobStore'
import { base64ToBytes } from '../core/contentXfer'
import type { ChatItem } from './useCall'

const B64 = 'aGVsbG8=' // "hello"
const HASH = blobHash(base64ToBytes(B64))
const NOW = 1_000_000

const text = (mid: string, ts: number, t = 'hi', from = 'aId', name = 'Alice'): ChatItem => ({ id: ts, from, name, text: t, self: false, mid, ts })
const img = (mid: string, ts: number): ChatItem => ({ id: ts, from: 'aId', name: 'Alice', text: '', self: false, mid, ts, image: { mime: 'image/png', data: B64 } })
const file = (mid: string, ts: number, name = 'report.pdf', data: string | undefined = B64): ChatItem => ({
  id: ts, from: 'aId', name: 'Alice', text: '', self: false, mid, ts,
  attachment: { xid: `x${ts}`, kind: 'file', mime: 'application/pdf', name, size: 5, progress: 1, state: 'done', data },
})
const vid = (mid: string, ts: number): ChatItem => ({
  id: ts, from: 'bId', name: 'Bob', text: '', self: false, mid, ts,
  attachment: { xid: `x${ts}`, kind: 'file', mime: 'video/mp4', name: 'clip.mp4', size: 9_000_000, progress: 1, state: 'done' }, // large → no inline data
})
const widget = (wid: string, ts: number): ChatItem => ({ id: ts, from: 'aId', name: 'Alice', text: '', self: false, mid: wid, ts, widget: { id: wid, kind: 'kbz.map', data: { pins: 1 } } })

// narrow an Entry (owned|attested) to the owned value for assertions
const ownedVal = (led: LedgerState, key: string): Record<string, unknown> => (led[key] as OwnedEntry).value as Record<string, unknown>

describe('chatToLedger — chat buffer → roomLedger owned keys', () => {
  it('text/widget/media become owned entries keyed by mid', () => {
    const led = chatToLedger([text('m1', 10), file('m2', 20), widget('w1', 30)], { now: NOW })
    expect(Object.keys(led).sort()).toEqual(['m1', 'm2', 'w1'])
    expect(led.m1).toMatchObject({ kind: 'owned', author: 'aId', seq: 10, value: { t: 'text', text: 'hi' } })
    expect(ownedVal(led, 'm2')).toMatchObject({ t: 'media', media: 'file', mime: 'application/pdf', fileName: 'report.pdf', hash: HASH })
  })

  it('media carries a hash REF, never bytes', () => {
    const v = ownedVal(chatToLedger([img('m1', 10)], { now: NOW }), 'm1')
    expect(v.hash).toBe(HASH)
    expect(v).not.toHaveProperty('data') // no inline bytes in the ledger
    expect(v).not.toHaveProperty('image')
  })

  it('a large upload with no retained bytes is a ref with no hash (bytes fetched later, or a chip)', () => {
    const v = ownedVal(chatToLedger([vid('m1', 10)], { now: NOW }), 'm1')
    expect(v).toMatchObject({ t: 'media', media: 'file', mime: 'video/mp4', fileName: 'clip.mp4' })
    expect(v.hash).toBeUndefined()
  })

  it('never persists DMs or keyless lines; sets expireAt from now + ttl', () => {
    const dm: ChatItem = { ...text('m1', 10), dm: true }
    const noMid: ChatItem = { id: 2, from: 'a', name: 'A', text: 'x', self: true, ts: 11 }
    const led = chatToLedger([dm, noMid, text('m2', 12)], { now: NOW, ttlMs: 5000 })
    expect(Object.keys(led)).toEqual(['m2'])
    expect(led.m2.kind === 'owned' && led.m2.expireAt).toBe(NOW + 5000)
  })
})

describe('ledgerToChat — ledger → ordered chat lines', () => {
  it('round-trips, ascending ts', () => {
    const led = chatToLedger([widget('w1', 30), file('m2', 20), text('m1', 10)], { now: NOW })
    const lines = ledgerToChat(led, NOW)
    expect(lines.map((l) => [l.key, l.value.t])).toEqual([
      ['m1', 'text'],
      ['m2', 'media'],
      ['w1', 'widget'],
    ])
  })

  it('drops expired owned entries', () => {
    const led = chatToLedger([text('m1', 10)], { now: 0, ttlMs: 100 }) // expireAt = 100
    expect(ledgerToChat(led, 50)).toHaveLength(1)
    expect(ledgerToChat(led, 200)).toHaveLength(0)
  })

  it('drops malformed / unknown values (untrusted state)', () => {
    const bad = {
      k1: { kind: 'owned', author: 'a', seq: 1, expireAt: NOW + 1000, value: { t: 'text' } }, // no text
      k2: { kind: 'owned', author: 'a', seq: 2, expireAt: NOW + 1000, value: { t: 'nope' } }, // unknown t
      k3: { kind: 'owned', author: 'a', seq: 3, expireAt: NOW + 1000, value: { t: 'media', media: 'zip', mime: 'x', size: 1 } }, // bad media
      k4: { kind: 'attested', adds: [], removes: [] }, // not owned
      k5: { kind: 'owned', author: 'a', seq: 5, expireAt: NOW + 1000, value: { t: 'text', text: 'ok' } }, // good
    } as const
    const lines = ledgerToChat(bad as never, NOW)
    expect(lines.map((l) => l.key)).toEqual(['k5'])
  })
})

describe('convergence — the room is the CRDT union (why this replaces per-item re-broadcast)', () => {
  it('two peers merge to the same ordered union, deduping shared lines', () => {
    // A saw m1, m2; B saw m2, m3 — overlapping. The merged ledger is the union, m2 once.
    const a = chatToLedger([text('m1', 10), file('m2', 20)], { now: NOW })
    const b = chatToLedger([file('m2', 20), text('m3', 30)], { now: NOW })
    const merged = mergeLedger(a, b)
    expect(ledgerToChat(merged, NOW).map((l) => l.key)).toEqual(['m1', 'm2', 'm3'])
    // merge is commutative — order of peers doesn't matter.
    expect(ledgerToChat(mergeLedger(b, a), NOW).map((l) => l.key)).toEqual(['m1', 'm2', 'm3'])
  })

  it('a video ref converges to a late peer that never received the bytes (the reported bug)', () => {
    // Uploader A holds the video; late joiner B holds nothing. B merges A's ledger → sees the ref (bytes then
    // fetched by hash via blobSync). No 30MB replay budget to fall off.
    const a = chatToLedger([vid('m1', 10)], { now: NOW })
    const b: ReturnType<typeof chatToLedger> = {}
    const merged = mergeLedger(b, a)
    const line = ledgerToChat(merged, NOW)[0]
    expect(line.value).toMatchObject({ t: 'media', media: 'file', mime: 'video/mp4', fileName: 'clip.mp4' })
  })

  it('DEFAULT_CHAT_TTL_MS is a sane, generous bound', () => {
    expect(DEFAULT_CHAT_TTL_MS).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000)
  })
})
