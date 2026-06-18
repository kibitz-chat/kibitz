// An AI agent's identity = an ECDSA P-256 keypair it holds. To enter a gated room the agent
// signs a CERT-BOUND assertion (over the room id + its own live DTLS fingerprint) with its
// private key; a room admits it when that signing key is on the room's allow-list (anchor (a)
// "per-agent key"). Free, serverless, asymmetric — the room only ever holds the PUBLIC key, so
// nothing secret rides the link. Cert-bound: the assertion names the agent's DTLS fingerprint,
// so a captured assertion can't be replayed on a different connection (its remote fingerprint
// won't match). Room-bound + freshness stop cross-room / stale replay. The signing primitive is
// shared with inviteToken.ts (the same ECDSA P-256 `payloadB64.sigB64` token).

import {
  generateInviteKeypair,
  exportInvitePublicKey,
  exportInvitePrivateKey,
  importInvitePublicKey,
  importInvitePrivateKey,
  signPayload,
  verifyPayload,
  type InviteKeypair,
} from './inviteToken'
import { canonicalFingerprint } from './oidcBinding'
import { bytesToB64url } from './oidcVerify'

const enc = new TextEncoder()

/** Wire tag so an agent assertion can never be confused with another signed payload kind. */
const ASSERTION_KIND = 'kbz-agent-key.v1' as const

export type AgentKeypair = InviteKeypair

export interface AgentAssertionPayload {
  k: typeof ASSERTION_KIND
  /** Normalized room id this assertion is valid in — no cross-room replay. */
  room: string
  /** The agent's OWN DTLS fingerprint (canonical) — the cert binding. */
  fp: string
  /** Issued-at, epoch SECONDS — freshness. */
  iat: number
}

/** A fresh agent signing keypair. The agent keeps the PRIVATE key; its PUBLIC key (or its
 *  thumbprint) is the stable identity a room allow-lists. */
export function generateAgentKeypair(): Promise<AgentKeypair> {
  return generateInviteKeypair()
}

/** Export the PUBLIC key as a JWK — safe to hand to a room operator to allow-list. */
export const exportAgentPublicKey = exportInvitePublicKey
/** Export the PRIVATE key as a JWK — the agent operator's secret (stored with the agent,
 *  never published). Re-imported via `importAgentPrivateKey` to sign assertions. */
export const exportAgentPrivateKey = exportInvitePrivateKey
/** Import an allow-listed agent PUBLIC key JWK for verification. */
export const importAgentPublicKey = importInvitePublicKey
/** Import the agent's own PRIVATE key JWK so it can sign cert-bound assertions. */
export const importAgentPrivateKey = importInvitePrivateKey

/** A stable, compact id for an agent public key: base64url SHA-256 over the canonical EC JWK
 *  members (RFC 7638-style — required members only, lexicographic order, no whitespace). Lets a
 *  human allow-list / display a short, stable key id independent of other JWK fields. */
export async function agentKeyThumbprint(pub: JsonWebKey): Promise<string> {
  const canon = JSON.stringify({ crv: pub.crv, kty: pub.kty, x: pub.x, y: pub.y })
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(canon)))
  return bytesToB64url(digest)
}

/** Agent-side: sign a cert-bound assertion — "I hold this key AND I'm the peer presenting DTLS
 *  fingerprint `fp`, joining `room`, at `now`". Re-sign per (re-)announce so it stays fresh. */
export function signAgentAssertion(priv: CryptoKey, args: { room: string; fp: string; now: number }): Promise<string> {
  const payload: AgentAssertionPayload = {
    k: ASSERTION_KIND,
    room: args.room,
    fp: canonicalFingerprint(args.fp),
    iat: args.now,
  }
  return signPayload(priv, payload)
}

export interface AgentVerifyArgs {
  /** The room's allow-list of agent PUBLIC keys (JWKs). */
  allowedKeys: readonly JsonWebKey[]
  /** Expected (normalized) room id. */
  room: string
  /** The fingerprint we ACTUALLY handshook with on this connection. */
  remoteFp: string
  /** Now, epoch seconds. */
  now: number
  /** Freshness window (default 300s). */
  maxAgeSec?: number
  /** Clock-skew allowance for a future-dated iat (default 60s). */
  leewaySec?: number
}

/** Authority/peer-side: verify an agent assertion against the room's allow-list. Succeeds only
 *  if the signature matches an allow-listed key AND the assertion is bound to THIS room and THIS
 *  live connection (fp) and is fresh. Returns the matched key's thumbprint so callers can label
 *  and grant per agent. Fail-closed on every error path. */
export async function verifyAgentAssertion(
  assertion: string,
  args: AgentVerifyArgs,
): Promise<{ ok: true; keyId: string; key: JsonWebKey } | { ok: false; reason: string }> {
  const maxAge = args.maxAgeSec ?? 300
  const leeway = args.leewaySec ?? 60
  if (!assertion || !args.remoteFp) return { ok: false, reason: 'missing assertion or fingerprint' }
  if (!args.allowedKeys || args.allowedKeys.length === 0) return { ok: false, reason: 'no allowed keys' }

  for (const jwk of args.allowedKeys) {
    let pub: CryptoKey
    try {
      pub = await importAgentPublicKey(jwk)
    } catch {
      continue // a malformed allow-list entry mustn't sink the whole check
    }
    const payload = await verifyPayload<AgentAssertionPayload>(assertion, pub)
    if (!payload) continue // signature didn't match THIS key — try the next one

    // Signature matched this key → this genuinely IS that agent. Enforce the claims (hard-fail
    // now; a wrong claim from the right key is a rejection, not a reason to keep looking).
    if (payload.k !== ASSERTION_KIND) return { ok: false, reason: 'wrong assertion kind' }
    if (payload.room !== args.room) return { ok: false, reason: 'wrong room' }
    if (canonicalFingerprint(payload.fp) !== canonicalFingerprint(args.remoteFp))
      return { ok: false, reason: 'not cert-bound to this connection' }
    if (typeof payload.iat !== 'number') return { ok: false, reason: 'no iat' }
    if (payload.iat - args.now > leeway) return { ok: false, reason: 'assertion from the future' }
    if (args.now - payload.iat > maxAge) return { ok: false, reason: 'stale assertion' }
    // Return the matched key so the caller can find its allow-list ENTRY (and apply its caps)
    // by reference — the `jwk` here is the same object the caller passed in `allowedKeys`.
    return { ok: true, keyId: await agentKeyThumbprint(jwk), key: jwk }
  }
  return { ok: false, reason: 'no matching allowed key' }
}
