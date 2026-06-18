// Hand-rolled verification of an agent "credit credential" (RS256 JWS) over WebCrypto — the same
// zero-dependency, alg-pinned core as oidcVerify.ts, but for a NON-OIDC token: a short-lived proof
// that an AI agent has paid for ~1 minute of presence on a call. Kibitz verifies it AGNOSTICALLY
// against the issuer's PUBLISHED JWKS — no shared secret, no callback to the issuer (the
// network-access funding model).
//
// The credential is NOT audienced to any OAuth client (it's a network-presence token), which is the
// claim-shape difference that justifies a sibling of verifyIdToken rather than overloading it. It
// reuses oidcVerify's RS256 internals (decodeJwt/importRsaKey/asArray) so there is ONE crypto core.
//
// SECURITY: RS256 ONLY (the algorithm is never taken from the token → no alg-confusion); the key is
// selected by `kid` from the trusted JWKS (unknown kid fails closed); iss + exp are checked and `sub`
// is required. `now` is injectable so temporal checks are deterministic in tests.

import { decodeJwt, importRsaKey, asArray } from './oidcVerify'
import type { Jwk } from './oidcVerify'

/** The credit-credential claims we read (the issuer may add more). */
export interface CreditClaims {
  iss: string
  sub: string // the agent id the credential was minted for
  exp: number
  iat?: number
  nbf?: number
  room?: string
  k?: string // kind tag, e.g. 'wbz-credit.v1'
  [k: string]: unknown
}

export interface CreditVerifyOpts {
  /** The issuer's PUBLISHED RS256 signing keys (its JWKS `keys`). */
  jwks: Jwk[]
  /** Trusted issuer string(s). */
  issuer: string | string[]
  /** Current time (epoch SECONDS). Injected for determinism. */
  now: number
  /** Clock-skew leeway in seconds (default 60). */
  leewaySec?: number
  /** If set, the credential's `k` (kind) MUST equal this (defence in depth). */
  kind?: string
}

export type CreditResult = { ok: true; agentId: string; exp: number; room?: string } | { ok: false; reason: string }

/**
 * Verify an agent credit credential. Returns the agent id + expiry on success. Cryptographic +
 * temporal + issuer validity ONLY — the caller decides what an admitted agent may DO (capabilities).
 */
export async function verifyCreditCredential(jwt: string, opts: CreditVerifyOpts): Promise<CreditResult> {
  const leeway = opts.leewaySec ?? 60
  const parts = decodeJwt<CreditClaims>(jwt)
  if (!parts) return { ok: false, reason: 'malformed credential' }
  const { header, claims, signingInput, signature } = parts

  // 1. Algorithm: RS256 ONLY. Never derive the verifier from the token.
  if (header.alg !== 'RS256') return { ok: false, reason: `unsupported alg ${header.alg}` }
  if (header.typ && header.typ !== 'JWT') return { ok: false, reason: `unexpected typ ${header.typ}` }

  // 2. Pick the signing key from the trusted JWKS by kid (fail closed on unknown kid).
  const rsaKeys = opts.jwks.filter(
    (k) => k.kty === 'RSA' && k.n && k.e && (!k.use || k.use === 'sig') && (!k.alg || k.alg === 'RS256'),
  )
  const candidates = header.kid ? rsaKeys.filter((k) => k.kid === header.kid) : rsaKeys
  if (candidates.length === 0) return { ok: false, reason: header.kid ? `no key for kid ${header.kid}` : 'no usable key' }
  let verified = false
  for (const jwk of candidates) {
    try {
      const key = await importRsaKey(jwk)
      if (await crypto.subtle.verify({ name: 'RSASSA-PKCS1-v1_5' }, key, signature as BufferSource, signingInput as BufferSource)) {
        verified = true
        break
      }
    } catch {
      /* bad key material — try the next candidate */
    }
  }
  if (!verified) return { ok: false, reason: 'bad signature' }

  // 3. Issuer.
  if (!asArray(opts.issuer).includes(claims.iss)) return { ok: false, reason: `bad iss ${claims.iss}` }

  // 4. Optional kind pin.
  if (opts.kind && claims.k !== opts.kind) return { ok: false, reason: 'wrong kind' }

  // 5. Temporal (exp required; nbf/iat optional; a future iat means a skewed/forged clock).
  if (typeof claims.exp !== 'number' || opts.now >= claims.exp + leeway) return { ok: false, reason: 'expired' }
  if (typeof claims.nbf === 'number' && opts.now < claims.nbf - leeway) return { ok: false, reason: 'not yet valid' }
  if (typeof claims.iat === 'number' && claims.iat > opts.now + leeway) return { ok: false, reason: 'issued in the future' }

  // 6. Subject (the agent id) is mandatory.
  if (!claims.sub || typeof claims.sub !== 'string') return { ok: false, reason: 'no sub' }

  return { ok: true, agentId: claims.sub, exp: claims.exp, room: typeof claims.room === 'string' ? claims.room : undefined }
}
