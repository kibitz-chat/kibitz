/**
 * GET /api/email/jwks — the email-code provider's public signing key, as a JWKS.
 *
 * Peers fetch this to verify the RS256 tokens /verify issues — the same way the client fetches
 * Google's JWKS. Derived from the private signing key (its public params), so no separate public
 * key is stored. Cacheable; the kid is stable for the key. Returns {configured:false} while dormant.
 */
import { importSigningKey } from '../../../src/core/emailToken'
import { configured, json, onRequestOptions, type Env } from './_email'

export { onRequestOptions }

export const onRequestGet = async (context: { env: Env }): Promise<Response> => {
  const { env } = context
  if (!configured(env)) return json({ configured: false })
  try {
    const priv = JSON.parse(env.EMAIL_SIGNING_JWK!) as JsonWebKey
    const { publicJwk } = await importSigningKey(priv)
    return json({ keys: [publicJwk] }, 200, { 'cache-control': 'public, max-age=3600' })
  } catch {
    return json({ keys: [] }, 500)
  }
}
