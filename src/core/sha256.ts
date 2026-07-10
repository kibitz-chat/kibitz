// Incremental SHA-256 (FIPS 180-4) — pure TS, no deps. Web Crypto's `crypto.subtle.digest` is ONE-SHOT
// (needs the whole buffer), so a streamed / disk-backed transfer can't use it; this hashes chunk-by-chunk
// as bytes flow past, on both ends, with no extra read pass. JS throughput (~hundreds of MB/s) far exceeds
// a P2P data channel, so the hash never bottlenecks the transfer. Tested against the NIST vectors.

// Round constants — the first 32 bits of the fractional parts of the cube roots of the first 64 primes.
// prettier-ignore
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n))

/** A streaming SHA-256: `update()` any number of byte runs, then `hex()`/`digest()` once. */
export class Sha256 {
  private readonly h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19])
  private readonly buf = new Uint8Array(64) // a partial 64-byte block carried between updates
  private bufLen = 0
  private total = 0 // total bytes hashed (for the length padding)
  private readonly w = new Uint32Array(64) // message schedule (reused)
  private done = false

  update(data: Uint8Array): this {
    if (this.done) throw new Error('sha256: update after digest')
    this.total += data.length
    this.absorbInto(data)
    return this
  }

  private block(p: Uint8Array, off: number): void {
    const w = this.w
    for (let t = 0; t < 16; t++) w[t] = ((p[off + t * 4] << 24) | (p[off + t * 4 + 1] << 16) | (p[off + t * 4 + 2] << 8) | p[off + t * 4 + 3]) >>> 0
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3)
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10)
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0
    }
    let a = this.h[0], b = this.h[1], c = this.h[2], d = this.h[3], e = this.h[4], f = this.h[5], g = this.h[6], h = this.h[7]
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (h + S1 + ch + K[t] + w[t]) | 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) | 0
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0
    }
    this.h[0] = (this.h[0] + a) | 0
    this.h[1] = (this.h[1] + b) | 0
    this.h[2] = (this.h[2] + c) | 0
    this.h[3] = (this.h[3] + d) | 0
    this.h[4] = (this.h[4] + e) | 0
    this.h[5] = (this.h[5] + f) | 0
    this.h[6] = (this.h[6] + g) | 0
    this.h[7] = (this.h[7] + h) | 0
  }

  /** Finalize (pad + 64-bit length) and return the 32-byte digest. Single-use — call once. */
  digest(): Uint8Array {
    if (this.done) throw new Error('sha256: digest already taken')
    const bits = this.total * 8
    // One trailing run: 0x80, zeros to a 56-mod-64 boundary, then the 64-bit big-endian bit length, so the
    // whole appended run is a multiple of 64. (absorbInto feeds it through block() WITHOUT the done check.)
    const padLen = this.bufLen < 56 ? 56 - this.bufLen : 120 - this.bufLen
    const tail = new Uint8Array(padLen + 8)
    tail[0] = 0x80
    const tv = new DataView(tail.buffer)
    tv.setUint32(padLen, Math.floor(bits / 0x100000000)) // high 32 bits of the length (handles >4GB)
    tv.setUint32(padLen + 4, bits >>> 0) // low 32 bits
    this.absorbInto(tail)
    this.done = true
    const out = new Uint8Array(32)
    const dv = new DataView(out.buffer)
    for (let i = 0; i < 8; i++) dv.setUint32(i * 4, this.h[i] >>> 0)
    return out
  }

  // The block-feeding loop, shared by update() and the finalizer (digest, which must run after `done`).
  private absorbInto(data: Uint8Array): void {
    let i = 0
    if (this.bufLen > 0) {
      while (i < data.length && this.bufLen < 64) this.buf[this.bufLen++] = data[i++]
      if (this.bufLen === 64) {
        this.block(this.buf, 0)
        this.bufLen = 0
      }
    }
    for (; i + 64 <= data.length; i += 64) this.block(data, i)
    while (i < data.length) this.buf[this.bufLen++] = data[i++]
  }

  hex(): string {
    const d = this.digest()
    let s = ''
    for (let i = 0; i < d.length; i++) s += d[i].toString(16).padStart(2, '0')
    return s
  }
}

/** One-shot SHA-256 hex of a buffer (for the in-RAM path / tests). */
export function sha256Hex(bytes: Uint8Array): string {
  return new Sha256().update(bytes).hex()
}

/** Stream a Blob/File through the incremental hash → lowercase hex, WITHOUT ever holding the whole payload in
 *  RAM (Web Crypto's one-shot digest can't, and a GB-scale disk file mustn't). This re-hashes the bytes that
 *  were ACTUALLY written to storage, so a sink that silently transformed them (e.g. an iOS OPFS write() that
 *  ignored a typed-array view's byteOffset and persisted extra bytes) is caught — the in-flight chunk hash
 *  can't see that, since it hashes the in-memory views, not what landed on disk. */
export async function sha256HexOfBlob(blob: Blob): Promise<string> {
  const h = new Sha256()
  const reader = blob.stream().getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) h.update(value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBufferLike))
  }
  return h.hex()
}
