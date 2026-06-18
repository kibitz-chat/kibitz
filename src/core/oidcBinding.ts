// Bind an OIDC ID token to a WebRTC DTLS certificate — the heart of the serverless
// (L3) identity check. At sign-in the user sets the token's `nonce` to a hash of
// their cert fingerprint; every peer then recomputes that hash from the cert it
// ACTUALLY handshook with (RTCDtlsTransport.getRemoteCertificates(), via
// safetyCode.ts) and checks it matches. So a token is only valid for the peer holding
// that cert's private key — it can't be replayed by anyone else (their connection
// presents a different cert). This composes with the emoji safety code: same cert,
// so "verified identity" and "no man-in-the-middle" become one guarantee.

import { bytesToB64url } from './oidcVerify'

const enc = new TextEncoder()

/** Canonical form of a DTLS cert fingerprint — lowercase colon-hex, matching what
 *  safetyCode.ts produces (fingerprintOfDer) and what RTCCertificate.getFingerprints()
 *  yields after normalisation. Both sides MUST canonicalise identically or the hash
 *  won't match. */
export function canonicalFingerprint(fp: string): string {
  return fp.trim().toLowerCase()
}

/** The nonce to present at sign-in for a given cert fingerprint: a base64url SHA-256
 *  of the canonical fingerprint (optionally salted with a room id so a token captured
 *  in one room can't be replayed into another). */
export async function nonceForFingerprint(fp: string, salt?: string): Promise<string> {
  const input = canonicalFingerprint(fp) + (salt ? `|${salt}` : '')
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(input)))
  return bytesToB64url(digest)
}

/** Constant-time-ish string compare (the nonce isn't secret, but no early-exit keeps
 *  it tidy). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** Does `tokenNonce` (from a verified ID token) bind to a peer presenting cert
 *  fingerprint `remoteFp`? True only if the token was minted for exactly this cert. */
export async function bindingMatches(tokenNonce: string | undefined, remoteFp: string, salt?: string): Promise<boolean> {
  if (!tokenNonce || !remoteFp) return false
  return timingSafeEqual(tokenNonce, await nonceForFingerprint(remoteFp, salt))
}
