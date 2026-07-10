import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { memCommit, roomKeyFromHash, isAgentParticipant, isControlSecret, stripControlSecrets, stripControlSecretsFromUrl, summonKeyFromLink, summonKeyForRoom } from './memKey'

// The commitment MUST match the agent's envelope.commit() byte-for-byte, or the agent rejects every key. Both are
// base64url(SHA-256(mk-string)); cross-check against an independent Node implementation.
const expected = (s: string) => createHash('sha256').update(s, 'utf8').digest('base64url')

describe('memKey', () => {
  it('memCommit = base64url(SHA-256(mk)) — matches the agent commitment algorithm', async () => {
    for (const mk of ['hello', 'a'.repeat(43), 'AAAA-_zz09', '']) {
      expect(await memCommit(mk)).toBe(expected(mk))
    }
  })

  it('roomKeyFromHash reads mk from the room-link fragment, else empty', () => {
    expect(roomKeyFromHash('#standup?mk=abc123')).toBe('abc123')
    expect(roomKeyFromHash('#standup?g=google&mk=xyz')).toBe('xyz')
    expect(roomKeyFromHash('#standup')).toBe('')
  })

  it('isAgentParticipant detects an AI agent, never self', () => {
    expect(isAgentParticipant({ meta: { kind: 'voice-assistant' } })).toBe(true)
    expect(isAgentParticipant({ meta: { role: 'agent' } })).toBe(true)
    expect(isAgentParticipant({ isSelf: true, meta: { role: 'agent' } })).toBe(false)
    expect(isAgentParticipant({ meta: {} })).toBe(false)
  })

  it('isControlSecret flags sk/mk/st only', () => {
    expect(['sk', 'mk', 'st'].every(isControlSecret)).toBe(true)
    expect(['ag', 'n', 'g', 'gk', 'gm', 'room'].some(isControlSecret)).toBe(false)
  })

  it('stripControlSecrets drops control secrets, keeps consent + gate params (the join-only invite)', () => {
    const p = new URLSearchParams('ag=a&n=hi&g=google&sk=sk_xyz&mk=key123&st=tok')
    const out = stripControlSecrets(p)
    expect(out.get('ag')).toBe('a')
    expect(out.get('n')).toBe('hi')
    expect(out.get('g')).toBe('google')
    expect(out.get('sk')).toBe(null)
    expect(out.get('mk')).toBe(null)
    expect(out.get('st')).toBe(null)
    // original is not mutated (immutability)
    expect(p.get('sk')).toBe('sk_xyz')
  })

  it('stripControlSecretsFromUrl removes sk (query) AND mk (fragment), keeps the rest', () => {
    const out = stripControlSecretsFromUrl('https://kibitz.chat/j/standup?ag=a&sk=sk_xyz#standup?g=google&mk=key123')
    expect(out).not.toContain('sk_xyz')
    expect(out).not.toContain('key123')
    expect(out).toContain('ag=a')
    expect(out).toContain('g=google')
    // a link with no secrets is returned intact-ish (still parseable, still points at the room)
    expect(stripControlSecretsFromUrl('https://kibitz.chat/#standup')).toContain('standup')
  })

  it('summonKeyFromLink reads sk from the fragment first, then the legacy query, else empty', () => {
    expect(summonKeyFromLink('#standup?sk=sk_frag', '?sk=sk_query')).toBe('sk_frag') // control-link fragment wins
    expect(summonKeyFromLink('#standup', '?sk=sk_query')).toBe('sk_query') // legacy query fallback
    expect(summonKeyFromLink('#standup', '')).toBe('')
  })

  it('summonKeyForRoom persists the URL sk per-room and restores it when the URL later lacks it (leave→re-enter)', () => {
    // node has no localStorage — install a minimal in-memory one for this test
    const store = new Map<string, string>()
    ;(globalThis as { localStorage?: Storage }).localStorage = {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: () => null,
      length: 0,
    } as Storage
    // 1) first visit via the control link → returns the sk AND stashes it for the room
    expect(summonKeyForRoom('standup', '#standup?sk=sk_frag', '')).toBe('sk_frag')
    // 2) re-enter the SAME room with NO sk in the URL (goHome cleared the fragment) → restored from the stash
    expect(summonKeyForRoom('standup', '#standup', '')).toBe('sk_frag')
    // 3) a DIFFERENT room with no sk → nothing stashed → empty (no cross-room leak)
    expect(summonKeyForRoom('other', '#other', '')).toBe('')
    delete (globalThis as { localStorage?: Storage }).localStorage
  })
})
