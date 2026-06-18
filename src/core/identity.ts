// Serverless (L3) identity: compose token verification + the cert binding into a
// single "is this peer really <email>?" check, with no host server in the loop. A
// peer broadcasts its OIDC ID token over the data mesh; every other peer verifies the
// signature against the provider's PUBLIC keys (JWKS) and checks that the token's
// nonce binds to the DTLS cert it ACTUALLY handshook with. Two facts — Google signed
// it, and it's bound to this exact connection's cert — make impersonation infeasible.

import { bindingMatches } from './oidcBinding'
import { b64urlToBytes, type Jwk, verifyIdToken } from './oidcVerify'

/**
 * Opt-in config to require DECLARED AGENTS to hold a valid network-access "credit credential"
 * (the network-access funding model). Default OFF — absent ⇒ the feature is fully dormant and
 * humans are never affected. Verified PEER-TO-PEER in the authority's browser against the issuer's
 * PUBLISHED JWKS — no shared secret, no callback to the issuer. Self-hosters simply don't pass it.
 */
export interface AgentCreditConfig {
  /** Master switch. When false/absent the gate is dormant (no behaviour change). */
  requireAgentCredits: boolean
  /** Trusted issuer string(s) the credential's `iss` must match (e.g. 'https://issuer.example.com'). */
  issuer: string | string[]
  /** Where to fetch the issuer's JWKS, e.g. 'https://issuer.example.com/.well-known/jwks.json'.
   *  Fetched once and cached; fail-closed (unreachable ⇒ agents not admitted, humans unaffected). */
  jwksUri?: string
  /** OR pre-pinned JWKS keys (offline / self-host / tests) — used as-is, no network. */
  jwks?: Jwk[]
  /** Optional kind tag the credential's `k` must equal (defence in depth; e.g. 'wbz-credit.v1'). */
  kind?: string
}

/** Opt-in mount config. Default OFF — the account-free path is untouched without it. */
export interface IdentityConfig {
  /** Which sign-in flow: 'google' (GIS), 'microsoft' (Entra), or 'oidc' (any standards issuer —
   *  supply `authorizeEndpoint` + `issuer`/`discoveryIssuer`). All verify through the same
   *  cert-bound OIDC check; they differ only in HOW the id_token is obtained in the browser. */
  provider: 'google' | 'microsoft' | 'oidc'
  /** Your OAuth client_id (registered with the provider). */
  clientId: string
  /** `microsoft` only: the Entra tenant — a tenant GUID (single-tenant, fixed issuer; recommended)
   *  or 'organizations'/'consumers'/'common'. Defaults to 'common'. */
  tenant?: string
  /** `oidc` only: the provider's authorization endpoint the popup opens (Okta/Auth0/Entra/…). */
  authorizeEndpoint?: string
  /** Sign-in button label for the generic providers — "Continue with <label>". */
  label?: string
  /** OIDC scopes for the sign-in request (default 'openid email profile'). */
  scope?: string
  /** Override the issuer(s) used to VERIFY the id_token (REQUIRED for microsoft/oidc — the engine
   *  defaults cover Google only; e.g. microsoftIssuer(tenantId)). */
  issuer?: string | string[]
  /** Override the discovery issuer used to fetch JWKS (REQUIRED for microsoft/oidc; e.g.
   *  microsoftDiscovery(tenant)). */
  discoveryIssuer?: string
  /** Require a VERIFIED identity to stay: the host auto-removes anyone who hasn't
   *  proven one within a short grace window. (Host-enforced — see the Widget.) */
  require?: boolean
  /** With `require`, also restrict to these email domains (e.g. ['acme.com']); empty
   *  / omitted → any verified identity is allowed. Matches the email domain OR the
   *  Google Workspace `hd` claim. */
  allowedDomains?: string[]
  /** With `require`, restrict to these exact verified emails (e.g.
   *  ['alice@acme.com', 'bob@example.com']) — a per-person guest list. Combined with
   *  `allowedDomains` as a UNION (allow anyone in either list). When BOTH are empty,
   *  any verified identity is allowed. */
  allowedEmails?: string[]
}

/** A peer's verified, cert-bound identity. */
export interface VerifiedIdentity {
  email: string
  emailVerified: boolean
  name?: string
  picture?: string
  sub: string
  iss: string
  /** Google Workspace hosted domain, when present — handy for "@acme.com only" gates. */
  hd?: string
}

/** Pluggable sign-in (real Google via GIS in googleSignin.ts; a stub in tests). */
export interface IdentityProvider {
  /** Obtain an ID token whose `nonce` equals the value we pass (cert-bound). Renders a
   *  sign-in affordance into `container`; resolves with the JWT or null if cancelled. */
  signIn(opts: { nonce: string; container: HTMLElement }): Promise<{ jwt: string } | null>
}

const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com']
const GOOGLE_DISCOVERY = 'https://accounts.google.com'

/** The accepted issuer(s) for a config. */
export function issuersFor(cfg: IdentityConfig): string | string[] {
  return cfg.issuer ?? GOOGLE_ISSUERS
}

/** The discovery issuer (for JWKS) for a config. */
export function discoveryIssuerFor(cfg: IdentityConfig): string {
  return cfg.discoveryIssuer ?? GOOGLE_DISCOVERY
}

/** Does a verified identity satisfy the room's allow-policy? Two lists, combined as a
 *  UNION: `allowedDomains` (email domain OR Workspace `hd` claim) and `allowedEmails`
 *  (exact addresses — a per-person guest list). Both empty/omitted → any verified
 *  identity passes. Case-insensitive; a leading '@' on a domain entry is tolerated. Pure.
 *  NOTE: `hd`/`email` are only trustworthy because callers run this AFTER verifyPeerIdentity
 *  has checked the token's signature against the provider's JWKS — Google sets these only
 *  for genuine accounts, and a forged claim can't survive an unforgeable signature. Never
 *  call this on an unverified/self-asserted identity. */
export function identityAllowed(
  id: VerifiedIdentity,
  allowedDomains?: readonly string[],
  allowedEmails?: readonly string[],
): boolean {
  const domains = (allowedDomains ?? []).map((d) => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean)
  const emails = (allowedEmails ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean)
  if (domains.length === 0 && emails.length === 0) return true // no policy → any verified identity
  const email = id.email.toLowerCase()
  const domain = email.split('@')[1]
  const hd = id.hd?.toLowerCase()
  if (emails.includes(email)) return true
  return (!!domain && domains.includes(domain)) || (!!hd && domains.includes(hd))
}

/** Add a typed address to a guest list, returning a NEW array (immutable). Trimmed +
 *  lowercased; ignored (list returned unchanged) if it's blank, not a plausible email
 *  (`x@y`), or already present. The match used by `identityAllowed` is exact + lowercased,
 *  so we store the same canonical form. */
export function addAllowedEmail(list: readonly string[], raw: string): string[] {
  const e = raw.trim().toLowerCase()
  if (!/^[^@\s]+@[^@\s]+$/.test(e) || list.includes(e)) return [...list]
  return [...list, e]
}

/** A verification provider accepted in a room: which issuer(s) it speaks for, the audience to
 *  expect, and how to fetch its signing keys. Multiple of these let one room mix providers
 *  (Google + email-code + future Microsoft/Apple) — a token is routed by its `iss`. */
export interface AcceptedProvider {
  issuer: string | string[]
  audience: string
  resolveJwks: () => Promise<Jwk[]>
}

/** Read a JWT's `iss` claim WITHOUT verifying — used ONLY to route to the right provider; the
 *  signature/issuer are still fully checked afterward by verifyPeerIdentity. Null if unreadable. */
export function peekIssuer(jwt: string): string | null {
  const parts = jwt.split('.')
  if (parts.length !== 3) return null
  try {
    const claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1]))) as { iss?: unknown }
    return typeof claims.iss === 'string' ? claims.iss : null
  } catch {
    return null
  }
}

/**
 * Multi-provider peer verify: pick the accepted provider whose issuer matches the token's `iss`,
 * fetch its keys, and run the full cert-bound check. An issuer not in the accepted list is
 * rejected outright (a token from some other provider can't sneak in). This is the seam that
 * lets a verified-roster room admit, say, Google AND email-code members in the same call.
 */
export async function verifyPeerMulti(args: {
  jwt: string
  remoteFp: string
  providers: readonly AcceptedProvider[]
  now: number
  salt?: string
  leewaySec?: number
  maxAgeSec?: number
}): Promise<{ ok: true; identity: VerifiedIdentity } | { ok: false; reason: string }> {
  const iss = peekIssuer(args.jwt)
  if (!iss) return { ok: false, reason: 'no issuer' }
  const provider = args.providers.find((p) => (Array.isArray(p.issuer) ? p.issuer : [p.issuer]).includes(iss))
  if (!provider) return { ok: false, reason: `untrusted issuer ${iss}` }
  const jwks = await provider.resolveJwks()
  return verifyPeerIdentity({
    jwt: args.jwt,
    remoteFp: args.remoteFp,
    audience: provider.audience,
    issuer: provider.issuer,
    jwks,
    now: args.now,
    salt: args.salt,
    leewaySec: args.leewaySec,
    maxAgeSec: args.maxAgeSec,
  })
}

/**
 * Verify a peer's ID token AND its binding to the cert we handshook with. The full
 * L3 check, composed and pure (inject `jwks` + `now`): signature + iss/aud/exp
 * (verifyIdToken) → email_verified → cert-binding (nonce == hash(remoteFp)).
 */
export async function verifyPeerIdentity(args: {
  jwt: string
  /** The DTLS fingerprint of the cert WE actually handshook with for this peer. */
  remoteFp: string
  audience: string
  issuer: string | string[]
  jwks: Jwk[]
  /** Epoch SECONDS. */
  now: number
  /** Room-scoping salt, if used at sign-in. */
  salt?: string
  /** Clock-skew grace for exp/nbf/iat (default 60s in verifyIdToken). */
  leewaySec?: number
  /** Reject a token whose `iat` is older than this many seconds (default: unset → only `exp` bounds age). */
  maxAgeSec?: number
}): Promise<{ ok: true; identity: VerifiedIdentity } | { ok: false; reason: string }> {
  const v = await verifyIdToken(args.jwt, {
    jwks: args.jwks,
    issuer: args.issuer,
    audience: args.audience,
    now: args.now,
    leewaySec: args.leewaySec,
    maxAgeSec: args.maxAgeSec,
  })
  if (!v.ok) return v
  const c = v.claims
  if (c.email_verified !== true || !c.email) return { ok: false, reason: 'email not verified' }
  if (!(await bindingMatches(c.nonce, args.remoteFp, args.salt))) return { ok: false, reason: 'cert binding mismatch' }
  return {
    ok: true,
    identity: {
      email: c.email,
      emailVerified: true,
      name: c.name,
      picture: c.picture,
      sub: c.sub,
      iss: c.iss,
      hd: c.hd,
    },
  }
}
