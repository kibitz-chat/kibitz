import { describe, expect, it } from 'vitest'
import { serializeLedger, deserializeLedger, imageContentId } from './ledgerSnapshot'
import type { ChatItem } from './useCall'

const B64 = 'aGVsbG8=' // valid base64
const text = (mid: string, ts: number, from = 'aId', name = 'Alice', t = 'hi'): ChatItem => ({ id: ts, from, name, text: t, self: false, mid, ts })
const image = (data: string, ts: number, from = 'aId', name = 'Alice'): ChatItem => ({ id: ts, from, name, text: '', self: false, ts, image: { mime: 'image/png', data } })
const widget = (wid: string, ts: number): ChatItem => ({ id: ts, from: 'aId', name: 'Alice', text: '', self: false, ts, widget: { id: wid, kind: 'kbz.map', data: { pins: 1 } } })

describe('imageContentId — a stable content key so images are first-class ledger entries', () => {
  it('same bytes → same id; different bytes → different', () => {
    expect(imageContentId(B64)).toBe(imageContentId(B64))
    expect(imageContentId(B64)).not.toBe(imageContentId('d29ybGQ='))
    expect(imageContentId(B64)).toMatch(/^img:/)
  })
})

describe('serializeLedger — the held public chat → a durable snapshot', () => {
  it('captures text (by mid), image (by content id), widget (by id), ordered by ts', () => {
    const snap = serializeLedger([widget('w1', 30), image(B64, 20), text('t1', 10)], 100)
    expect(snap.map((s) => [s.kind, s.id])).toEqual([
      ['text', 't1'],
      ['image', imageContentId(B64)],
      ['widget', 'w1'],
    ])
  })

  it('never persists DMs, and skips text with no mid (no stable key)', () => {
    const dm: ChatItem = { ...text('t1', 10), dm: true }
    const noMid: ChatItem = { id: 2, from: 'a', name: 'A', text: 'x', self: true, ts: 11 } // no mid
    expect(serializeLedger([dm, noMid], 100)).toEqual([])
  })

  it('dedups by id — a re-posted identical image collapses to ONE entry (the feedback-loop case)', () => {
    const snap = serializeLedger([image(B64, 10), image(B64, 40)], 100) // same bytes twice
    expect(snap.filter((s) => s.kind === 'image')).toHaveLength(1)
  })

  it('caps to the most-recent keep', () => {
    const items = Array.from({ length: 10 }, (_, i) => text(`t${i}`, i))
    const snap = serializeLedger(items, 3)
    expect(snap.map((s) => s.id)).toEqual(['t7', 't8', 't9'])
  })
})

describe('deserializeLedger — parse an untrusted snapshot back to valid items', () => {
  it('round-trips serialize → deserialize', () => {
    const snap = serializeLedger([widget('w1', 30), image(B64, 20), text('t1', 10)], 100)
    const back = deserializeLedger(snap)
    expect(back.map((s) => [s.kind, s.id])).toEqual(snap.map((s) => [s.kind, s.id]))
    expect(back.find((s) => s.kind === 'image')?.image?.data).toBe(B64)
  })

  it('drops malformed entries (no id, bad kind, empty text, non-image image)', () => {
    const bad = [
      { kind: 'text', ts: 1 }, // no id
      { kind: 'text', id: 'a', text: '   ' }, // empty text
      { kind: 'image', id: 'b', image: { mime: 'text/plain', data: B64 } }, // not an image mime
      { kind: 'nope', id: 'c' }, // unknown kind
      null,
      'x',
    ]
    expect(deserializeLedger(bad)).toEqual([])
    expect(deserializeLedger('not an array' as unknown)).toEqual([])
  })

  it('keeps a well-formed image + falls back name→from→Guest', () => {
    const back = deserializeLedger([{ kind: 'image', id: 'i1', ts: 5, from: 'bob', image: { mime: 'image/png', data: B64 } }])
    expect(back).toHaveLength(1)
    expect(back[0]).toMatchObject({ kind: 'image', id: 'i1', name: 'bob' })
  })
})

const attach = (
  mid: string,
  ts: number,
  kind: 'image' | 'file',
  opts: { xid?: string; mime?: string; name?: string; size?: number; data?: string } = {},
): ChatItem => ({
  id: ts,
  from: 'aId',
  name: 'Alice',
  text: '',
  self: false,
  mid,
  ts,
  attachment: { xid: opts.xid ?? `x${ts}`, kind, mime: opts.mime ?? (kind === 'image' ? 'image/png' : 'application/pdf'), name: opts.name, size: opts.size ?? 3, progress: 1, state: 'done', data: opts.data },
})

describe('serializeLedger — attachments (uploaded images + files)', () => {
  it('captures an image attachment with bytes inline, keyed by the public mid', () => {
    const snap = serializeLedger([attach('m1', 10, 'image', { data: B64, mime: 'image/png', size: 5 })], 100)
    expect(snap).toHaveLength(1)
    expect(snap[0]).toMatchObject({ kind: 'attachment', id: 'm1' })
    expect(snap[0].attachment).toMatchObject({ kind: 'image', mime: 'image/png', size: 5, data: B64 })
  })

  it('captures a file attachment (name + mime + bytes)', () => {
    const snap = serializeLedger([attach('m2', 10, 'file', { data: B64, mime: 'application/pdf', name: 'report.pdf', size: 9 })], 100)
    expect(snap[0].attachment).toMatchObject({ kind: 'file', mime: 'application/pdf', name: 'report.pdf', size: 9, data: B64 })
  })

  it('falls back to the xid when the item has no public mid', () => {
    const it: ChatItem = { id: 1, from: 'aId', name: 'Alice', text: '', self: false, ts: 10, attachment: { xid: 'x-abc', kind: 'file', mime: 'application/pdf', size: 3, progress: 1, state: 'done', data: B64 } }
    expect(serializeLedger([it], 100)[0].id).toBe('x-abc')
  })

  it('over the byte cap → metadata only (no data), transcript still preserved', () => {
    const huge = 'A'.repeat(11 * 1024 * 1024) // > the base64 cap
    const snap = serializeLedger([attach('m3', 10, 'file', { data: huge, name: 'big.zip', size: 11 * 1024 * 1024 })], 100)
    expect(snap[0].attachment?.data).toBeUndefined()
    expect(snap[0].attachment).toMatchObject({ kind: 'file', name: 'big.zip' })
  })

  it('dedups by mid — a re-broadcast of the same upload collapses to one', () => {
    const snap = serializeLedger([attach('m4', 10, 'image', { data: B64 }), attach('m4', 40, 'image', { data: B64 })], 100)
    expect(snap.filter((s) => s.kind === 'attachment')).toHaveLength(1)
  })
})

describe('deserializeLedger — attachments', () => {
  it('round-trips an image + a file attachment', () => {
    const snap = serializeLedger([attach('m1', 10, 'image', { data: B64, size: 5 }), attach('m2', 20, 'file', { data: B64, name: 'a.pdf', mime: 'application/pdf', size: 9 })], 100)
    const back = deserializeLedger(snap)
    expect(back.map((s) => [s.kind, s.attachment?.kind])).toEqual([
      ['attachment', 'image'],
      ['attachment', 'file'],
    ])
    expect(back[1].attachment).toMatchObject({ name: 'a.pdf', mime: 'application/pdf', data: B64 })
  })

  it('drops an unknown attachment kind; keeps a metadata-only (no-data) entry as a chip', () => {
    const back = deserializeLedger([
      { kind: 'attachment', id: 'x1', ts: 1, from: 'a', attachment: { kind: 'zip', mime: 'x', size: 1 } },
      { kind: 'attachment', id: 'x2', ts: 2, from: 'a', attachment: { kind: 'file', mime: 'application/pdf', name: 'r.pdf', size: 4 } },
    ])
    expect(back).toHaveLength(1)
    expect(back[0]).toMatchObject({ id: 'x2', attachment: { kind: 'file', name: 'r.pdf' } })
    expect(back[0].attachment?.data).toBeUndefined()
  })

  it('strips non-base64 data on parse (kept as a chip)', () => {
    const back = deserializeLedger([{ kind: 'attachment', id: 'x3', ts: 1, from: 'a', attachment: { kind: 'image', mime: 'image/png', size: 1, data: 'not*base64!' } }])
    expect(back).toHaveLength(1)
    expect(back[0].attachment?.data).toBeUndefined()
  })
})
