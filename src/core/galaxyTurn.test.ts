import { describe, it, expect } from 'vitest'
import { parseGalaxyBlob, turnServersFor } from './galaxySignal'

// A g2 relay advertises a LAN TURN so offline MEDIA relays THROUGH the hub (iOS/mDNS breaks peer-to-peer media
// on a phone LAN). The blob inserts `port,user,pass` as field 4; endpoints follow. g1 stays TURN-less.
const FP = 'A'.repeat(43) // b64url of 32 zero bytes (a 32-byte sha-256 fingerprint)

describe('galaxy g2 TURN', () => {
  it('parses a g2 blob: TURN spec + endpoints (eps shifted to field 5+)', () => {
    const cfg = parseGalaxyBlob(`g2|uf|pw|${FP}|55123,tuser,tpass|192.168.1.5~4711|abc.local~4711`)
    expect(cfg).not.toBeNull()
    expect(cfg!.turn).toEqual({ port: 55123, user: 'tuser', pass: 'tpass' })
    expect(cfg!.endpoints).toEqual([
      { addr: '192.168.1.5', port: 4711 },
      { addr: 'abc.local', port: 4711 },
    ])
  })

  it('g1 stays TURN-less (back-compat) and yields no TURN servers', () => {
    const cfg = parseGalaxyBlob(`g1|uf|pw|${FP}|192.168.1.5~4711`)
    expect(cfg).not.toBeNull()
    expect(cfg!.turn).toBeUndefined()
    expect(turnServersFor(cfg)).toEqual([])
  })

  it('turnServersFor builds turn: URLs for raw-IP endpoints only (skips .local mDNS)', () => {
    const cfg = parseGalaxyBlob(`g2|uf|pw|${FP}|55123,tuser,tpass|192.168.1.5~4711|abc.local~4711|10.0.0.2~4711`)
    expect(turnServersFor(cfg)).toEqual([
      { urls: 'turn:192.168.1.5:55123?transport=udp', username: 'tuser', credential: 'tpass' },
      { urls: 'turn:10.0.0.2:55123?transport=udp', username: 'tuser', credential: 'tpass' },
    ])
  })

  it('a malformed TURN spec degrades to no TURN (still a valid g2 relay)', () => {
    const cfg = parseGalaxyBlob(`g2|uf|pw|${FP}|notaport|192.168.1.5~4711`)
    expect(cfg).not.toBeNull()
    expect(cfg!.turn).toBeUndefined()
    expect(cfg!.endpoints).toEqual([{ addr: '192.168.1.5', port: 4711 }])
  })
})
