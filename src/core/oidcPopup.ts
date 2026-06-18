// The serverless OIDC sign-in popup flow — the generic half of L3 sign-in (Google has its own GIS
// SDK; this covers Microsoft/Entra and any standards OIDC issuer). PURE url-building + parsing here
// (unit-tested); the browser glue (window.open / postMessage) lives in oidcProvider.ts.
//
// Flow (implicit, no backend, no secret): open the provider's authorize endpoint in a POPUP with
// `response_type=id_token` + `response_mode=fragment`, so it redirects the popup to our own
// redirect_uri with `#id_token=…&state=…`. The popup posts that back to the opener and closes; the
// opener checks `state` (CSRF) and uses the id_token. We pass our cert-binding `nonce` into the
// authorize request → the provider echoes it into the id_token's `nonce` claim (OIDC) → every peer
// verifies it against the live DTLS cert, exactly as for Google. We request ONLY an id_token (no
// access token, no token-endpoint call), so nothing long-lived rides in the URL.

export interface AuthorizeParams {
  /** The provider's OIDC authorization endpoint. */
  authorizeEndpoint: string
  /** OAuth client_id registered with the provider. */
  clientId: string
  /** Where the provider sends the popup back — must be a registered redirect URI on our origin. */
  redirectUri: string
  /** Cert-binding nonce → the id_token's `nonce` claim (verbatim). */
  nonce: string
  /** Opaque random anti-CSRF value, echoed back and checked on return. */
  state: string
  /** OIDC scopes (default: openid email profile — enough for a verified identity, no API access). */
  scope?: string
  /** Provider-specific extras (e.g. { prompt: 'select_account' }). Never overrides the core params. */
  extraParams?: Record<string, string>
}

const CORE_KEYS = new Set(['client_id', 'redirect_uri', 'response_type', 'response_mode', 'scope', 'nonce', 'state'])

/** Build the authorize URL the popup opens. Implicit id_token in the fragment — no token endpoint,
 *  no secret, no access token. */
export function buildAuthorizeUrl(p: AuthorizeParams): string {
  const u = new URL(p.authorizeEndpoint)
  // HTTPS only — an http (or javascript:) endpoint would leak the nonce/state in cleartext or be an
  // injection vector. The provider's authorize endpoint is always https; reject anything else.
  if (u.protocol !== 'https:') throw new Error(`authorizeEndpoint must be https, got ${u.protocol}`)
  const q = u.searchParams
  q.set('client_id', p.clientId)
  q.set('redirect_uri', p.redirectUri)
  q.set('response_type', 'id_token')
  q.set('response_mode', 'fragment')
  q.set('scope', p.scope?.trim() || 'openid email profile')
  q.set('nonce', p.nonce)
  q.set('state', p.state)
  // Extras are applied LAST but can't clobber the security-critical core params.
  for (const [k, v] of Object.entries(p.extraParams ?? {})) if (!CORE_KEYS.has(k)) q.set(k, v)
  return u.toString()
}

export interface OidcCallback {
  idToken?: string
  state?: string
  error?: string
}

/** Parse the fragment the provider redirected the popup to (`#id_token=…&state=…` or `#error=…`). */
export function parseOidcFragment(hash: string): OidcCallback {
  const f = new URLSearchParams(hash.replace(/^#/, ''))
  const error = f.get('error')
  return {
    idToken: f.get('id_token') ?? undefined,
    state: f.get('state') ?? undefined,
    error: error ? `${error}${f.get('error_description') ? `: ${f.get('error_description')}` : ''}` : undefined,
  }
}

/** Does this page load look like an OIDC sign-in popup callback (so an early bootstrap can post it
 *  back to the opener instead of mounting the app)? It carries an id_token OR an error, plus a state. */
export function isOidcCallback(hash: string): boolean {
  const f = new URLSearchParams(hash.replace(/^#/, ''))
  return (f.has('id_token') || f.has('error')) && f.has('state')
}
