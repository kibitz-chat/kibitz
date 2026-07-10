import { describe, it, expect } from 'vitest'
import { resolveChatId, mergeChat } from './useCall'

// H4a — a LIVE line's mid must be scoped to the sending connection so a peer can't pre-claim ANOTHER peer's
// mid (mergeChat dedups on mid) to silently drop the victim's future message.
describe('resolveChatId sender-scoping (H4a)', () => {
  it('keeps a live mid that IS sender-scoped', () => {
    expect(resolveChatId('alice', 'alice#7', 100, 1, 999).mid).toBe('alice#7')
  })
  it('DISCARDS a live mid that is NOT sender-scoped (a forged foreign mid) → sender-scoped fallback', () => {
    const r = resolveChatId('mallory', 'victim#7', 100, 3, 999)
    expect(r.mid).not.toBe('victim#7') // mallory can't pre-claim victim's mid
    expect(r.mid).toBe('mallory#r3')
  })
  it('ALLOWS a foreign mid on a REPLAYED line (allowForeignMid=true — legit re-broadcast of another author)', () => {
    expect(resolveChatId('rebroadcaster', 'victim#7', 100, 1, 999, true).mid).toBe('victim#7')
  })
  it('no mid supplied → sender-scoped fallback', () => {
    expect(resolveChatId('alice', undefined, 100, 5, 999).mid).toBe('alice#r5')
  })
  it('CENSORSHIP BLOCKED: a forged foreign mid no longer collides with the victim’s real line in mergeChat', () => {
    const forged = resolveChatId('mallory', 'victim#7', 50, 1, 999) // live, foreign → re-namespaced to mallory#r1
    const real = resolveChatId('victim', 'victim#7', 100, 2, 999) // victim's own → victim#7 (sender-scoped, kept)
    let list = mergeChat([], { from: 'mallory', name: 'M', text: 'noise', id: 1, self: false, mid: forged.mid, ts: forged.ts })
    list = mergeChat(list, { from: 'victim', name: 'V', text: 'real message', id: 2, self: false, mid: real.mid, ts: real.ts })
    expect(list.some((it) => it.text === 'real message')).toBe(true) // NOT swallowed as a dup
    expect(list.length).toBe(2)
  })
})
