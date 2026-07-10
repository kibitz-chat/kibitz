import { describe, expect, it } from 'vitest'
import { chatItemFromSeedLine } from './seedChat'
import type { ChatItem } from './useCall'

const B64 = 'aGVsbG8=' // valid base64 ("hello")
const CAP = 4000

describe('chatItemFromSeedLine — map a recovered history line to a held, replay-eligible ChatItem', () => {
  it('a text line becomes a self:false text item carrying mid/ts/from/name', () => {
    const it = chatItemFromSeedLine({ text: 'hello there', mid: 'rsm-3', ts: 120, from: 'aId', name: 'Alice' }, 7, CAP)
    expect(it).toMatchObject({ text: 'hello there', mid: 'rsm-3', ts: 120, from: 'aId', name: 'Alice', id: 7, self: false })
    expect(it?.image).toBeUndefined()
  })

  it('an image line becomes a self:false image item (no text) carrying the bytes + mid', () => {
    const it = chatItemFromSeedLine({ image: { mime: 'image/png', data: B64, name: 'p.png' }, mid: 'rsm-img#1', ts: 80, name: 'Painter' }, 4, CAP)
    expect(it?.image).toMatchObject({ mime: 'image/png', data: B64 })
    expect(it).toMatchObject({ text: '', mid: 'rsm-img#1', ts: 80, name: 'Painter', self: false })
  })

  it('seeds a FULL-RES image over the 256KB inline cap (delivered via xfer, not inline broadcast)', () => {
    const big = 'A'.repeat(2 * 1024 * 1024) // ~2MB base64 — a real painting; the inline sanitizeImg cap is 256KB
    const it = chatItemFromSeedLine({ image: { mime: 'image/png', data: big }, mid: 'rsm-img#big', ts: 90 }, 5, CAP)
    expect(it?.image?.data.length).toBe(big.length)
  })

  it('returns null when the line has no stable mid (cannot dedup → not seedable)', () => {
    expect(chatItemFromSeedLine({ text: 'x', mid: '   ', ts: 1 }, 1, CAP)).toBeNull()
    expect(chatItemFromSeedLine({ text: 'x', mid: undefined as unknown as string, ts: 1 }, 1, CAP)).toBeNull()
  })

  it('returns null for an empty text line and for a malformed image (sanitize rejects)', () => {
    expect(chatItemFromSeedLine({ text: '   ', mid: 'rsm-1', ts: 1 }, 1, CAP)).toBeNull()
    expect(chatItemFromSeedLine({ image: { mime: 'text/plain', data: B64 }, mid: 'rsm-1', ts: 1 }, 1, CAP)).toBeNull()
  })

  it('falls back name→from→"Guest" and defaults a missing ts to 0', () => {
    const a = chatItemFromSeedLine({ text: 'hi', mid: 'm1', from: 'bob' }, 1, CAP) as ChatItem
    expect(a).toMatchObject({ name: 'bob', ts: 0 })
    const b = chatItemFromSeedLine({ text: 'hi', mid: 'm2' }, 2, CAP) as ChatItem
    expect(b.name).toBe('Guest')
  })

  it('caps over-long text to the supplied max', () => {
    const it = chatItemFromSeedLine({ text: 'z'.repeat(50), mid: 'm', ts: 1 }, 1, 10) as ChatItem
    expect(it.text.length).toBe(10)
  })
})
