import { describe, it, expect } from 'vitest'
import { connRemoteFingerprint, normalizeRoom } from './transport'

// A minimal RTCPeerConnection stand-in (same shape safetyCode.test.ts uses): the
// negotiated REMOTE cert (DER) drives the remote fingerprint; a local SDP fp is needed
// for pcFingerprints to return at all.
const enc = (s: string) => new TextEncoder().encode(s)
const mockPc = (remoteDer: ArrayBuffer | null, localSdpFp: string | null) =>
  ({
    sctp: { transport: { getRemoteCertificates: () => (remoteDer ? [remoteDer] : []) } },
    getSenders: () => [],
    getReceivers: () => [],
    localDescription: localSdpFp ? { sdp: `v=0\r\na=fingerprint:sha-256 ${localSdpFp}\r\n` } : { sdp: '' },
  }) as unknown as RTCPeerConnection

describe('connRemoteFingerprint — the authority gate binding source', () => {
  it('returns the remote DTLS fingerprint of a connected peer', async () => {
    const conn = { peerConnection: mockPc(enc('their-cert-der').buffer, 'AB:CD:EF:01') }
    const fp = await connRemoteFingerprint(conn)
    expect(fp).toMatch(/^[0-9a-f:]+$/) // a hash of the remote DER, lowercased
  })

  it('is null when the connection has no peerConnection yet (not negotiated)', async () => {
    expect(await connRemoteFingerprint({})).toBeNull()
    expect(await connRemoteFingerprint(undefined)).toBeNull()
  })

  it('is null when the browser exposes no remote cert (no spoofable fallback)', async () => {
    const conn = { peerConnection: mockPc(null, 'AB:CD:EF:01') }
    expect(await connRemoteFingerprint(conn)).toBeNull()
  })

  it('two different remote certs yield different fingerprints (binding is per-cert)', async () => {
    const a = await connRemoteFingerprint({ peerConnection: mockPc(enc('cert-A').buffer, 'AA:BB') })
    const b = await connRemoteFingerprint({ peerConnection: mockPc(enc('cert-B').buffer, 'AA:BB') })
    expect(a).not.toBe(b)
  })
})

describe('normalizeRoom (sanity — shared salt source)', () => {
  it('is stable and case/space-insensitive', () => {
    expect(normalizeRoom('  My Room ')).toBe(normalizeRoom('my room'))
  })
})
