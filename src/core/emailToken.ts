// The signed token our email-code backend issues once a mailed code checks out. It's a plain
// RS256 OIDC-style JWT — so the EXISTING peer-verify (oidcVerify.verifyIdToken / identity.ts
// verifyPeerIdentity) accepts it with NO new client crypto: email-code is just "another OIDC
// provider," our own. The backend signs with its RSA private key (a secret) and publishes the
// public key at a JWKS endpoint; the token carries `email_verified:true` and the cert-binding
// `nonce`, exactly like a Google token, so it's replay-resistant the same way. Runs in a Worker
// and in Node/tests (WebCrypto).

import { bytesToB64url, type Jwk } from './oidcVerify'

const enc = new TextEncoder()
const b64urlJson = (o: unknown) => bytesToB64url(enc.encode(JSON.stringify(o)))
const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('')

const ALGO = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const

export interface EmailTokenClaims {
  iss: string
  aud: string
  email: string
  /** cert-binding nonce = hash(DTLS fingerprint) — see oidcBinding.ts. */
  nonce: string
  sub: string
  iat: number
  exp: number
}

/** Generate the backend's RS256 signing keypair (the private half is the backend's secret). */
export function generateSigningKey(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  ) as Promise<CryptoKeyPair>
}

/** A stable key id derived from the public modulus, so the token's `kid` matches the JWKS key. */
async function kidFromModulus(n: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(n))).slice(0, 16)
}

/** Export the public key as a JWKS entry (RS256/sig + a derived kid) for the /jwks endpoint. */
export async function exportPublicJwk(pub: CryptoKey): Promise<Jwk & { kid: string }> {
  const jwk = (await crypto.subtle.exportKey('jwk', pub)) as JsonWebKey
  const kid = await kidFromModulus(jwk.n!)
  return { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', use: 'sig', kid }
}

/**
 * Load the backend's signing key from a stored PRIVATE JWK (the Worker secret) → the importable
 * signing key + the matching PUBLIC JWK (for the /jwks endpoint) + the kid. The public params
 * (n, e) live in the private JWK, so no separate public key is stored.
 */
export async function importSigningKey(privJwk: JsonWebKey): Promise<{
  key: CryptoKey
  publicJwk: Jwk & { kid: string }
  kid: string
}> {
  const key = await crypto.subtle.importKey('jwk', { ...privJwk, alg: 'RS256', ext: false }, ALGO, false, ['sign'])
  const kid = await kidFromModulus(privJwk.n!)
  return { key, publicJwk: { kty: 'RSA', n: privJwk.n, e: privJwk.e, alg: 'RS256', use: 'sig', kid }, kid }
}

/** Mint a signed token for a verified email. `kid` must match the published JWKS key id. */
export async function signEmailToken(priv: CryptoKey, claims: EmailTokenClaims, kid: string): Promise<string> {
  const header = { alg: 'RS256', typ: 'JWT', kid }
  const payload = { ...claims, email_verified: true }
  const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`
  const sig = await crypto.subtle.sign(ALGO, priv, enc.encode(signingInput))
  return `${signingInput}.${bytesToB64url(new Uint8Array(sig))}`
}
