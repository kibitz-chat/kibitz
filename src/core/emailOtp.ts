// Email one-time-code (OTP) lifecycle — the pure heart of the email-code verification method
// (docs/verification.md §4.5). A backend Worker mails a short code to an address, holds only its
// HASH (never the plaintext, never the link), rate-limits guesses, and — on a correct, unexpired,
// under-cap code — issues a signed token (see emailToken.ts). Because the verifier (the Worker)
// holds the secret and throttles, a short 6-digit code is safe: there's no offline brute-force
// oracle in the link. These helpers run in both a Worker and Node/tests (WebCrypto + getRandomValues).

export const OTP_TTL_SEC = 600 // a mailed code is good for 10 minutes
export const OTP_MAX_ATTEMPTS = 5 // then the code is locked (re-request a new one)

/** The transient record the backend stores (keyed per request), never exposed to clients. */
export interface OtpRecord {
  /** hex sha256(salt + ':' + code) — the plaintext code is never stored. */
  codeHash: string
  /** per-record salt, so identical codes don't share a hash across records. */
  salt: string
  email: string
  room: string
  /** the cert-binding nonce to embed in the issued token (replay-resistance, like OIDC). */
  nonce: string
  /** expiry, epoch SECONDS. */
  exp: number
  /** wrong guesses so far. */
  attempts: number
}

const enc = new TextEncoder()
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

/** A uniform 6-digit code via rejection sampling (no modulo bias). */
export function newOtpCode(): string {
  let out = ''
  const buf = new Uint8Array(1)
  while (out.length < 6) {
    crypto.getRandomValues(buf)
    if (buf[0] < 250) out += (buf[0] % 10).toString() // 250 = 25*10 → 0..9 uniform
  }
  return out
}

/** A random per-record salt (base of the hash). */
export function newSalt(): string {
  const b = new Uint8Array(16)
  crypto.getRandomValues(b)
  return hex(b)
}

/** Hash a code under a salt — what the backend stores instead of the plaintext. */
export async function hashOtp(code: string, salt: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(`${salt}:${code}`))
  return hex(new Uint8Array(digest))
}

/** Constant-time string compare (equal-length hex strings) — no early-exit timing leak. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export type OtpCheck = { ok: true } | { ok: false; reason: 'expired' | 'locked' | 'mismatch' }

/**
 * Verify a submitted code against a stored record. Pure (just hashing). Order matters: a locked
 * or expired record is refused BEFORE comparing, so a maxed-out code can't be brute-forced past
 * the cap. The caller (the Worker) increments `attempts` + persists on a mismatch, and deletes
 * the record on success.
 */
export async function checkOtp(input: string, rec: OtpRecord, now: number): Promise<OtpCheck> {
  if (now >= rec.exp) return { ok: false, reason: 'expired' }
  if (rec.attempts >= OTP_MAX_ATTEMPTS) return { ok: false, reason: 'locked' }
  const h = await hashOtp(input, rec.salt)
  return timingSafeEqual(h, rec.codeHash) ? { ok: true } : { ok: false, reason: 'mismatch' }
}
