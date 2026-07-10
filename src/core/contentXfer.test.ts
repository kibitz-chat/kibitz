import { describe, expect, it } from 'vitest'
import { XFER, XFER_KINDS, chunkCount, splitChunks, bytesToBase64, base64ToBytes, textToBytes, bytesToText, validateBegin, Reassembler, encodeChunkFrame, decodeChunkFrame, asBytes, minSendProgress, allSendsComplete, type XferBegin } from './contentXfer'

describe('sender-side broadcast progress aggregation', () => {
  it('minSendProgress shows the SLOWEST peer (min), clamped to [0,1]', () => {
    expect(minSendProgress([0.2, 0.9, 0.5])).toBeCloseTo(0.2)
    expect(minSendProgress([1, 1, 1])).toBe(1)
    expect(minSendProgress([0.4])).toBeCloseTo(0.4)
    expect(minSendProgress([1.5, 2])).toBe(1) // clamped high
    expect(minSendProgress([-0.1, 0.3])).toBe(0) // clamped low
  })
  it('minSendProgress is 0 when no peer is tracked yet', () => {
    expect(minSendProgress([])).toBe(0)
    expect(minSendProgress(new Map<string, number>().values())).toBe(0)
  })
  it('allSendsComplete only when EVERY tracked peer has the whole file', () => {
    expect(allSendsComplete([1, 1])).toBe(true)
    expect(allSendsComplete([1, 0.99])).toBe(false) // one peer still receiving
    expect(allSendsComplete([])).toBe(false) // nothing tracked → not "done"
    expect(allSendsComplete([1])).toBe(true)
  })
})

describe('xfer.v2 binary chunk frame', () => {
  const u8 = (...n: number[]) => new Uint8Array(n)
  it('round-trips id + index + payload', () => {
    const f = encodeChunkFrame('abc-123', 7, u8(10, 20, 30))
    const d = decodeChunkFrame(f)
    expect(d).not.toBeNull()
    expect(d!.id).toBe('abc-123')
    expect(d!.i).toBe(7)
    expect([...d!.bytes]).toEqual([10, 20, 30])
  })
  it('handles an empty payload, a large index, and a 64-char id', () => {
    const id = 'x'.repeat(64)
    const d = decodeChunkFrame(encodeChunkFrame(id, 21844, new Uint8Array(0)))!
    expect(d.id).toBe(id)
    expect(d.i).toBe(21844)
    expect(d.bytes.length).toBe(0)
  })
  it('preserves real chunk bytes through split → frame → decode', () => {
    const src = textToBytes('the quick brown fox 🦊 over a binary channel'.repeat(40))
    const parts = splitChunks(src)
    const back = new Uint8Array(src.length)
    let off = 0
    parts.forEach((p, i) => {
      const d = decodeChunkFrame(encodeChunkFrame('xid', i, p))!
      expect(d.i).toBe(i)
      back.set(d.bytes, off)
      off += d.bytes.length
    })
    expect(bytesToText(back)).toBe(bytesToText(src))
  })
  it('rejects a too-short / malformed frame', () => {
    expect(decodeChunkFrame(u8())).toBeNull()
    expect(decodeChunkFrame(u8(1, 2))).toBeNull() // shorter than the header
    expect(decodeChunkFrame(u8(0, 0, 0, 0, 0))).toBeNull() // idLen 0
    const f = encodeChunkFrame('id', 1, u8(9))
    expect(decodeChunkFrame(f.subarray(0, 3))).toBeNull() // truncated mid-header
  })
  it('asBytes normalizes ArrayBuffer / typed-array, rejects objects', () => {
    expect([...asBytes(u8(1, 2))!]).toEqual([1, 2])
    expect([...asBytes(u8(1, 2, 3).buffer)!]).toEqual([1, 2, 3])
    expect(asBytes({ k: 'xchunk' })).toBeNull()
    expect(asBytes('hi')).toBeNull()
    expect(asBytes(null)).toBeNull()
  })
})

describe('chunkCount', () => {
  it('is ceil(size/chunk), and 0 for an empty payload', () => {
    expect(chunkCount(0, 100)).toBe(0)
    expect(chunkCount(1, 100)).toBe(1)
    expect(chunkCount(100, 100)).toBe(1)
    expect(chunkCount(101, 100)).toBe(2)
    expect(chunkCount(250, 100)).toBe(3)
  })
})

describe('splitChunks', () => {
  it('splits into ordered ≤chunkBytes pieces that recombine to the original', () => {
    const bytes = new Uint8Array(250).map((_, i) => i % 256)
    const chunks = splitChunks(bytes, 100)
    expect(chunks.map((c) => c.length)).toEqual([100, 100, 50])
    expect(chunks.length).toBe(chunkCount(250, 100))
    const joined = new Uint8Array(250)
    let off = 0
    for (const c of chunks) {
      joined.set(c, off)
      off += c.length
    }
    expect([...joined]).toEqual([...bytes])
  })
  it('an empty payload yields no chunks', () => {
    expect(splitChunks(new Uint8Array(0), 100)).toEqual([])
  })
})

describe('base64 + text round-trips (cross-env)', () => {
  it('bytes → base64 → bytes is lossless, incl. binary + large payloads', () => {
    const bin = new Uint8Array([0, 1, 2, 254, 255, 128, 127])
    expect([...base64ToBytes(bytesToBase64(bin))]).toEqual([...bin])
    const big = new Uint8Array(100_000).map((_, i) => (i * 7) % 256)
    expect([...base64ToBytes(bytesToBase64(big))]).toEqual([...big])
  })
  it('text → bytes → text survives unicode', () => {
    const s = 'hi 👋 שלום 🎉'
    expect(bytesToText(textToBytes(s))).toBe(s)
    // and through base64 too (the wire path)
    expect(bytesToText(base64ToBytes(bytesToBase64(textToBytes(s))))).toBe(s)
  })
})

describe('validateBegin — receive-side trust boundary', () => {
  const good = { id: 't1', kind: 'file', size: 250, n: chunkCount(250, XFER.CHUNK_BYTES), mime: 'application/pdf', name: 'a.pdf' }
  it('passes a well-formed begin and normalizes optional fields', () => {
    expect(validateBegin(good)).toEqual({ id: 't1', kind: 'file', size: 250, n: 1, mime: 'application/pdf', name: 'a.pdf' })
  })
  it('lists exactly text/image/file as the allowed kinds', () => {
    expect([...XFER_KINDS]).toEqual(['text', 'image', 'file'])
  })
  it('rejects a missing id, a bad kind, and a negative/oversized size', () => {
    expect(validateBegin({ ...good, id: '' })).toBeNull()
    expect(validateBegin({ ...good, kind: 'video' })).toBeNull()
    expect(validateBegin({ ...good, size: -1, n: 0 })).toBeNull()
    expect(validateBegin({ ...good, size: XFER.MAX_BYTES + 1, n: chunkCount(XFER.MAX_BYTES + 1) })).toBeNull()
  })
  it("rejects an n that doesn't match the declared size (anti-forgery)", () => {
    expect(validateBegin({ ...good, n: 1, size: XFER.CHUNK_BYTES * 5 })).toBeNull() // claims 1 chunk for a 5-chunk size
    expect(validateBegin({ ...good, n: 999, size: 250 })).toBeNull()
  })
  it('carries the optional chat mid+ts (a public TEXT transfer) and bounds them', () => {
    const textBegin = { id: 't2', kind: 'text', size: 5, n: chunkCount(5, XFER.CHUNK_BYTES), mid: 'peerA#3', ts: 1717000000000 }
    expect(validateBegin(textBegin)).toEqual({ id: 't2', kind: 'text', size: 5, n: 1, mid: 'peerA#3', ts: 1717000000000 })
    // An over-long mid is sliced; a non-finite ts is dropped (omitted, not NaN).
    const out = validateBegin({ ...textBegin, mid: 'x'.repeat(200), ts: Number.POSITIVE_INFINITY })
    expect(out?.mid).toHaveLength(80)
    expect('ts' in (out as object)).toBe(false)
  })
  it('omits mid/ts when absent (a file/image transfer or an old text peer)', () => {
    const out = validateBegin(good)
    expect('mid' in (out as object)).toBe(false)
    expect('ts' in (out as object)).toBe(false)
  })
  it('carries the optional REPLAYED-history author override and bounds it', () => {
    const replay = { id: 't3', kind: 'text', size: 4, n: chunkCount(4, XFER.CHUNK_BYTES), mid: 'alice#1', ts: 1717000000001, author: 'aliceId', authorName: 'Alice' }
    expect(validateBegin(replay)).toEqual({ id: 't3', kind: 'text', size: 4, n: 1, mid: 'alice#1', ts: 1717000000001, author: 'aliceId', authorName: 'Alice' })
    const out = validateBegin({ ...replay, author: 'a'.repeat(200), authorName: '   ' })
    expect(out?.author).toHaveLength(80)
    expect('authorName' in (out as object)).toBe(false) // a blank name is dropped
  })
  it('omits author/authorName when absent (a live message — no override)', () => {
    const out = validateBegin({ id: 't4', kind: 'text', size: 3, n: chunkCount(3, XFER.CHUNK_BYTES), mid: 'm#1', ts: 1 })
    expect('author' in (out as object)).toBe(false)
    expect('authorName' in (out as object)).toBe(false)
  })
})

describe('Reassembler — bounded, order-independent reassembly', () => {
  const begin: XferBegin = { id: 't', kind: 'file', size: 250, n: 3 }
  const c = (len: number, fill: number) => new Uint8Array(len).fill(fill)

  it('accepts chunks in any order and assembles the full payload', () => {
    const r = new Reassembler(begin, 0)
    expect(r.add(2, c(50, 3), 1)).toBe(true)
    expect(r.complete).toBe(false)
    expect(r.add(0, c(100, 1), 2)).toBe(true)
    expect(r.progress).toBeCloseTo(2 / 3)
    expect(r.add(1, c(100, 2), 3)).toBe(true)
    expect(r.complete).toBe(true)
    const out = r.assemble()
    expect(out.length).toBe(250)
    expect(out[0]).toBe(1)
    expect(out[100]).toBe(2)
    expect(out[200]).toBe(3)
    expect(r.lastAt).toBe(3) // tracks the last accepted chunk for stall-reaping
  })

  it('rejects out-of-range, duplicate, and over-size chunks', () => {
    const r = new Reassembler(begin, 0)
    expect(r.add(-1, c(10, 0), 1)).toBe(false)
    expect(r.add(3, c(10, 0), 1)).toBe(false) // n=3 → valid indices 0..2
    expect(r.add(0, c(100, 1), 1)).toBe(true)
    expect(r.add(0, c(100, 1), 1)).toBe(false) // duplicate
    expect(r.add(1, c(9999, 9), 1)).toBe(false) // would exceed the declared size
  })

  it('end-to-end: split → base64 each chunk → reassemble matches the source', () => {
    const src = textToBytes('the quick brown fox 🦊 over a 50MB-capped channel')
    const parts = splitChunks(src, 8)
    const b = { id: 'x', kind: 'text' as const, size: src.length, n: parts.length }
    const r = new Reassembler(b, 0)
    parts.forEach((p, i) => r.add(i, base64ToBytes(bytesToBase64(p)), i))
    expect(r.complete).toBe(true)
    expect(bytesToText(r.assemble())).toBe('the quick brown fox 🦊 over a 50MB-capped channel')
  })
})
