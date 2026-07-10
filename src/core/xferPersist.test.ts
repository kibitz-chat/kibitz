import { describe, expect, it } from 'vitest'
import { savePartial, deletePartial, loadPartials, findSendKeyByXid, type KV, type PartialReceive } from './xferPersist'

// A localStorage-shaped KV backed by a Map (insertion order → key(i) is stable).
const memKV = (): KV => {
  const m = new Map<string, string>()
  return {
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    key: (i) => [...m.keys()][i] ?? null,
    get length() {
      return m.size
    },
  }
}

const rec = (over: Partial<PartialReceive> = {}): PartialReceive => ({
  xid: 'x1',
  room: 'fjord-9',
  from: 'peerA',
  fromName: 'Ada',
  sinkName: 'xfer-abc',
  kind: 'file',
  mime: 'application/zip',
  name: 'big.zip',
  size: 3_000_000_000,
  n: 60000,
  dm: false,
  ...over,
})

describe('xferPersist — partial-receive records survive a reload', () => {
  it('saves, loads (scoped to the room), and deletes', () => {
    const kv = memKV()
    savePartial(kv, rec({ xid: 'x1' }))
    savePartial(kv, rec({ xid: 'x2', name: 'movie.mp4' }))
    savePartial(kv, rec({ xid: 'y1', room: 'other-room' }))
    const got = loadPartials(kv, 'fjord-9').map((r) => r.xid).sort()
    expect(got).toEqual(['x1', 'x2']) // not the other room's record
    deletePartial(kv, 'fjord-9', 'x1')
    expect(loadPartials(kv, 'fjord-9').map((r) => r.xid)).toEqual(['x2'])
  })
  it('round-trips every field', () => {
    const kv = memKV()
    const r = rec()
    savePartial(kv, r)
    expect(loadPartials(kv, r.room)[0]).toEqual(r)
  })
  it('tolerates a corrupt / foreign record without throwing', () => {
    const kv = memKV()
    kv.setItem('kbz.xfer.v1.fjord-9.bad', '{not json')
    kv.setItem('kbz.xfer.v1.fjord-9.partial', JSON.stringify({ xid: 'z', room: 'fjord-9' })) // missing fields
    kv.setItem('unrelated.key', 'whatever')
    savePartial(kv, rec({ xid: 'ok' }))
    expect(loadPartials(kv, 'fjord-9').map((r) => r.xid)).toEqual(['ok'])
  })
  it('handles a room name with special chars (encoded in the key)', () => {
    const kv = memKV()
    savePartial(kv, rec({ room: 'a.b/c' }))
    expect(loadPartials(kv, 'a.b/c').length).toBe(1)
    expect(loadPartials(kv, 'a.b').length).toBe(0) // no prefix collision
  })
})

describe('findSendKeyByXid — match a resume across a changed peer id', () => {
  it('finds the retained send by xid regardless of the peer prefix', () => {
    const keys = ['peerA/x1', 'peerB/x2', 'peerA/x3']
    expect(findSendKeyByXid(keys, 'x2')).toBe('peerB/x2')
    expect(findSendKeyByXid(keys, 'x3')).toBe('peerA/x3')
    expect(findSendKeyByXid(keys, 'nope')).toBeNull()
  })
})
