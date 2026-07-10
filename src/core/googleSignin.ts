// Google sign-in via Google Identity Services (GIS) — the browser half of L3. We pass
// our cert-bound `nonce` into GIS; Google echoes it verbatim into the signed ID
// token's `nonce` claim (standard OIDC), which is exactly what every peer checks
// against the live connection's cert. No backend, no token exchange — the rendered
// Google button hands us the ID token (JWT) directly in its callback.
//
// Browser-only glue (DOM + an external script), so it's not unit-tested; the security
// logic it feeds lives in the tested core (oidcVerify / oidcBinding / identity).

import type { IdentityProvider } from './identity'

const GIS_SRC = 'https://accounts.google.com/gsi/client'

interface GisId {
  initialize(cfg: {
    client_id: string
    nonce?: string
    callback: (resp: { credential?: string }) => void
    cancel_on_tap_outside?: boolean
  }): void
  renderButton(el: HTMLElement, opts: Record<string, unknown>): void
  cancel(): void
}
type GisWindow = Window & { google?: { accounts?: { id?: GisId } } }

let gisPromise: Promise<GisId> | null = null

/** Load GIS once; resolve with google.accounts.id. */
function loadGis(): Promise<GisId> {
  if (gisPromise) return gisPromise
  gisPromise = new Promise<GisId>((resolve, reject) => {
    const existing = (window as GisWindow).google?.accounts?.id
    if (existing) return resolve(existing)
    const s = document.createElement('script')
    s.src = GIS_SRC
    s.async = true
    s.defer = true
    s.onload = () => {
      const id = (window as GisWindow).google?.accounts?.id
      if (id) resolve(id)
      else reject(new Error('GIS loaded but google.accounts.id is missing'))
    }
    s.onerror = () => {
      gisPromise = null // allow a retry after a transient load failure
      reject(new Error('failed to load Google Identity Services'))
    }
    document.head.appendChild(s)
  })
  return gisPromise
}

/** A Google `IdentityProvider` — renders the official Google button into `container`
 *  and resolves with the ID token (cert-bound via `nonce`) when the user signs in. */
export function googleProvider(clientId: string): IdentityProvider {
  return {
    async signIn({ nonce, container }) {
      const id = await loadGis()
      return new Promise<{ jwt: string } | null>((resolve) => {
        let settled = false
        const finish = (v: { jwt: string } | null) => {
          if (settled) return
          settled = true
          resolve(v)
        }
        id.initialize({
          client_id: clientId,
          nonce, // → ID token's `nonce` claim, verbatim (OIDC); the cert binding
          callback: (resp) => finish(resp.credential ? { jwt: resp.credential } : null),
          cancel_on_tap_outside: false,
        })
        container.innerHTML = ''
        id.renderButton(container, {
          type: 'standard',
          theme: 'outline',
          size: 'large',
          text: 'continue_with',
          shape: 'pill',
        })
      })
    },
  }
}
