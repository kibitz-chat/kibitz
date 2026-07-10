import { describe, expect, it } from 'vitest'
import { Sha256, sha256Hex, sha256HexOfBlob } from './sha256'

const enc = (s: string) => new TextEncoder().encode(s)

describe('SHA-256 (FIPS 180-4) — NIST vectors', () => {
  it('hashes the canonical vectors', () => {
    expect(sha256Hex(enc(''))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256Hex(enc('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(sha256Hex(enc('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1')
  })
  it('matches the one-million-"a" vector (exercises many blocks + padding)', () => {
    const h = new Sha256()
    const chunk = enc('a'.repeat(1000))
    for (let i = 0; i < 1000; i++) h.update(chunk)
    expect(h.hex()).toBe('cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0')
  })
  it('is incremental: any chunk boundaries give the same digest as one shot', () => {
    const data = enc('the quick brown fox 🦊 jumps over 13 lazy dogs '.repeat(37))
    const one = sha256Hex(data)
    for (const step of [1, 7, 31, 64, 65, 100, 1000]) {
      const h = new Sha256()
      for (let i = 0; i < data.length; i += step) h.update(data.subarray(i, i + step))
      expect(h.hex()).toBe(one)
    }
  })
  it('matches Web Crypto on random-ish bytes (cross-check the implementation)', async () => {
    const data = new Uint8Array(5000)
    for (let i = 0; i < data.length; i++) data[i] = (i * 1103515245 + 12345) & 0xff // deterministic PRNG
    const ours = sha256Hex(data)
    const native = new Uint8Array(await crypto.subtle.digest('SHA-256', data))
    const nativeHex = [...native].map((b) => b.toString(16).padStart(2, '0')).join('')
    expect(ours).toBe(nativeHex)
  })
  it('a single flipped bit changes the digest', () => {
    const a = enc('payload')
    const b = enc('payloae') // last byte differs by one bit (d=0x64 → e=0x65)
    expect(sha256Hex(a)).not.toBe(sha256Hex(b))
  })
  it('refuses reuse after digest', () => {
    const h = new Sha256()
    h.hex()
    expect(() => h.update(enc('x'))).toThrow()
    expect(() => h.digest()).toThrow()
  })
})

describe('sha256HexOfBlob — verify the bytes actually on disk', () => {
  it('streams a Blob to the same digest as the one-shot over its bytes (multi-part, crosses block bounds)', async () => {
    const parts = [enc('a'.repeat(100)), enc('b'.repeat(2000)), enc('c'.repeat(37))]
    const whole = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
    let o = 0
    for (const p of parts) { whole.set(p, o); o += p.length }
    expect(await sha256HexOfBlob(new Blob(parts as BlobPart[]))).toBe(sha256Hex(whole))
  })
  it('hashes an empty Blob to the empty-input vector', async () => {
    expect(await sha256HexOfBlob(new Blob([]))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })
  it('catches a disk file that gained a leaked frame header (the iOS corruption signature)', async () => {
    const payload = enc('the real file bytes'.repeat(50))
    const good = await sha256HexOfBlob(new Blob([payload as BlobPart])) // sender's hash = over the payload
    // What the buggy iOS sink actually persisted: a 41-byte header glued before the payload.
    const corrupt = new Blob([enc('$'.padEnd(41, '\0')) as BlobPart, payload as BlobPart])
    expect(await sha256HexOfBlob(corrupt)).not.toBe(good) // mismatch → receiver fails the transfer
  })
})
