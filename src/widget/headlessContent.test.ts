import { describe, it, expect } from 'vitest'
import { payloadToFile } from './headlessContent'
import { bytesToBase64 } from '../core/contentXfer'

describe('payloadToFile', () => {
  it('builds a typed File (name preserved) from a base64 payload', () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    const f = payloadToFile({ mime: 'image/png', data: bytesToBase64(bytes), name: 'art.png' }, 'image.png')
    expect(f).toBeTruthy()
    expect(f!.type).toBe('image/png')
    expect(f!.size).toBe(4)
    expect((f as File).name).toBe('art.png')
  })

  it('defaults the mime and the name when omitted', () => {
    const f = payloadToFile({ data: bytesToBase64(new Uint8Array([9])) }, 'file')
    expect(f!.type).toBe('application/octet-stream')
    expect((f as File).name).toBe('file')
  })

  it('returns null on a missing / empty / non-string payload', () => {
    expect(payloadToFile(null, 'x')).toBeNull()
    expect(payloadToFile({ mime: 'image/png' }, 'x')).toBeNull() // no data
    expect(payloadToFile({ data: '' }, 'x')).toBeNull()
    expect(payloadToFile({ data: 123 }, 'x')).toBeNull()
  })

  it('accepts a ready Blob directly (no base64) and names it', () => {
    const blob = new Blob([new Uint8Array([5, 6, 7])], { type: 'application/pdf' })
    const f = payloadToFile({ blob, name: 'doc.pdf' }, 'file')
    expect(f).toBeTruthy()
    expect(f!.size).toBe(3)
    expect(f!.type).toBe('application/pdf')
    expect((f as File).name).toBe('doc.pdf')
  })

  it('prefers blob over data when both are present, and inherits the payload mime if the blob has none', () => {
    const blob = new Blob([new Uint8Array([1, 2])]) // no type
    const f = payloadToFile({ blob, data: bytesToBase64(new Uint8Array([9, 9, 9, 9])), mime: 'image/png', name: 'p.png' }, 'file')
    expect(f!.size).toBe(2) // the 2-byte blob, NOT the 4-byte base64
    expect(f!.type).toBe('image/png') // fell back to the payload mime
  })
})
