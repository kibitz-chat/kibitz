import { describe, expect, it } from 'vitest'
import { asContent } from '../react/useCall'
import { normalizeRoom, peerIdFor } from './transport'
import { decodeGateParams, gateParamsFrom, splitRoomHash } from './joinGateLink'
import { canonicalFingerprint, nonceForFingerprint } from './oidcBinding'

/**
 * ────────────────────────────────────────────────────────────────────────────────────────────
 *  CROSS-VERSION CONFORMANCE — golden ABI fixtures. See COMPATIBILITY.md.
 * ────────────────────────────────────────────────────────────────────────────────────────────
 *
 *  Everything pinned here is a CONTRACT that crosses a version boundary in a SERVERLESS P2P
 *  system — there is no server to translate, so an old build and a new build must agree on
 *  these by themselves, and bookmarked links / outstanding tokens must keep resolving.
 *
 *  If a test here fails, DO NOT just update the fixture. Ask which happened:
 *    • You made an ADDITIVE change (new message kind, new optional field, new gate mode)?
 *      → fine; add a NEW fixture, leave the old ones untouched.
 *    • You changed the MEANING/shape/encoding of something already shipped?
 *      → that is a BREAKING change: it splits rooms / invalidates live links across builds.
 *      It needs a deliberate version bump (e.g. the `kbz-v1-` → `kbz-v2-` room prefix) and a
 *      COMPATIBILITY.md entry — not a fixture edit.
 */

describe('conformance: wire ContentMsg (additive-only, ignore-unknown)', () => {
  // Every kind shipped in v0.1 must keep narrowing. Add new kinds BELOW; never remove these.
  it('accepts every shipped ContentMsg kind', () => {
    expect(asContent({ k: 'chat', text: 'hi' })?.k).toBe('chat')
    expect(asContent({ k: 'chat', text: 'psst', dm: true })).toEqual({ k: 'chat', text: 'psst', dm: true })
    expect(asContent({ k: 'app', data: { any: 'shape' } })?.k).toBe('app')
    expect(asContent({ k: 'pay', url: 'https://x', label: 'lunch', dm: true })?.k).toBe('pay')
    expect(asContent({ k: 'ink', e: { k: 'clear' } })?.k).toBe('ink')
    expect(asContent({ k: 'idtoken', jwt: 'a.b.c' })?.k).toBe('idtoken')
    expect(asContent({ k: 'caps', grants: { v1: { perceive: [], act: [] } } })?.k).toBe('caps')
    // Added in the 0.1 negotiation wave (additive — old peers ignore it; see ignore-unknown below).
    expect(asContent({ k: 'schema', name: 'app.view', version: '1.0.0', schema: { type: 'object' } })?.k).toBe('schema')
  })
  it('IGNORES an unknown future kind (forward-compat: an old peer drops what it does not know)', () => {
    // This is the property that lets a new build add a message an old build safely ignores.
    expect(asContent({ k: 'reaction', emoji: '👍' })).toBeNull()
    expect(asContent({ k: 'v9-supermsg' })).toBeNull()
    expect(asContent({})).toBeNull()
    expect(asContent(null)).toBeNull()
  })
})

describe('conformance: room id derivation (kbz-v1- ABI — bumping this splits every room)', () => {
  it('maps known room names to their frozen peer ids', () => {
    expect(peerIdFor('standup')).toBe('kbz-v1-standup')
    expect(peerIdFor('My Room')).toBe('kbz-v1-my-room')
    expect(peerIdFor('  Hello, World!  ')).toBe('kbz-v1-hello-world')
    expect(peerIdFor('room-3f9k2mq7p1')).toBe('kbz-v1-room-3f9k2mq7p1')
  })
  it('keeps the documented canonicalization (lowercase, non-alnum→-, 40-char cap)', () => {
    expect(normalizeRoom('A-B-C')).toBe('a-b-c')
    expect(normalizeRoom('café ☕ chat')).toBe('caf-chat')
    expect(normalizeRoom('x'.repeat(50))).toHaveLength(40)
  })
  it('the prefix is exactly kbz-v1- (a guard: changing it is the nuclear option)', () => {
    expect(peerIdFor('z').startsWith('kbz-v1-')).toBe(true)
  })
})

describe('conformance: join-gate link params (data at rest — a bookmarked link must keep working)', () => {
  it('decodes a v0.1 names-gate link', () => {
    expect(decodeGateParams(new URLSearchParams('g=names&gn=alice,bob'))).toEqual({
      mode: 'names',
      names: ['alice', 'bob'],
    })
  })
  it('decodes a v0.1 google-gate link', () => {
    expect(decodeGateParams(new URLSearchParams('g=google&gc=client-123.apps.googleusercontent.com'))).toEqual({
      mode: 'google',
      clientId: 'client-123.apps.googleusercontent.com',
    })
  })
  it('no gate param → open; an UNKNOWN future mode falls back to open (forward-compat)', () => {
    expect(decodeGateParams(new URLSearchParams(''))).toEqual({ mode: 'open' })
    expect(decodeGateParams(new URLSearchParams('g=quantum-2030'))).toEqual({ mode: 'open' })
  })

  it('gate-in-fragment placement is stable, and the legacy query form still resolves', () => {
    // A new (host-private) link puts the gate in the fragment after the room; an OLD bookmarked
    // link put it in the query. Both must keep resolving to the same descriptor.
    expect(splitRoomHash('#standup?g=names&gn=alice,bob').room).toBe('standup')
    expect(decodeGateParams(gateParamsFrom('#standup?g=names&gn=alice,bob', ''))).toEqual({
      mode: 'names',
      names: ['alice', 'bob'],
    })
    expect(decodeGateParams(gateParamsFrom('#standup', '?g=names&gn=alice,bob'))).toEqual({
      mode: 'names',
      names: ['alice', 'bob'],
    })
  })
})

describe('conformance: cert-binding nonce (identity ABI — changing it invalidates live tokens)', () => {
  const FP = 'AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89'
  it('canonicalFingerprint is the frozen normalization (trim + lowercase; separators kept)', () => {
    expect(canonicalFingerprint(FP)).toBe(FP.toLowerCase())
    expect(canonicalFingerprint('  AB cd:EF  ')).toBe('ab cd:ef')
  })
  it('nonceForFingerprint is deterministic + salt-sensitive (golden vector)', async () => {
    const a = await nonceForFingerprint(FP, 'room-salt')
    const b = await nonceForFingerprint(FP, 'room-salt')
    expect(a).toBe(b) // deterministic — both peers must compute the same nonce
    expect(await nonceForFingerprint(FP, 'other-salt')).not.toBe(a) // room-bound
    // Frozen vector: if this changes, every outstanding cert-bound token stops verifying.
    expect(a).toBe('jr1LLr5BsB5Y2nbZiWzrzU2SCJjNQu4GuhlOyN361zo')
  })
})
