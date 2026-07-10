// End-to-end test for the email-code backend (after you've provisioned KV + MailChannels +
// the signing key). Runs the WHOLE live chain: /start mails a code → you type it → /verify
// returns a signed token → /jwks → we check the token's RS256 signature + claims locally.
//
//   node scripts/email-e2e.mjs <baseUrl> <your-email> [room]
//   # e.g. local:    node scripts/email-e2e.mjs http://localhost:8788 you@example.com test
//   #      deployed: node scripts/email-e2e.mjs https://kibitz.chat you@example.com test
//
// PASS means: a real code reached your inbox, the backend verified it, and the token it minted
// verifies against the published JWKS — i.e. the whole backend works. (Cert-binding is a
// client-only concern, so this test uses a placeholder nonce.)
import { webcrypto as crypto } from 'node:crypto'
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'

const [, , base = 'http://localhost:8788', email, room = 'test'] = process.argv
if (!email) {
  console.error('usage: node scripts/email-e2e.mjs <baseUrl> <your-email> [room]')
  process.exit(2)
}
const url = (p) => `${base.replace(/\/$/, '')}/api/email/${p}`
const nonce = 'e2e-test-nonce'

const b64urlToBytes = (s) => {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)
  return new Uint8Array(Buffer.from(b64, 'base64'))
}
const decodeSeg = (s) => JSON.parse(Buffer.from(b64urlToBytes(s)).toString('utf8'))

async function main() {
  console.log(`→ POST ${url('start')}  (${email}, room=${room})`)
  const startRes = await fetch(url('start'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, room, nonce }),
  }).then((r) => r.json())
  if (startRes.configured === false) throw new Error('backend DORMANT — bind OTP_KV + EMAIL_SIGNING_JWK + MAILCHANNELS_API_KEY first')
  if (!startRes.ok) throw new Error(`start failed: ${JSON.stringify(startRes)}`)
  console.log('✓ code mailed — check your inbox.')

  const rl = createInterface({ input, output })
  const code = (await rl.question('enter the 6-digit code: ')).trim()
  rl.close()

  console.log(`→ POST ${url('verify')}`)
  const verifyRes = await fetch(url('verify'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ticket: startRes.ticket, code }),
  }).then((r) => r.json())
  if (!verifyRes.ok) throw new Error(`verify failed: ${JSON.stringify(verifyRes)}`)
  console.log('✓ code accepted, token issued.')

  const jwks = await fetch(url('jwks')).then((r) => r.json())
  if (!jwks.keys?.length) throw new Error('jwks empty')

  // Verify the token's RS256 signature against the published key, locally.
  const [h, p, s] = verifyRes.jwt.split('.')
  const header = decodeSeg(h)
  const claims = decodeSeg(p)
  const jwk = jwks.keys.find((k) => k.kid === header.kid) ?? jwks.keys[0]
  const key = await crypto.subtle.importKey('jwk', { ...jwk, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])
  const ok = await crypto.subtle.verify({ name: 'RSASSA-PKCS1-v1_5' }, key, b64urlToBytes(s), new TextEncoder().encode(`${h}.${p}`))
  if (!ok) throw new Error('token signature did NOT verify against the JWKS')

  console.log('\n✅ PASS — full chain works:')
  console.log(`   email_verified: ${claims.email_verified}`)
  console.log(`   email:          ${claims.email}`)
  console.log(`   iss / aud:      ${claims.iss} / ${claims.aud}`)
  console.log(`   nonce:          ${claims.nonce}`)
  console.log(`   signature:      valid against /api/email/jwks`)
}

main().catch((e) => {
  console.error(`\n❌ ${e.message}`)
  process.exit(1)
})
