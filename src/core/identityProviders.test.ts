import { describe, expect, it } from 'vitest'
import { providerFor } from './identityProviders'
import { microsoftIssuer, microsoftDiscovery } from './oidcProvider'
import type { IdentityConfig } from './identity'

const cfg = (over: Partial<IdentityConfig> & Pick<IdentityConfig, 'provider'>): IdentityConfig => ({
  clientId: 'client-123',
  ...over,
})

describe('providerFor — config → sign-in flow, fail-loud on misconfig', () => {
  it('google builds without issuer (engine defaults cover Google)', () => {
    expect(typeof providerFor(cfg({ provider: 'google' })).signIn).toBe('function')
  })

  it('microsoft REQUIRES issuer + discoveryIssuer (else verification would silently fail closed)', () => {
    expect(() => providerFor(cfg({ provider: 'microsoft' }))).toThrow(/issuer and discoveryIssuer/)
    const ok = providerFor(
      cfg({ provider: 'microsoft', issuer: microsoftIssuer('tenant-guid'), discoveryIssuer: microsoftDiscovery('common') }),
    )
    expect(typeof ok.signIn).toBe('function')
  })

  it('oidc REQUIRES authorizeEndpoint AND issuer/discoveryIssuer', () => {
    expect(() => providerFor(cfg({ provider: 'oidc' }))).toThrow(/authorizeEndpoint/)
    expect(() =>
      providerFor(cfg({ provider: 'oidc', authorizeEndpoint: 'https://idp/authorize' })),
    ).toThrow(/issuer and discoveryIssuer/)
    const ok = providerFor(
      cfg({ provider: 'oidc', authorizeEndpoint: 'https://idp/authorize', issuer: 'https://idp', discoveryIssuer: 'https://idp' }),
    )
    expect(typeof ok.signIn).toBe('function')
  })
})

describe('microsoftIssuer — guards the routing-alias footgun', () => {
  it('returns the single-tenant issuer URL for a real tenant id', () => {
    expect(microsoftIssuer('00000000-1111-2222-3333-444444444444')).toBe(
      'https://login.microsoftonline.com/00000000-1111-2222-3333-444444444444/v2.0',
    )
  })

  it('throws on a sign-in alias (which never appears as an iss)', () => {
    for (const alias of ['common', 'organizations', 'consumers']) {
      expect(() => microsoftIssuer(alias)).toThrow(/alias/)
    }
  })
})
