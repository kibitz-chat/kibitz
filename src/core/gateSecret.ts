import { b64urlToBytes, bytesToB64url } from './oidcVerify'

// Layer 2 (privacy): seal a verified-room's signed manifest under an OUT-OF-BAND group secret — a
// passphrase the creator shares with the group SEPARATELY from the link. The link then carries only
// CIPHERTEXT, so neither the web host NOR a link-holder-without-the-passphrase can read the roster
// (emails / invitees). A member enters the passphrase to decrypt → the original manifest token,
// which verifies exactly as before (no gate change). This decouples "who can open the link" from
// "who can read the roster + join" — and, unlike the fragment move (which only hides from the host),
// also hides from anyone who merely intercepts the link.
//
// Key: PBKDF2-HMAC-SHA256 over the NFKC-normalized passphrase + a per-link random salt. Payload:
// AES-256-GCM (authenticated — a wrong passphrase or any tamper fails closed). Blob layout (then
// base64url): [version(1)] [salt(16)] [iv(12)] [ciphertext+tag]. The passphrase is the ONLY secret;
// salt+iv are public (in the link). HONEST LIMIT: strength == the passphrase's entropy — a weak,
// guessable passphrase is brute-forceable offline by a link-holder (PBKDF2 only slows it). Use a
// strong shared secret. Browser/page caveats from the wider threat model still apply.

const enc = new TextEncoder()
const dec = new TextDecoder()
const VERSION = 1
// PBKDF2 work factor — an OWASP-aligned floor for PBKDF2-HMAC-SHA256; raise over time (the version
// byte lets a future build change params while still opening old blobs by their embedded version).
const PBKDF2_ITERS = 210_000
const SALT_LEN = 16
const IV_LEN = 12
const TAG_LEN = 16 // AES-GCM tag, included in the ciphertext by WebCrypto

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase.normalize('NFKC')) as BufferSource, 'PBKDF2', false, [
    'deriveKey',
  ])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: PBKDF2_ITERS, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/** Seal a manifest token under a passphrase → a base64url blob (version|salt|iv|ciphertext+tag). */
export async function encryptManifest(manifestToken: string, passphrase: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN))
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN))
  const key = await deriveKey(passphrase, salt)
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, enc.encode(manifestToken) as BufferSource),
  )
  const out = new Uint8Array(1 + SALT_LEN + IV_LEN + ct.length)
  out[0] = VERSION
  out.set(salt, 1)
  out.set(iv, 1 + SALT_LEN)
  out.set(ct, 1 + SALT_LEN + IV_LEN)
  return bytesToB64url(out)
}

/** Open a sealed manifest with a passphrase → the original token, or null on a wrong passphrase,
 *  a tampered/malformed blob, or an unknown version. NEVER throws — the caller reads null as
 *  "couldn't unlock" (prompt again / fall back to the inert state). */
export async function decryptManifest(blob: string, passphrase: string): Promise<string | null> {
  try {
    const raw = b64urlToBytes(blob)
    if (raw.length < 1 + SALT_LEN + IV_LEN + TAG_LEN || raw[0] !== VERSION) return null
    const salt = raw.slice(1, 1 + SALT_LEN)
    const iv = raw.slice(1 + SALT_LEN, 1 + SALT_LEN + IV_LEN)
    const ct = raw.slice(1 + SALT_LEN + IV_LEN)
    const key = await deriveKey(passphrase, salt)
    const pt = new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, ct as BufferSource),
    )
    return dec.decode(pt)
  } catch {
    return null // GCM auth failure (wrong key / tamper) or malformed input — fail closed
  }
}
