// A PINNED WebRTC certificate for the serverless-identity (L3) binding. We generate
// ONE cert up front and reuse it for every connection in the mesh (passed via the
// peer's RTCConfiguration.certificates), so a single signed ID token — whose nonce is
// a hash of this cert's fingerprint — verifies for every peer. The private key never
// leaves the browser, which is exactly what makes the binding non-transferable.

import { canonicalFingerprint } from './oidcBinding'

/** The shape we need off an RTCCertificate (kept narrow so it's testable with a fake). */
export interface CertLike {
  getFingerprints(): Array<{ algorithm?: string; value?: string }>
}

/** The canonical (lowercase colon-hex) SHA-256 fingerprint of a cert, or null if the
 *  browser doesn't expose a sha-256 fingerprint. Matches safetyCode.ts's format so it
 *  lines up with the REMOTE fingerprint peers read off the live connection. */
export function certFingerprint(cert: CertLike): string | null {
  const fp = cert.getFingerprints().find((f) => (f.algorithm ?? '').toLowerCase() === 'sha-256')
  return fp?.value ? canonicalFingerprint(fp.value) : null
}

/** Generate a fresh ECDSA P-256 cert to pin for the call. Returns null when WebRTC
 *  certificates aren't available (non-browser / unsupported) — the caller then skips
 *  identity verification rather than faking it. */
export async function generatePinnedCert(): Promise<RTCCertificate | null> {
  const RPC = typeof RTCPeerConnection !== 'undefined' ? RTCPeerConnection : undefined
  if (!RPC?.generateCertificate) return null
  try {
    return await RPC.generateCertificate({ name: 'ECDSA', namedCurve: 'P-256' } as EcKeyGenParams)
  } catch {
    return null
  }
}
