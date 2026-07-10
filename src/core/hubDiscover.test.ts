import { describe, it, expect } from 'vitest'
import { configFor, candidateIps } from './hubDiscover'

// Zero-input discovery: the web bakes in the relay's fixed identity and probes the LAN for it. These cover the
// pure parts (the WebRTC connect/probe itself is proven on-device). The fixed constants MUST match
// relaycore/fixedid.go — configFor is what's handed to connectGalaxy per candidate IP.
describe('hub discovery', () => {
  it('configFor builds the fixed identity + fixed TURN for an IP', () => {
    const cfg = configFor('192.168.43.1')
    expect(cfg.ufrag).toBe('wbxlanhub01')
    expect(cfg.pwd).toBe('774B1GNZgs48OidH45A7DZx')
    expect(cfg.endpoints).toEqual([{ addr: '192.168.43.1', port: 4711 }])
    expect(cfg.turn).toEqual({ port: 3478, user: 'wblan', pass: 'Sp64SHsXMZOdzT6rgYcF' })
    expect(cfg.fp.length).toBe(32) // sha-256 of the fixed cert
  })

  it('candidateIps leads with common hotspot/router gateways', async () => {
    // No RTCPeerConnection in node → localSubnet() returns null → only the gateways (the host-is-gateway case,
    // which is the hotspot). The Android hotspot gateway is first.
    const ips = await candidateIps()
    expect(ips[0]).toBe('192.168.43.1')
    expect(ips).toContain('172.20.10.1') // iOS hotspot gateway
    expect(ips).toContain('10.0.0.1')
  })
})
