import { describe, expect, it } from 'vitest'
import { MemSink, DiskReassembler, tightChunk, chooseSinkKind, fitsTransfer, sendRouteFor, SINK_MAX_BYTES, MAX_XFER_BYTES, INRAM_MAX_BYTES, type ChunkSink, type SinkKind } from './chunkSink'

const u8 = (...n: number[]) => new Uint8Array(n)

const fakeSink = (opts: { failWrite?: boolean } = {}): ChunkSink & { written: Uint8Array[] } => {
  const written: Uint8Array[] = []
  return {
    kind: 'mem',
    written,
    async write(c) {
      if (opts.failWrite) throw new Error('disk full')
      written.push(c)
    },
    async finish() {
      return new Blob(written as BlobPart[])
    },
    async abort() {
      written.length = 0
    },
  }
}

describe('MemSink — the in-RAM fallback', () => {
  it('appends ordered chunks and finishes to a Blob with the exact bytes', async () => {
    const s = new MemSink('application/octet-stream')
    await s.write(u8(1, 2, 3))
    await s.write(u8(4, 5))
    const blob = await s.finish()
    expect(blob.type).toBe('application/octet-stream')
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(u8(1, 2, 3, 4, 5))
  })
  it('defaults a blank mime to octet-stream', async () => {
    expect((await new MemSink('').finish()).type).toBe('application/octet-stream')
  })
  it('rejects a write after finish (no resurrecting a closed sink)', async () => {
    const s = new MemSink('text/plain')
    await s.finish()
    await expect(s.write(u8(9))).rejects.toThrow(/finished/)
  })
  it('abort drops buffered bytes', async () => {
    const s = new MemSink('x/y')
    await s.write(u8(1, 2, 3))
    await s.abort()
    expect((await s.finish()).size).toBe(0)
  })
})

describe('tightChunk — defuse the iOS write()-ignores-byteOffset corruption', () => {
  it('returns an already-tight (offset-0, full-length) chunk unchanged — no copy', () => {
    const tight = u8(1, 2, 3, 4)
    expect(tightChunk(tight)).toBe(tight) // same reference: zero-copy fast path
  })
  it('copies a sub-VIEW to a standalone offset-0 array carrying ONLY the view bytes', () => {
    // Model an xfer.v2 frame: a 41-byte header then the payload; decodeChunkFrame hands on `buf.subarray(41)`,
    // a view whose .buffer still includes the header. iOS write() would persist the whole buffer.
    const frame = new Uint8Array(41 + 5)
    frame.fill(0xaa, 0, 41) // header bytes (must NOT reach disk)
    frame.set(u8(1, 2, 3, 4, 5), 41) // the real payload
    const view = frame.subarray(41)
    const tight = tightChunk(view)
    expect(tight.byteOffset).toBe(0)
    expect(tight.byteLength).toBe(5)
    expect(tight.buffer.byteLength).toBe(5) // header is GONE from the backing buffer
    expect(tight).toEqual(u8(1, 2, 3, 4, 5))
  })
  it('a sink fed tightened sub-views assembles to the payload only (no leaked header)', async () => {
    // The regression: writing decodeChunkFrame views straight to a byteOffset-ignoring sink corrupts the file.
    const sink = fakeSink()
    for (let c = 0; c < 3; c++) {
      const frame = new Uint8Array(41 + 4)
      frame.fill(0xff, 0, 41)
      frame.set(u8(c, c, c, c), 41)
      await sink.write(tightChunk(frame.subarray(41)))
    }
    const bytes = new Uint8Array(await (await sink.finish()).arrayBuffer())
    expect(bytes).toEqual(u8(0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2)) // 12 payload bytes, zero header bytes
  })
})

describe('chooseSinkKind — best available, best-first', () => {
  it('prefers fsa, then opfs, then mem', () => {
    expect(chooseSinkKind({ fsa: true, opfs: true })).toBe('fsa')
    expect(chooseSinkKind({ fsa: false, opfs: true })).toBe('opfs')
    expect(chooseSinkKind({ fsa: false, opfs: false })).toBe('mem')
    expect(chooseSinkKind({})).toBe('mem')
  })
})

describe('size tiers', () => {
  it('fsa ≥ opfs > mem, and the anti-DoS ceiling is the largest tier', () => {
    expect(SINK_MAX_BYTES.fsa).toBeGreaterThanOrEqual(SINK_MAX_BYTES.opfs)
    expect(SINK_MAX_BYTES.opfs).toBeGreaterThan(SINK_MAX_BYTES.mem)
    expect(SINK_MAX_BYTES.mem).toBe(50 * 1024 * 1024)
    expect(MAX_XFER_BYTES).toBe(SINK_MAX_BYTES.fsa)
    expect(INRAM_MAX_BYTES).toBe(SINK_MAX_BYTES.mem)
  })
})

describe('sendRouteFor — adaptive route by size + peer capability', () => {
  const MB = 1024 * 1024
  const GB = 1024 * MB
  const full = { xfer: true, download: true }
  it('routes by size band for a fully-capable peer', () => {
    expect(sendRouteFor(10 * MB, full)).toBe('inline') // ≤50MB
    expect(sendRouteFor(50 * MB, full)).toBe('inline') // boundary inclusive
    expect(sendRouteFor(300 * MB, full)).toBe('stream') // 50MB..1GB
    expect(sendRouteFor(SINK_MAX_BYTES.opfs, full)).toBe('stream') // 1GB boundary inclusive
    expect(sendRouteFor(3 * GB, full)).toBe('download') // >1GB → pull handshake
    expect(sendRouteFor(SINK_MAX_BYTES.fsa, full)).toBe('download') // up to the ceiling
    expect(sendRouteFor(SINK_MAX_BYTES.fsa + 1, full)).toBe('skip') // past the sanity ceiling
  })
  it('a peer WITHOUT the download handshake caps at the OPFS tier (>1GB skipped)', () => {
    const noDl = { xfer: true, download: false }
    expect(sendRouteFor(800 * MB, noDl)).toBe('stream')
    expect(sendRouteFor(2 * GB, noDl)).toBe('skip') // can't pull-download → no path
  })
  it('a non-xfer (legacy) peer is always skip (caller uses the chat/img fallback)', () => {
    expect(sendRouteFor(1 * MB, { xfer: false, download: false })).toBe('skip')
  })
  it('rejects nonsense sizes', () => {
    expect(sendRouteFor(-1, full)).toBe('skip')
    expect(sendRouteFor(NaN, full)).toBe('skip')
  })
})

describe('fitsTransfer — tier cap + real free-space guard', () => {
  const tier: SinkKind = 'opfs'
  it('rejects above the sink tier, accepts at/below', () => {
    expect(fitsTransfer(SINK_MAX_BYTES.opfs, 'opfs')).toBe(true)
    expect(fitsTransfer(SINK_MAX_BYTES.opfs + 1, 'opfs')).toBe(false)
    expect(fitsTransfer(100 * 1024 * 1024, 'mem')).toBe(false) // over the 50MB mem tier
  })
  it('rejects when it would not fit the receiver free space (quota − usage) × 0.8', () => {
    const size = 800 * 1024 * 1024
    // quota 1GB, usage 0 → free 1GB, ×0.8 = 819MB → 800MB fits
    expect(fitsTransfer(size, tier, { quota: 1024 * 1024 * 1024, usage: 0 })).toBe(true)
    // same quota but 400MB already used → free 624MB, ×0.8 ≈ 499MB → 800MB does NOT fit
    expect(fitsTransfer(size, tier, { quota: 1024 * 1024 * 1024, usage: 400 * 1024 * 1024 })).toBe(false)
  })
  it('ignores the quota guard for mem (heap, not storage) and when no estimate is given', () => {
    expect(fitsTransfer(40 * 1024 * 1024, 'mem', { quota: 1, usage: 0 })).toBe(true) // mem skips the quota check
    expect(fitsTransfer(900 * 1024 * 1024, 'opfs')).toBe(true) // no estimate → tier cap only
  })
  it('rejects nonsense sizes', () => {
    expect(fitsTransfer(-1, 'opfs')).toBe(false)
    expect(fitsTransfer(NaN, 'opfs')).toBe(false)
  })
})

describe('DiskReassembler — sync add(), ordered async writes to a sink', () => {
  it('streams ordered chunks and assembles the exact bytes', async () => {
    const d = new DiskReassembler({ n: 3, size: 6 }, Promise.resolve(new MemSink('application/octet-stream')), 0)
    expect(d.add(0, u8(1, 2), 1)).toBe(true)
    expect(d.add(1, u8(3, 4), 2)).toBe(true)
    expect(d.progress).toBeCloseTo(2 / 3)
    expect(d.add(2, u8(5, 6), 3)).toBe(true)
    expect(d.complete).toBe(true)
    expect(new Uint8Array(await (await d.assembleBlob()).arrayBuffer())).toEqual(u8(1, 2, 3, 4, 5, 6))
  })
  it('rejects an out-of-order / gap chunk (a streamed sink cannot reorder)', () => {
    const d = new DiskReassembler({ n: 3, size: 6 }, Promise.resolve(new MemSink('x')), 0)
    expect(d.add(0, u8(1, 2), 1)).toBe(true)
    expect(d.add(2, u8(5, 6), 2)).toBe(false) // expected index 1
    expect(d.complete).toBe(false)
  })
  it('rejects a chunk that would exceed the declared size', () => {
    const d = new DiskReassembler({ n: 1, size: 2 }, Promise.resolve(new MemSink('x')), 0)
    expect(d.add(0, u8(1, 2, 3), 1)).toBe(false)
  })
  it('a failed disk write makes assembleBlob throw', async () => {
    const d = new DiskReassembler({ n: 1, size: 2 }, Promise.resolve(fakeSink({ failWrite: true })), 0)
    expect(d.add(0, u8(1, 2), 1)).toBe(true) // add is optimistic; the write fails async
    await expect(d.assembleBlob()).rejects.toThrow()
  })
  it('a sink that never opens (fit/permission reject) fails the transfer', async () => {
    const d = new DiskReassembler({ n: 1, size: 2 }, Promise.reject(new Error('no space')), 0)
    d.add(0, u8(1, 2), 1)
    await expect(d.assembleBlob()).rejects.toThrow()
  })
  it('abort blocks further writes', async () => {
    const d = new DiskReassembler({ n: 2, size: 4 }, Promise.resolve(fakeSink()), 0)
    d.add(0, u8(1, 2), 1)
    await d.abort()
    expect(d.add(1, u8(3, 4), 2)).toBe(false)
  })
  it('received tracks the resume point and a re-send from there is idempotent', async () => {
    const sink = fakeSink()
    const d = new DiskReassembler({ n: 4, size: 8 }, Promise.resolve(sink), 0)
    expect(d.received).toBe(0)
    d.add(0, u8(1, 2), 1)
    d.add(1, u8(3, 4), 2)
    expect(d.received).toBe(2) // the resume point reported in xresume{have:2}
    // a resume re-sends from 2; duplicate earlier chunks (i<received) are dropped, the channel continues at 2
    expect(d.add(1, u8(9, 9), 3)).toBe(false) // dup
    expect(d.add(0, u8(9, 9), 3)).toBe(false) // dup
    expect(d.add(2, u8(5, 6), 4)).toBe(true) // resumes cleanly
    expect(d.add(3, u8(7, 8), 5)).toBe(true)
    expect(d.complete).toBe(true)
    expect([...new Uint8Array(await (await d.assembleBlob()).arrayBuffer())]).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })
})
