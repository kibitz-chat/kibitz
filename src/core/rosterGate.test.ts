import { describe, it, expect } from 'vitest'
import { evaluateRosterGate, memberOf, peerCleared } from './rosterGate'

describe('memberOf — normalized membership', () => {
  const roster = ['Alice@Acme.com', '  Bob ']
  it('matches case- and whitespace-insensitively', () => {
    expect(memberOf(roster, 'alice@acme.com')).toBe(true)
    expect(memberOf(roster, 'BOB')).toBe(true)
    expect(memberOf(roster, ' bob ')).toBe(true)
  })
  it('rejects non-members and empty identities', () => {
    expect(memberOf(roster, 'mallory@evil.com')).toBe(false)
    expect(memberOf(roster, '')).toBe(false)
    expect(memberOf(roster, null)).toBe(false)
    expect(memberOf(roster, undefined)).toBe(false)
  })
})

describe('evaluateRosterGate — inert when no roster', () => {
  it('no members ⇒ inactive, always shareable (feature off)', () => {
    const v = evaluateRosterGate({ members: null, self: null, peers: [{ id: 'p1', identity: null }] })
    expect(v).toEqual({ active: false, selfVerified: true, peers: [], canShare: true, compromised: false, pending: false })
  })
  it('empty members array is also inactive', () => {
    expect(evaluateRosterGate({ members: [], self: 'x' }).active).toBe(false)
  })
})

describe('evaluateRosterGate — self-gate (honest-host bootstrap)', () => {
  const members = ['alice@acme.com', 'bob@acme.com']
  it('alone + self-verified ⇒ canShare (no relying party yet)', () => {
    const v = evaluateRosterGate({ members, self: 'alice@acme.com', peers: [] })
    expect(v.selfVerified).toBe(true)
    expect(v.canShare).toBe(true)
    expect(v.pending).toBe(false)
  })
  it('alone + NOT self-verified ⇒ cannot share (must prove a listed identity first)', () => {
    const v = evaluateRosterGate({ members, self: null, peers: [] })
    expect(v.selfVerified).toBe(false)
    expect(v.canShare).toBe(false)
  })
})

describe('evaluateRosterGate — mutual, per-peer', () => {
  const members = ['alice@acme.com', 'bob@acme.com', 'carol@acme.com']

  it('every present peer verified + self verified ⇒ canShare', () => {
    const v = evaluateRosterGate({
      members,
      self: 'alice@acme.com',
      peers: [
        { id: 'b', identity: 'bob@acme.com' },
        { id: 'c', identity: 'carol@acme.com' },
      ],
    })
    expect(v.peers.map((p) => p.state)).toEqual(['verified', 'verified'])
    expect(v.canShare).toBe(true)
    expect(v.compromised).toBe(false)
    expect(v.pending).toBe(false)
  })

  it('a peer still proving (null identity) ⇒ pending, HOLD (no share, not compromised)', () => {
    const v = evaluateRosterGate({
      members,
      self: 'alice@acme.com',
      peers: [
        { id: 'b', identity: 'bob@acme.com' },
        { id: 'c', identity: null },
      ],
    })
    expect(v.peers.find((p) => p.id === 'c')!.state).toBe('pending')
    expect(v.pending).toBe(true)
    expect(v.compromised).toBe(false)
    expect(v.canShare).toBe(false) // wait until c proves itself
  })

  it('a peer who proved an OFF-roster identity ⇒ rejected + compromised (intruder past admission)', () => {
    const v = evaluateRosterGate({
      members,
      self: 'alice@acme.com',
      peers: [
        { id: 'b', identity: 'bob@acme.com' },
        { id: 'm', identity: 'mallory@evil.com' }, // validly signed, but NOT on the roster
      ],
    })
    const m = v.peers.find((p) => p.id === 'm')!
    expect(m.state).toBe('rejected')
    expect(m.identity).toBe('mallory@evil.com')
    expect(v.compromised).toBe(true)
    expect(v.canShare).toBe(false)
  })

  it('I am not yet self-verified ⇒ cannot share even if all peers are verified', () => {
    const v = evaluateRosterGate({
      members,
      self: null,
      peers: [{ id: 'b', identity: 'bob@acme.com' }],
    })
    expect(v.selfVerified).toBe(false)
    expect(v.canShare).toBe(false)
  })

  it('verified peers carry their identity through for display', () => {
    const v = evaluateRosterGate({ members, self: 'alice@acme.com', peers: [{ id: 'b', identity: 'Bob@Acme.com' }] })
    expect(v.peers[0]).toEqual({ id: 'b', state: 'verified', identity: 'Bob@Acme.com' })
  })
})

describe('evaluateRosterGate — domain (OIDC) members', () => {
  it('memberOf admits by exact email OR allowed domain', () => {
    expect(memberOf(['alice@x.com'], 'alice@x.com', ['acme.com'])).toBe(true) // exact
    expect(memberOf(['alice@x.com'], 'bob@acme.com', ['acme.com'])).toBe(true) // domain
    expect(memberOf(['alice@x.com'], 'bob@acme.com', ['@Acme.com'])).toBe(true) // normalized, '@'
    expect(memberOf(['alice@x.com'], 'bob@evil.com', ['acme.com'])).toBe(false)
    expect(memberOf([], 'bob@acme.com', [])).toBe(false)
  })

  it('a domains-only roster is active and admits any verified address at the domain', () => {
    const v = evaluateRosterGate({
      members: [],
      domains: ['acme.com'],
      self: 'me@acme.com',
      peers: [
        { id: 'b', identity: 'bob@acme.com' },
        { id: 'm', identity: 'mallory@evil.com' },
      ],
    })
    expect(v.active).toBe(true)
    expect(v.selfVerified).toBe(true)
    expect(v.peers.find((p) => p.id === 'b')!.state).toBe('verified')
    expect(v.peers.find((p) => p.id === 'm')!.state).toBe('rejected')
    expect(v.compromised).toBe(true)
  })
})

describe('peerCleared — receive-side filter', () => {
  const members = ['alice@acme.com', 'bob@acme.com']
  it('inactive gate clears everyone (feature off)', () => {
    const v = evaluateRosterGate({ members: null })
    expect(peerCleared(v, 'anyone')).toBe(true)
  })
  it('only a verified present peer is cleared; pending/rejected/unknown are not', () => {
    const v = evaluateRosterGate({
      members,
      self: 'alice@acme.com',
      peers: [
        { id: 'b', identity: 'bob@acme.com' },
        { id: 'p', identity: null },
        { id: 'm', identity: 'mallory@evil.com' },
      ],
    })
    expect(peerCleared(v, 'b')).toBe(true)
    expect(peerCleared(v, 'p')).toBe(false)
    expect(peerCleared(v, 'm')).toBe(false)
    expect(peerCleared(v, 'ghost')).toBe(false) // not in the present set at all
  })
})
