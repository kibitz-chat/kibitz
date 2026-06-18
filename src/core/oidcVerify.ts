// Hand-rolled OIDC ID-token verification (RS256 only) over WebCrypto — no library,
// matching the repo's zero-dependency, crypto.subtle-based style (see safetyCode.ts).
//
// SECURITY NOTES (this guards an identity badge, so the sharp edges matter):
//  - We accept ONLY RS256 and verify with RSASSA-PKCS1-v1_5/SHA-256. `alg:"none"`,
//    HS* (symmetric — the classic alg-confusion attack), and ES* are all rejected
//    outright; the algorithm is never taken from the token to pick the verifier.
//  - The key is selected by `kid` from a trusted JWKS the CALLER supplies (fetched
//    from the provider's published keys). An unknown `kid` fails closed.
//  - We validate iss / aud / exp / nbf. We surface `email_verified` and `nonce` in
//    the claims but do NOT decide policy here — the caller must require
//    `email_verified === true` AND check the cert binding (see oidcBinding.ts) before
//    trusting the identity. This module answers only: "is this a genuine, unexpired,
//    correctly-audienced token signed by a key in the JWKS?"
//  - `now` is injectable so the temporal checks are deterministic in tests.

/** A JSON Web Key (the subset we need — RSA signing keys). */
export interface Jwk {
  kty: string
  n?: string
  e?: string
  kid?: string
  alg?: string
  use?: string
}

/** The ID-token claims we read (provider may include more; these are the ones we use). */
export interface IdClaims {
  iss: string
  aud: string | string[]
  sub: string
  exp: number
  iat?: number
  nbf?: number
  nonce?: string
  email?: string
  email_verified?: boolean
  name?: string
  picture?: string
  hd?: string // Google Workspace hosted domain, when present
  [k: string]: unknown
}

export interface VerifyOpts {
  /** Trusted signing keys (the provider's published JWKS `keys`). */
  jwks: Jwk[]
  /** Expected issuer(s). Google uses both `https://accounts.google.com` and `accounts.google.com`. */
  issuer: string | string[]
  /** Expected audience — your OAuth client_id. */
  audience: string
  /** Current time (epoch SECONDS). Injected for determinism. */
  now: number
  /** Clock-skew leeway in seconds (default 60). */
  leewaySec?: number
  /** If set, reject a token whose `iat` is older than this many seconds (defence in
   *  depth beyond `exp`). Off by default so longer-lived providers aren't false-rejected. */
  maxAgeSec?: number
}

export type VerifyResult = { ok: true; claims: IdClaims } | { ok: false; reason: string }

// --- base64url (browser-safe: atob/btoa exist in browsers AND node) ----------------

export function b64urlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function bytesToB64url(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const dec = new TextDecoder()
const enc = new TextEncoder()

function decodeJson<T>(seg: string): T {
  return JSON.parse(dec.decode(b64urlToBytes(seg))) as T
}

export interface JwtHeader {
  alg: string
  kid?: string
  typ?: string
}

/** Split a compact JWS into its parts, keeping the RAW signing input bytes (never
 *  re-encoded — re-encoding could differ and break the signature). Generic over the
 *  claim shape so non-OIDC JWS (e.g. the agent credit credential) can reuse it. */
export function decodeJwt<C = IdClaims>(jwt: string): {
  header: JwtHeader
  claims: C
  signingInput: Uint8Array
  signature: Uint8Array
} | null {
  const parts = jwt.split('.')
  if (parts.length !== 3) return null
  const [h, p, s] = parts
  try {
    return {
      header: decodeJson<JwtHeader>(h),
      claims: decodeJson<C>(p),
      signingInput: enc.encode(`${h}.${p}`),
      signature: b64urlToBytes(s),
    }
  } catch {
    return null
  }
}

export async function importRsaKey(jwk: Jwk): Promise<CryptoKey> {
  // Import as an RS256 verify key. We pass only the fields WebCrypto needs and pin
  // the algorithm ourselves — we never let the token's header choose it.
  return crypto.subtle.importKey(
    'jwk',
    { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  )
}

export const asArray = (v: string | string[]): string[] => (Array.isArray(v) ? v : [v])

/**
 * Verify an OIDC ID token. Returns the claims on success, or a reason on failure.
 * Cryptographic + temporal + audience validity only — the caller enforces
 * email_verified and the cert-binding (nonce) policy.
 */
export async function verifyIdToken(jwt: string, opts: VerifyOpts): Promise<VerifyResult> {
  const leeway = opts.leewaySec ?? 60
  const parts = decodeJwt(jwt)
  if (!parts) return { ok: false, reason: 'malformed token' }
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
  // If the header names a kid we use exactly that key; without a kid we try each
  // (Google always sends a kid, so this is a tolerant fallback, not the norm).
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

  // 3. Issuer / audience.
  if (!asArray(opts.issuer).includes(claims.iss)) return { ok: false, reason: `bad iss ${claims.iss}` }
  if (!asArray(claims.aud).includes(opts.audience)) return { ok: false, reason: 'bad aud' }

  // 4. Temporal (exp required; nbf/iat optional). A future iat means a skewed/forged
  //    clock; an over-age iat is rejected only when maxAgeSec is set.
  if (typeof claims.exp !== 'number' || opts.now >= claims.exp + leeway) return { ok: false, reason: 'expired' }
  if (typeof claims.nbf === 'number' && opts.now < claims.nbf - leeway) return { ok: false, reason: 'not yet valid' }
  if (typeof claims.iat === 'number') {
    if (claims.iat > opts.now + leeway) return { ok: false, reason: 'issued in the future' }
    if (opts.maxAgeSec != null && opts.now - claims.iat > opts.maxAgeSec) return { ok: false, reason: 'token too old' }
  }
  if (!claims.sub) return { ok: false, reason: 'no sub' }

  return { ok: true, claims }
}
