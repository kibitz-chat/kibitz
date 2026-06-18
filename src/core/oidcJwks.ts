// Fetch a provider's signing keys (JWKS) so peers can verify ID tokens locally — no
// host server, just the provider's PUBLIC keys (the same keys for everyone, served
// from the provider's CDN). Uses OIDC Discovery so it's provider-agnostic: point it
// at an issuer and it finds the jwks_uri. Cached with a TTL so we don't refetch per
// token; `fetch`/`now` are injectable for tests and so the offline/LAN build (no
// internet → no JWKS → no identity badge) degrades honestly rather than hanging.

import type { Jwk } from './oidcVerify'

type FetchLike = (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>

const defaultFetch: FetchLike = (url) => fetch(url)

const stripSlash = (s: string) => s.replace(/\/+$/, '')

/** Resolve an issuer's jwks_uri via its OIDC discovery document. */
export async function discoverJwksUri(issuer: string, fetchFn: FetchLike = defaultFetch): Promise<string> {
  const res = await fetchFn(`${stripSlash(issuer)}/.well-known/openid-configuration`)
  if (!res.ok) throw new Error(`discovery failed for ${issuer}`)
  const doc = (await res.json()) as { jwks_uri?: unknown }
  if (typeof doc.jwks_uri !== 'string') throw new Error('discovery doc missing jwks_uri')
  // Require HTTPS for the keys (no http/data downgrade). We can't pin same-origin —
  // Google legitimately serves its issuer at accounts.google.com but its jwks_uri at
  // www.googleapis.com — so the discovery doc's integrity rests on TLS to the issuer.
  if (new URL(doc.jwks_uri).protocol !== 'https:') throw new Error('jwks_uri must be https')
  return doc.jwks_uri
}

/** Fetch the key set at a jwks_uri. */
export async function fetchJwks(jwksUri: string, fetchFn: FetchLike = defaultFetch): Promise<Jwk[]> {
  const res = await fetchFn(jwksUri)
  if (!res.ok) throw new Error(`jwks fetch failed: ${jwksUri}`)
  const doc = (await res.json()) as { keys?: unknown }
  if (!Array.isArray(doc.keys)) throw new Error('jwks missing keys[]')
  return doc.keys as Jwk[]
}

export interface JwksResolverOpts {
  fetch?: FetchLike
  /** Current time in ms (injected for deterministic cache tests). */
  now?: () => number
  /** Cache lifetime; default 1h. */
  ttlMs?: number
}

/** A per-issuer JWKS resolver with discovery + TTL caching. Returns `resolve(issuer)`
 *  that yields the current keys, refetching only after the TTL. */
export function createJwksResolver(opts: JwksResolverOpts = {}) {
  const fetchFn = opts.fetch ?? defaultFetch
  const now = opts.now ?? (() => Date.now())
  const ttl = opts.ttlMs ?? 3_600_000
  const cache = new Map<string, { keys: Jwk[]; at: number }>()

  return {
    async resolve(issuer: string): Promise<Jwk[]> {
      const hit = cache.get(issuer)
      if (hit && now() - hit.at < ttl) return hit.keys
      const keys = await fetchJwks(await discoverJwksUri(issuer, fetchFn), fetchFn)
      cache.set(issuer, { keys, at: now() })
      return keys
    },
    /** Drop a cached issuer (e.g. after a verify miss on an unknown kid → force refetch). */
    invalidate(issuer: string) {
      cache.delete(issuer)
    },
  }
}
