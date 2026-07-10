// Pick the browser sign-in flow for an IdentityConfig. The VERIFY side is provider-agnostic
// (oidcVerify checks any issuer's JWKS); only the SIGN-IN differs — Google uses GIS, everything
// else uses the generic OIDC popup (oidcProvider). One place maps config → provider so useCall and
// any embedder agree.

import type { IdentityConfig, IdentityProvider } from './identity'
import { googleProvider } from './googleSignin'
import { microsoftProvider, oidcProvider } from './oidcProvider'

/** Build the sign-in provider for a config. Throws only on an `oidc` config missing its
 *  authorizeEndpoint (a programming error — fail loud at sign-in setup, not silently). */
export function providerFor(cfg: IdentityConfig): IdentityProvider {
  // For non-Google providers the engine's issuer/discovery defaults (Google) DON'T apply — without
  // an explicit issuer + discoveryIssuer, every token would fail to verify, silently. Fail loud at
  // setup instead (a config error), not at sign-in time with a mysteriously-null identity.
  const needsIssuer = (): void => {
    if (!cfg.issuer || !cfg.discoveryIssuer)
      throw new Error(
        `identity: provider '${cfg.provider}' requires both issuer and discoveryIssuer ` +
          `(e.g. microsoftIssuer(tenantId) / microsoftDiscovery(tenant)) — the engine defaults only cover Google`,
      )
  }
  switch (cfg.provider) {
    case 'microsoft':
      needsIssuer()
      return microsoftProvider(cfg.clientId, cfg.tenant)
    case 'oidc':
      if (!cfg.authorizeEndpoint) throw new Error("identity: provider 'oidc' requires an authorizeEndpoint")
      needsIssuer()
      return oidcProvider({
        clientId: cfg.clientId,
        authorizeEndpoint: cfg.authorizeEndpoint,
        label: cfg.label,
        scope: cfg.scope,
      })
    case 'google':
    default:
      return googleProvider(cfg.clientId)
  }
}
