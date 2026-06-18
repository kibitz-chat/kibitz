import { describe, it, expect } from 'vitest'
import {
  decodeGateParams,
  encodeGateParams,
  gateParamsFrom,
  splitRoomHash,
  withGateFragment,
  type GateDescriptor,
} from './joinGateLink'

const roundTrip = (d: GateDescriptor): GateDescriptor => decodeGateParams(new URLSearchParams(encodeGateParams(d).toString()))

describe('joinGateLink — stateless gate descriptor in the URL', () => {
  it('an open room encodes to nothing and decodes back to open', () => {
    expect(encodeGateParams({ mode: 'open' }).toString()).toBe('')
    expect(decodeGateParams(new URLSearchParams(''))).toEqual({ mode: 'open' })
  })

  it('round-trips a name list', () => {
    expect(roundTrip({ mode: 'names', names: ['Alice', 'Bob'] })).toEqual({ mode: 'names', names: ['Alice', 'Bob'] })
  })

  it('round-trips an invite public key (JWK)', () => {
    const pubKey = { kty: 'EC', crv: 'P-256', x: 'AAA', y: 'BBB', ext: true } as JsonWebKey
    const out = roundTrip({ mode: 'invite', pubKey })
    expect(out.mode).toBe('invite')
    expect(out.pubKey).toEqual(pubKey)
  })

  it('round-trips a google client id', () => {
    expect(roundTrip({ mode: 'google', clientId: 'XYZ.apps.googleusercontent.com' })).toEqual({
      mode: 'google',
      clientId: 'XYZ.apps.googleusercontent.com',
    })
  })

  it('round-trips a verified-roster manifest token (invite mode + signed manifest)', () => {
    const pubKey = { kty: 'EC', crv: 'P-256', x: 'AAA', y: 'BBB' } as JsonWebKey
    const out = roundTrip({ mode: 'invite', pubKey, manifest: 'eyJtZW0iOjF9.sig' })
    expect(out.mode).toBe('invite')
    expect(out.manifest).toBe('eyJtZW0iOjF9.sig')
    expect(out.pubKey).toEqual(pubKey)
  })

  it('round-trips a sealed (encrypted) manifest as `ge`, distinct from cleartext `gm`', () => {
    const params = encodeGateParams({ mode: 'google', clientId: 'abc', encManifest: 'c2VhbGVk' })
    expect(params.get('ge')).toBe('c2VhbGVk')
    expect(params.get('gm')).toBeNull() // sealed rooms carry NO cleartext manifest
    const out = decodeGateParams(params)
    expect(out.encManifest).toBe('c2VhbGVk')
    expect(out.manifest).toBeUndefined()
  })

  it('a crafted link with BOTH ge and gm honours the SEALED one (gm ignored — no smuggled roster)', () => {
    const d = decodeGateParams(new URLSearchParams('g=google&ge=c2VhbGVk&gm=attacker-cleartext'))
    expect(d.encManifest).toBe('c2VhbGVk')
    expect(d.manifest).toBeUndefined() // the cleartext gm must NOT take effect alongside a sealed ge
  })

  it('a code-mode link carries ONLY the mode (codes are session-memory, never in the link)', () => {
    const params = encodeGateParams({ mode: 'code' })
    expect(params.get('g')).toBe('code')
    expect([...params.keys()]).toEqual(['g']) // nothing else — no secret leaks
  })

  it('an unknown mode decodes to open (forward/garbage tolerant)', () => {
    expect(decodeGateParams(new URLSearchParams('g=wat'))).toEqual({ mode: 'open' })
  })

  it('a corrupt invite key is dropped, not thrown (gate then fails closed)', () => {
    const d = decodeGateParams(new URLSearchParams('g=invite&gk=%%%not-base64%%%'))
    expect(d.mode).toBe('invite')
    expect(d.pubKey).toBeUndefined()
  })

  it('round-trips a host public key + sealed private key (gh/ghk) on an OPEN room', () => {
    const hostPubKey = { kty: 'EC', crv: 'P-256', x: 'HHH', y: 'III', ext: true } as JsonWebKey
    const params = encodeGateParams({ mode: 'open', hostPubKey, hostKeySealed: 'c2VhbGVkLWtleQ' })
    // mode 'open' adds no `g`, but the host fields ride alongside
    expect(params.get('g')).toBeNull()
    expect(params.get('gh')).not.toBeNull()
    expect(params.get('ghk')).toBe('c2VhbGVkLWtleQ')
    const out = decodeGateParams(params)
    expect(out.mode).toBe('open')
    expect(out.hostPubKey).toEqual(hostPubKey)
    expect(out.hostKeySealed).toBe('c2VhbGVkLWtleQ')
  })

  it('reads the host key on a VERIFIED room too (host moderation is orthogonal to the join gate)', () => {
    const pubKey = { kty: 'EC', crv: 'P-256', x: 'AAA', y: 'BBB' } as JsonWebKey
    const hostPubKey = { kty: 'EC', crv: 'P-256', x: 'HHH', y: 'III' } as JsonWebKey
    const out = roundTrip({ mode: 'invite', pubKey, manifest: 'm.sig', hostPubKey, hostKeySealed: 'sealed' })
    expect(out.mode).toBe('invite')
    expect(out.manifest).toBe('m.sig')
    expect(out.hostPubKey).toEqual(hostPubKey)
    expect(out.hostKeySealed).toBe('sealed')
  })

  it('a corrupt host key is dropped, not thrown (claiming admin then fails closed)', () => {
    const d = decodeGateParams(new URLSearchParams('gh=%%%not-base64%%%&ghk=sealed'))
    expect(d.mode).toBe('open')
    expect(d.hostPubKey).toBeUndefined()
    expect(d.hostKeySealed).toBe('sealed') // the sealed blob is opaque — kept as-is
  })

  it('an open room with NO host fields stays plain (no admin)', () => {
    const out = decodeGateParams(encodeGateParams({ mode: 'open' }))
    expect(out.hostPubKey).toBeUndefined()
    expect(out.hostKeySealed).toBeUndefined()
  })

  it('round-trips a SOFT host name + waiting-room flag (ghn/gl)', () => {
    const out = roundTrip({ mode: 'open', hostName: 'Alex', lobbyOnStart: true })
    expect(out.mode).toBe('open')
    expect(out.hostName).toBe('Alex')
    expect(out.lobbyOnStart).toBe(true)
  })

  it('omits gl when the waiting room is not requested', () => {
    const p = encodeGateParams({ mode: 'open', hostName: 'Alex' })
    expect(p.get('ghn')).toBe('Alex')
    expect(p.get('gl')).toBeNull()
    expect(decodeGateParams(p).lobbyOnStart).toBeUndefined()
  })

  it('round-trips an OIDC host email + client id (gho/gc) on an open room', () => {
    const out = roundTrip({ mode: 'open', hostEmail: 'alice@acme.com', clientId: 'XYZ.apps.googleusercontent.com' })
    expect(out.mode).toBe('open')
    expect(out.hostEmail).toBe('alice@acme.com')
    expect(out.clientId).toBe('XYZ.apps.googleusercontent.com')
  })

  it('reads the client id on an OPEN room too (the OIDC host needs it to verify sign-in)', () => {
    const out = decodeGateParams(new URLSearchParams('gho=alice%40acme.com&gc=abc'))
    expect(out.mode).toBe('open')
    expect(out.hostEmail).toBe('alice@acme.com')
    expect(out.clientId).toBe('abc')
  })
})

describe('gate-in-fragment — host-private placement (Layer 1)', () => {
  it('splitRoomHash separates the room from the gate params after `?`', () => {
    expect(splitRoomHash('#standup')).toEqual({ room: 'standup', params: new URLSearchParams() })
    const s = splitRoomHash('#standup?g=google&gc=abc')
    expect(s.room).toBe('standup')
    expect(s.params.get('g')).toBe('google')
    expect(s.params.get('gc')).toBe('abc')
  })

  it('withGateFragment appends gate params to the fragment (`?` first, `&` to chain)', () => {
    expect(withGateFragment('https://x/#standup', new URLSearchParams({ g: 'google' }))).toBe(
      'https://x/#standup?g=google',
    )
    // chaining a per-guest token onto a link that already has fragment params
    expect(withGateFragment('https://x/#standup?g=google', new URLSearchParams({ gt: 'tok' }))).toBe(
      'https://x/#standup?g=google&gt=tok',
    )
    expect(withGateFragment('https://x/#standup', new URLSearchParams())).toBe('https://x/#standup') // empty = no-op
  })

  it('a built fragment link round-trips through splitRoomHash + decodeGateParams', () => {
    const link = withGateFragment('https://x/#standup', encodeGateParams({ mode: 'google', clientId: 'abc' }))
    const { room, params } = splitRoomHash(new URL(link).hash)
    expect(room).toBe('standup')
    expect(decodeGateParams(params)).toEqual({ mode: 'google', clientId: 'abc' })
  })

  it('gateParamsFrom prefers the FRAGMENT (host-private) and falls back to the QUERY (legacy)', () => {
    // new form: gate in the fragment, query empty → host sees nothing
    expect(gateParamsFrom('#standup?g=google&gc=abc', '').get('g')).toBe('google')
    // legacy form: gate in the query, fragment has only the room
    expect(gateParamsFrom('#standup', '?g=names&gn=a,b').get('g')).toBe('names')
    // fragment wins when both present (a new build re-shared an old link won't double-apply)
    expect(gateParamsFrom('#standup?g=google', '?g=names').get('g')).toBe('google')
    // no gate anywhere → empty
    expect(gateParamsFrom('#standup', '').get('g')).toBeNull()
  })

  it('gateParamsFrom reads the display-only params (d, ag, n) from a plain fragment link', () => {
    // an open-room link carrying ONLY a consent notice/agent-type in the fragment (no real gate key)
    // must still be read FROM the fragment — not fall through to the (empty) query.
    const p = gateParamsFrom('#standup?ag=av&n=hello%20world', '')
    expect(p.get('ag')).toBe('av')
    expect(p.get('n')).toBe('hello world')
    expect(gateParamsFrom('#standup?d=Daily', '').get('d')).toBe('Daily')
    // the /j redirect form: room in the fragment, ag/n forwarded in the QUERY → read from the query.
    const q = gateParamsFrom('#standup', '?ag=a&n=hi')
    expect(q.get('ag')).toBe('a')
    expect(q.get('n')).toBe('hi')
  })
})
