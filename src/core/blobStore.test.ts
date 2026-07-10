import { describe, it, expect } from 'vitest'
import { blobHash, memBlobKV, planEviction, BlobStore, type BlobMeta } from './blobStore'

const bytes = (s: string) => new TextEncoder().encode(s)

describe('blobHash — the content address', () => {
  it('is deterministic and content-specific', () => {
    expect(blobHash(bytes('hello'))).toBe(blobHash(bytes('hello')))
    expect(blobHash(bytes('hello'))).not.toBe(blobHash(bytes('world')))
  })
  it('matches the known sha256 hex (so it agrees with the xfer integrity hash)', () => {
    // sha256("abc")
    expect(blobHash(bytes('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
})

describe('planEviction — quota GC, oldest-first, never a live ref', () => {
  const es: BlobMeta[] = [
    { hash: 'a', size: 100, at: 1 },
    { hash: 'b', size: 100, at: 2 },
    { hash: 'c', size: 100, at: 3 },
  ]
  it('evicts nothing when under the cap', () => {
    expect(planEviction(es, 1000)).toEqual([])
  })
  it('evicts oldest-first until under the cap', () => {
    expect(planEviction(es, 100)).toEqual(['a', 'b']) // 300 → drop a(1), b(2); c(3) fits 100
  })
  it('never evicts a kept (live-referenced) hash — even if that stays over cap', () => {
    // keep 'a' (the oldest): evict b then c; total 100 (just 'a') still > 50 but 'a' is protected.
    expect(planEviction(es, 50, new Set(['a']))).toEqual(['b', 'c'])
  })
  it('ties break by hash for determinism', () => {
    const tie: BlobMeta[] = [
      { hash: 'z', size: 100, at: 1 },
      { hash: 'y', size: 100, at: 1 },
      { hash: 'x', size: 100, at: 1 },
    ]
    expect(planEviction(tie, 100)).toEqual(['x', 'y']) // same at → alpha order, keep the last
  })
})

describe('BlobStore over memBlobKV', () => {
  it('put returns the content hash and dedups identical bytes', async () => {
    const store = new BlobStore(memBlobKV(), { now: () => 1 })
    const h1 = await store.put(bytes('same'))
    const h2 = await store.put(bytes('same'))
    expect(h1).toBe(h2)
    expect(h1).toBe(blobHash(bytes('same')))
  })
  it('get round-trips the bytes; has reflects presence', async () => {
    const store = new BlobStore(memBlobKV(), { now: () => 1 })
    const h = await store.put(bytes('payload'))
    expect(await store.has(h)).toBe(true)
    expect(new TextDecoder().decode((await store.get(h)) ?? new Uint8Array())).toBe('payload')
    expect(await store.has('deadbeef')).toBe(false)
    expect(await store.get('deadbeef')).toBeNull()
  })
  it('a caller mutating its buffer after put cannot corrupt the stored blob', async () => {
    const store = new BlobStore(memBlobKV(), { now: () => 1 })
    const buf = bytes('immutable')
    const h = await store.put(buf)
    buf[0] = 0
    expect(new TextDecoder().decode((await store.get(h)) ?? new Uint8Array())).toBe('immutable')
  })
  it('gc evicts oldest over the quota, sparing live refs', async () => {
    let t = 0
    const store = new BlobStore(memBlobKV(), { maxBytes: 12, now: () => ++t }) // ~each 6-byte blob
    const a = await store.put(bytes('aaaaaa')) // at 1
    const b = await store.put(bytes('bbbbbb')) // at 2
    const c = await store.put(bytes('cccccc')) // at 3 → total 18 > 12
    const evicted = await store.gc(new Set([a])) // protect the oldest
    // 18 > 12: evict oldest evictable — 'a' is kept, so 'b' goes (12 left = a+c), fits.
    expect(evicted).toEqual([b])
    expect(await store.has(a)).toBe(true)
    expect(await store.has(b)).toBe(false)
    expect(await store.has(c)).toBe(true)
  })
})
