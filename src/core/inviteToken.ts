import { b64urlToBytes, bytesToB64url } from './oidcVerify'

// Signed room invites — the migration-proof, link-safe credential option. The creator holds
// an ECDSA P-256 keypair; each guest gets a signed grant token; the invite LINK carries only
// the PUBLIC key, so ANY authority (even one that took over after the creator left) can verify
// a token WITHOUT the private key. A token is a bearer credential — whoever holds Alice's token
// joins as Alice, like a signed invite link — bound to the room + an expiry so it can't be
// replayed into another room or used forever. Unforgeable: minting one needs the private key,
// so a short-code brute force is a non-starter (you're forging ECDSA, not guessing 30 bits).

const enc = new TextEncoder()
const dec = new TextDecoder()
const ALG = { name: 'ECDSA', namedCurve: 'P-256' } as const
const SIGN_ALG = { name: 'ECDSA', hash: 'SHA-256' } as const

export interface InvitePayload {
  /** Who this invite is for — a label shown to the host on admit. */
  name: string
  /** The room id it's valid in (normalized). Binds the token: no cross-room replay. */
  room: string
  /** Expiry, epoch SECONDS. */
  exp: number
}

export interface InviteKeypair {
  privateKey: CryptoKey
  publicKey: CryptoKey
}

/** A fresh signing keypair for a room's invites (creator-side, extractable so it can be
 *  stored in the creator's browser to mint more invites later). */
export async function generateInviteKeypair(): Promise<InviteKeypair> {
  const kp = (await crypto.subtle.generateKey(ALG, true, ['sign', 'verify'])) as CryptoKeyPair
  return { privateKey: kp.privateKey, publicKey: kp.publicKey }
}

/** Export the PUBLIC key as a JWK to embed in the invite link (safe to publish). */
export function exportInvitePublicKey(pub: CryptoKey): Promise<JsonWebKey> {
  return crypto.subtle.exportKey('jwk', pub)
}
/** Export the PRIVATE key (creator's localStorage only — never the link). */
export function exportInvitePrivateKey(priv: CryptoKey): Promise<JsonWebKey> {
  return crypto.subtle.exportKey('jwk', priv)
}
export function importInvitePublicKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey('jwk', jwk, ALG, true, ['verify'])
}
export function importInvitePrivateKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey('jwk', jwk, ALG, true, ['sign'])
}

/** Sign an invite → a compact `payloadB64.sigB64` token the guest pastes. */
/** Sign any JSON payload → a compact `payloadB64.sigB64` token (the shared primitive behind
 *  invites and the room manifest). */
export async function signPayload(priv: CryptoKey, payload: object): Promise<string> {
  const body = bytesToB64url(enc.encode(JSON.stringify(payload)))
  const sig = new Uint8Array(await crypto.subtle.sign(SIGN_ALG, priv, enc.encode(body)))
  return `${body}.${bytesToB64url(sig)}`
}

/** Verify a `payloadB64.sigB64` token against a public key; returns the parsed payload if the
 *  signature is valid, else null. (Callers enforce any room/expiry/claim policy.) */
export async function verifyPayload<T>(token: string, pub: CryptoKey): Promise<T | null> {
  const dot = token.indexOf('.')
  if (dot < 1 || dot === token.length - 1) return null
  const body = token.slice(0, dot)
  let sig: Uint8Array
  let payload: T
  try {
    sig = b64urlToBytes(token.slice(dot + 1))
    payload = JSON.parse(dec.decode(b64urlToBytes(body))) as T
  } catch {
    return null
  }
  const valid = await crypto.subtle.verify(SIGN_ALG, pub, sig as BufferSource, enc.encode(body) as BufferSource)
  return valid ? payload : null
}

export function signInvite(priv: CryptoKey, payload: InvitePayload): Promise<string> {
  return signPayload(priv, payload)
}

/** Verify a pasted invite token against the room's public key: signature, room binding,
 *  and expiry. Returns the invitee name on success; a reason string on any failure. */
export async function verifyInvite(
  token: string,
  pub: CryptoKey,
  opts: { room: string; now: number },
): Promise<{ ok: true; name: string } | { ok: false; reason: string }> {
  const payload = await verifyPayload<InvitePayload>(token, pub)
  if (!payload) return { ok: false, reason: 'bad signature' }
  if (payload.room !== opts.room) return { ok: false, reason: 'wrong room' }
  if (typeof payload.exp !== 'number' || opts.now >= payload.exp) return { ok: false, reason: 'expired' }
  if (!payload.name) return { ok: false, reason: 'no name' }
  return { ok: true, name: payload.name }
}
