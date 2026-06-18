// Generate the email-code backend's RS256 signing key. Prints the PRIVATE key as a one-line JWK
// to set as the EMAIL_SIGNING_JWK secret; the public half is derived + served at /api/email/jwks.
//
//   node scripts/gen-email-key.mjs
//   # then:
//   npx wrangler pages secret put EMAIL_SIGNING_JWK   # paste the line when prompted
//
// Keep the output secret — anyone with it can mint verified-identity tokens for your provider.
import { webcrypto as crypto } from 'node:crypto'

const kp = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true,
  ['sign', 'verify'],
)
const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey)
process.stdout.write(JSON.stringify(jwk) + '\n')
