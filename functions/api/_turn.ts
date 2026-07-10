/**
 * Shared helpers for the TURN abuse-control set (Cloudflare-only) — imported by
 * api/turn.ts, api/room-grant.ts, api/revoke.ts. The leading underscore keeps
 * Cloudflare Pages from routing this file; it's bundled into the importers.
 *
 * Everything here is pure WebCrypto + KV, no SDKs. None of it changes behaviour
 * until the ENTITLEMENTS KV namespace (and the relevant config) is bound — see
 * functions/README.md.
 */

export interface KV {
  get(key: string, type?: 'json' | 'text'): Promise<unknown>
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>
  delete(key: string): Promise<void>
}

const enc = new TextEncoder()
const dec = new TextDecoder()

/** Constant-time string compare. Folds the length difference into the accumulator (no early
 *  return) so it doesn't leak the expected length either. Exported for the admin-secret check in
 *  api/revoke.ts. */
export function timingSafeEqual(a: string, b: string): boolean {
  let out = a.length ^ b.length
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ (b.charCodeAt(i) | 0)
  return out === 0
}

function b64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64urlDecode(str: string): Uint8Array {
  const s = str.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function hmac(secret: string, msg: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(msg)))
}

/** A short, non-reversible tag for a license key — used as the metering subject
 *  and the credential's customIdentifier, so neither KV keys nor Cloudflare's
 *  analytics ever hold the raw key. */
export async function tagOf(licenseKey: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(licenseKey))
  return b64url(new Uint8Array(d)).slice(0, 16)
}

/** Sign a compact, stateless grant: `<b64url(json)>.<b64url(hmac)>`. */
export async function signGrant(secret: string, payload: Record<string, unknown>): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(payload)))
  return `${body}.${b64url(await hmac(secret, body))}`
}

/** Verify a grant's signature + `exp` (unix seconds). Returns the payload or null. */
export async function verifyGrant<T extends { exp?: number }>(secret: string, token: string): Promise<T | null> {
  const dot = token.lastIndexOf('.')
  if (dot <= 0) return null
  const body = token.slice(0, dot)
  if (!timingSafeEqual(token.slice(dot + 1), b64url(await hmac(secret, body)))) return null
  try {
    const obj = JSON.parse(dec.decode(b64urlDecode(body))) as T
    if (obj.exp && Date.now() / 1000 > obj.exp) return null
    return obj
  } catch {
    return null
  }
}

/** UTC `YYYY-MM` — the metering period. */
export function periodKey(): string {
  const d = new Date()
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

const COUNTER_TTL = 60 * 60 * 24 * 62 // ~2 months, so a period's counter self-expires

export async function peek(kv: KV, key: string): Promise<number> {
  return Number(((await kv.get(key, 'text')) as string | null) ?? '0')
}

/** Best-effort monthly increment. KV isn't atomic, so a burst can slip a few past
 *  the cap — fine for a backstop (the cap bounds cost), not exact billing. */
export async function bump(kv: KV, key: string, add = 1): Promise<void> {
  await kv.put(key, String((await peek(kv, key)) + add), { expirationTtl: COUNTER_TTL })
}

export function intEnv(v: string | undefined, fallback: number): number {
  const n = Number(v)
  return v != null && Number.isFinite(n) ? n : fallback
}
