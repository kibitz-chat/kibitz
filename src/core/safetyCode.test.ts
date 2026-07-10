import { describe, it, expect } from 'vitest'
import { safetyCode, computeSafetyCode, pcFingerprints, SAFETY_ALPHABET } from './safetyCode'

const FP_A = 'AA:BB:CC:11:22:33'
const FP_B = 'DD:EE:FF:44:55:66'
const set = new Set<string>(SAFETY_ALPHABET)

describe('safetyCode (pure SAS)', () => {
  it('is deterministic', async () => {
    expect(await safetyCode(FP_A, FP_B)).toBe(await safetyCode(FP_A, FP_B))
  })

  it('is order-independent (both peers compute the same code)', async () => {
    expect(await safetyCode(FP_A, FP_B)).toBe(await safetyCode(FP_B, FP_A))
  })

  it('normalizes case/whitespace', async () => {
    expect(await safetyCode('  aa:bb:cc:11:22:33 ', FP_B)).toBe(await safetyCode(FP_A, FP_B))
  })

  it('differs for a different peer (MITM cert → different code)', async () => {
    const honest = await safetyCode(FP_A, FP_B)
    const mitm = await safetyCode(FP_A, '99:88:77:00:11:22') // A handshook with the MITM, not B
    expect(mitm).not.toBe(honest)
  })

  it('renders N space-separated symbols, all from the alphabet', async () => {
    const code = await safetyCode(FP_A, FP_B, 4)
    const parts = code.split(' ')
    expect(parts).toHaveLength(4)
    for (const p of parts) expect(set.has(p)).toBe(true)
  })

  it('honors the symbol count', async () => {
    expect((await safetyCode(FP_A, FP_B, 6)).split(' ')).toHaveLength(6)
  })
})

// Minimal RTCPeerConnection stand-in: the negotiated remote cert (DER) + our SDP.
const der = (s: string) => enc(s).buffer
const enc = (s: string) => new TextEncoder().encode(s)
const mockPc = (remoteDer: ArrayBuffer | null, localSdpFp: string | null) =>
  ({
    sctp: { transport: { getRemoteCertificates: () => (remoteDer ? [remoteDer] : []) } },
    getSenders: () => [],
    getReceivers: () => [],
    localDescription: localSdpFp ? { sdp: `v=0\r\na=fingerprint:sha-256 ${localSdpFp}\r\n` } : { sdp: '' },
  })

describe('pcFingerprints / computeSafetyCode', () => {
  it('extracts both fingerprints and produces a code', async () => {
    const pc = mockPc(der('remote-cert-der'), 'AB:CD:EF:01:23:45')
    const fps = await pcFingerprints(pc)
    expect(fps?.local).toBe('ab:cd:ef:01:23:45') // lowercased from SDP
    expect(fps?.remote).toMatch(/^[0-9a-f:]+$/) // hash of the DER
    expect(await computeSafetyCode(pc)).toMatch(/\S( \S)+/)
  })

  it('returns null when the browser exposes no remote cert (no faked code)', async () => {
    expect(await pcFingerprints(mockPc(null, 'AB:CD:EF'))).toBeNull()
    expect(await computeSafetyCode(mockPc(null, 'AB:CD:EF'))).toBeNull()
  })

  it('returns null when there is no local fingerprint', async () => {
    expect(await pcFingerprints(mockPc(der('x'), null))).toBeNull()
  })

  it('returns null when the peer presents more than one remote cert (ambiguous leaf → fail closed)', async () => {
    // A multi-entry cert list is peer-controlled + peer-ordered; [0] may not be the key-holding leaf. Refuse
    // rather than bind identity (cert-binding + SAS) to a possibly-non-leaf cert.
    const multiCertPc = {
      sctp: { transport: { getRemoteCertificates: () => [der('leaf-or-not'), der('second-cert')] } },
      getSenders: () => [],
      getReceivers: () => [],
      localDescription: { sdp: 'v=0\r\na=fingerprint:sha-256 AB:CD:EF\r\n' },
    }
    expect(await pcFingerprints(multiCertPc)).toBeNull()
    expect(await computeSafetyCode(multiCertPc)).toBeNull()
  })
})
