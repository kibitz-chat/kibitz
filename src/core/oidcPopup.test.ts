import { describe, expect, it } from 'vitest'
import { buildAuthorizeUrl, parseOidcFragment, isOidcCallback, type AuthorizeParams } from './oidcPopup'

const base: AuthorizeParams = {
  authorizeEndpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
  clientId: 'abc-123',
  redirectUri: 'https://kibitz.chat/',
  nonce: 'NONCE',
  state: 'STATE',
}

describe('buildAuthorizeUrl — implicit id_token, fragment, cert-bound nonce', () => {
  it('sets the core OIDC params (no access token, no token endpoint)', () => {
    const u = new URL(buildAuthorizeUrl(base))
    expect(u.origin + u.pathname).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/authorize')
    const q = u.searchParams
    expect(q.get('client_id')).toBe('abc-123')
    expect(q.get('redirect_uri')).toBe('https://kibitz.chat/')
    expect(q.get('response_type')).toBe('id_token') // id_token only — never a bare access token in the URL
    expect(q.get('response_mode')).toBe('fragment') // comes back in the fragment, not posted to a server
    expect(q.get('scope')).toBe('openid email profile')
    expect(q.get('nonce')).toBe('NONCE') // the cert binding
    expect(q.get('state')).toBe('STATE') // CSRF
  })

  it('honors a custom scope and provider extras', () => {
    const q = new URL(buildAuthorizeUrl({ ...base, scope: 'openid email', extraParams: { prompt: 'select_account' } }))
      .searchParams
    expect(q.get('scope')).toBe('openid email')
    expect(q.get('prompt')).toBe('select_account')
  })

  it('rejects a non-https authorizeEndpoint (no cleartext nonce/state, no scheme injection)', () => {
    expect(() => buildAuthorizeUrl({ ...base, authorizeEndpoint: 'http://login.example/authorize' })).toThrow(/https/)
    expect(() => buildAuthorizeUrl({ ...base, authorizeEndpoint: 'javascript:alert(1)' })).toThrow()
  })

  it('extras CANNOT clobber the security-critical core params', () => {
    const q = new URL(
      buildAuthorizeUrl({
        ...base,
        extraParams: { response_type: 'token', redirect_uri: 'https://evil.test/', nonce: 'attacker' },
      }),
    ).searchParams
    expect(q.get('response_type')).toBe('id_token') // not 'token'
    expect(q.get('redirect_uri')).toBe('https://kibitz.chat/')
    expect(q.get('nonce')).toBe('NONCE')
  })
})

describe('parseOidcFragment / isOidcCallback', () => {
  it('extracts id_token + state from a success fragment', () => {
    expect(parseOidcFragment('#id_token=eyJ.a.b&state=STATE&token_type=Bearer')).toEqual({
      idToken: 'eyJ.a.b',
      state: 'STATE',
      error: undefined,
    })
  })

  it('surfaces a provider error (with description)', () => {
    const r = parseOidcFragment('#error=access_denied&error_description=user+said+no&state=STATE')
    expect(r.idToken).toBeUndefined()
    expect(r.error).toBe('access_denied: user said no')
    expect(r.state).toBe('STATE')
  })

  it('isOidcCallback is true for a sign-in fragment, false for a plain room hash', () => {
    expect(isOidcCallback('#id_token=eyJ&state=STATE')).toBe(true)
    expect(isOidcCallback('#error=access_denied&state=STATE')).toBe(true)
    expect(isOidcCallback('#standup')).toBe(false) // a normal room id
    expect(isOidcCallback('#id_token=eyJ')).toBe(false) // missing state → not our callback
    expect(isOidcCallback('')).toBe(false)
  })
})
