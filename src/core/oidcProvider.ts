// Generic OIDC sign-in provider (the popup half) — covers Microsoft/Entra and any standards OIDC
// issuer, generalizing googleSignin.ts (Google keeps its own GIS SDK). Renders a "Continue with …"
// button; on click it opens the provider's authorize endpoint in a POPUP (implicit id_token, see
// oidcPopup.ts), waits for the popup to post the result back, validates the anti-CSRF `state`, and
// resolves with the cert-bound id_token. Browser-only glue (window.open + postMessage) so it isn't
// unit-tested; the URL/parse core (oidcPopup.ts) and the verification (oidcVerify/identity) are.
//
// SECURITY: id_token only (no access token in the URL); strict `event.origin === location.origin`
// on the postMessage; `state` matched to reject cross-window/CSRF; `nonce` carries the cert binding;
// the popup side (an early bootstrap in main.tsx) only ever posts to its OWN opener on our origin.

import type { IdentityProvider } from './identity'
import { buildAuthorizeUrl } from './oidcPopup'

export interface OidcProviderConfig {
  /** OAuth client_id registered with the provider. */
  clientId: string
  /** The provider's OIDC authorization endpoint. */
  authorizeEndpoint: string
  /** Button label, e.g. 'Microsoft' → "Continue with Microsoft". */
  label?: string
  /** OIDC scopes (default 'openid email profile'). */
  scope?: string
  /** Provider-specific authorize extras (e.g. { prompt: 'select_account' }); can't override core params. */
  extraParams?: Record<string, string>
  /** Registered redirect URI the popup comes back to (default: this origin's root). */
  redirectUri?: string
}

const MESSAGE_TYPE = 'kibitz-oidc'
const POPUP_TIMEOUT_MS = 5 * 60_000

function randomState(): string {
  const a = new Uint8Array(16)
  crypto.getRandomValues(a)
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** A config-driven OIDC `IdentityProvider`: a sign-in button that runs the popup flow. */
export function oidcProvider(config: OidcProviderConfig): IdentityProvider {
  return {
    signIn({ nonce, container }) {
      return new Promise<{ jwt: string } | null>((resolve) => {
        let settled = false
        let state = ''
        let popup: Window | null = null
        let pollTimer: ReturnType<typeof setInterval> | null = null
        let timeout: ReturnType<typeof setTimeout> | null = null

        const cleanup = () => {
          window.removeEventListener('message', onMessage)
          if (pollTimer) clearInterval(pollTimer)
          if (timeout) clearTimeout(timeout)
          try {
            popup?.close()
          } catch {
            /* cross-origin popup may refuse close() — harmless */
          }
        }
        const finish = (v: { jwt: string } | null) => {
          if (settled) return
          settled = true
          cleanup()
          resolve(v)
        }
        // Accept the result ONLY from our own origin + matching state (anti-CSRF), and only the
        // kibitz-oidc message shape. Anything else is ignored.
        const onMessage = (e: MessageEvent) => {
          if (e.origin !== location.origin) return
          const d = e.data as { type?: string; idToken?: string; state?: string; error?: string } | null
          if (!d || d.type !== MESSAGE_TYPE || !state || d.state !== state) return
          finish(d.idToken ? { jwt: d.idToken } : null)
        }

        container.innerHTML = ''
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.textContent = `Continue with ${config.label || 'your provider'}`
        btn.style.cssText =
          'padding:10px 16px;border-radius:9999px;border:1px solid #ccc;background:#fff;font:inherit;cursor:pointer'
        btn.onclick = () => {
          if (popup && !popup.closed) {
            popup.focus()
            return
          }
          state = randomState()
          const url = buildAuthorizeUrl({
            authorizeEndpoint: config.authorizeEndpoint,
            clientId: config.clientId,
            redirectUri: config.redirectUri || `${location.origin}/`,
            nonce,
            state,
            scope: config.scope,
            extraParams: config.extraParams,
          })
          popup = window.open(url, 'kibitz-oidc-signin', 'width=480,height=680,menubar=no,toolbar=no')
          if (!popup) return // popup blocked — leave the button for a retry; no listener registered yet
          // Register the listener ONLY once the popup is open (no live listener with a half-set state).
          window.addEventListener('message', onMessage)
          pollTimer = setInterval(() => {
            if (popup && popup.closed) finish(null) // user closed it without finishing
          }, 500)
          timeout = setTimeout(() => finish(null), POPUP_TIMEOUT_MS)
        }
        container.appendChild(btn)
      })
    },
  }
}

// ── Presets ───────────────────────────────────────────────────────────────────────────────────

/** Microsoft / Entra (Azure AD) sign-in. `tenant` is a tenant GUID (single-tenant — recommended,
 *  fixed issuer) or 'organizations'/'consumers'/'common'. For verification, pair with
 *  `microsoftIssuer(tenantId)` + `microsoftDiscovery(tenant)` in the IdentityConfig. Note: 'common'
 *  multi-tenant has a PER-TENANT issuer (the `iss` carries the real tenant id) — single-tenant is
 *  the clean path today; multi-tenant issuer-templating is a follow-on. */
export function microsoftProvider(clientId: string, tenant = 'common'): IdentityProvider {
  return oidcProvider({
    clientId,
    authorizeEndpoint: `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/authorize`,
    label: 'Microsoft',
    extraParams: { prompt: 'select_account' },
  })
}

/** Microsoft's id_token issuer for a SINGLE tenant (the `iss` claim to verify against). Pass the
 *  tenant GUID — NOT a sign-in routing alias ('common'/'organizations'/'consumers'), which never
 *  appears as an `iss` (Microsoft bakes the real tenant id into the token). Throws on an alias so a
 *  multi-tenant misconfig fails loudly at setup, not as a silently-unverifiable room. */
export const microsoftIssuer = (tenantId: string): string => {
  if (tenantId === 'common' || tenantId === 'organizations' || tenantId === 'consumers')
    throw new Error(
      `microsoftIssuer: '${tenantId}' is a sign-in routing alias, not a verifiable issuer — pass the tenant GUID ` +
        `(single-tenant). Multi-tenant 'common' needs per-tenant issuer handling (not yet supported).`,
    )
  return `https://login.microsoftonline.com/${tenantId}/v2.0`
}
/** Microsoft's discovery base (→ `${it}/.well-known/openid-configuration` → jwks_uri). */
export const microsoftDiscovery = (tenant: string): string => `https://login.microsoftonline.com/${tenant}/v2.0`
