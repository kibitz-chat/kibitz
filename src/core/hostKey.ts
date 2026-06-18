// The room HOST's identity = an ECDSA P-256 keypair. The room LINK commits the host's PUBLIC key (gh)
// plus the PRIVATE key SEALED under a host password (ghk). To claim admin a peer enters the password →
// unseals the private key → signs a CERT-BOUND command ("I'm the host, on this connection, do <op>");
// whoever is the coordinator verifies it against the committed public key and enacts it. So admin is
// bound to the password — not to who holds the room id — and survives a coordinator migration (every
// peer has the committed public key from its own link). Reuses inviteToken.ts (the ECDSA
// payloadB64.sigB64 token) + gateSecret.ts (PBKDF2 / AES-GCM seal). Cert-bound + room-bound + fresh, so
// a captured command can't be replayed on another connection / room / later.
//
// HONEST LIMIT: the sealed private key rides the PUBLIC link, so a weak password is brute-forceable
// offline (PBKDF2 only slows it; there's no server to throttle) — use a passphrase.

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
import { encryptManifest, decryptManifest } from './gateSecret'

/** Wire tag so a host command can never be confused with another signed payload kind. */
const HOST_CMD_KIND = 'kbz-host-cmd.v1' as const

/** The discretionary moderation actions a host can command. `claim` just proves "I'm the host" (so the
 *  roster marks this peer as the host) with no side effect. */
export type HostOp = 'claim' | 'lobbyon' | 'lobbyoff' | 'admit' | 'deny' | 'lock' | 'unlock' | 'reset' | 'kick'
export const HOST_OPS: readonly HostOp[] = ['claim', 'lobbyon', 'lobbyoff', 'admit', 'deny', 'lock', 'unlock', 'reset', 'kick']

export type HostKeypair = InviteKeypair

export interface HostCommandPayload {
  k: typeof HOST_CMD_KIND
  /** Normalized room id — no cross-room replay. */
  room: string
  /** The host peer's OWN DTLS fingerprint (canonical) — the cert binding. */
  fp: string
  /** The moderation action. */
  op: HostOp
  /** Target member/connection id for admit/deny/kick (omitted for lock/unlock/reset/claim). */
  target?: string
  /** Issued-at, epoch SECONDS — freshness. */
  iat: number
}

/** A fresh host signing keypair (creator-side). The public half is committed in the link; the private
 *  half is sealed under the host password (also in the link). */
export function generateHostKeypair(): Promise<HostKeypair> {
  return generateInviteKeypair()
}
export const exportHostPublicKey = exportInvitePublicKey
export const exportHostPrivateKey = exportInvitePrivateKey
export const importHostPublicKey = importInvitePublicKey
export const importHostPrivateKey = importInvitePrivateKey

/** Seal the host PRIVATE key (a JWK) under the host password → a base64url blob for the link (`ghk`). */
export async function sealHostKey(privJwk: JsonWebKey, password: string): Promise<string> {
  return encryptManifest(JSON.stringify(privJwk), password)
}

/** Unseal the host private key with the password → an importable JWK, or null (wrong password / tamper). */
export async function unsealHostKey(blob: string, password: string): Promise<JsonWebKey | null> {
  const json = await decryptManifest(blob, password)
  if (!json) return null
  try {
    return JSON.parse(json) as JsonWebKey
  } catch {
    return null
  }
}

/** Host-side: sign a cert-bound moderation command. Re-sign per command (each carries a fresh iat). */
export function signHostCommand(
  priv: CryptoKey,
  args: { room: string; fp: string; op: HostOp; target?: string; now: number },
): Promise<string> {
  const payload: HostCommandPayload = {
    k: HOST_CMD_KIND,
    room: args.room,
    fp: canonicalFingerprint(args.fp),
    op: args.op,
    ...(args.target ? { target: args.target } : {}),
    iat: args.now,
  }
  return signPayload(priv, payload)
}

export interface HostVerifyArgs {
  /** The room's committed host PUBLIC key (from the link / signed manifest). */
  hostKey: JsonWebKey
  /** Expected (normalized) room id. */
  room: string
  /** The fingerprint we ACTUALLY handshook with on this connection. When provided, the command is
   *  cert-bound (it can't be replayed on a different connection). Omitted for a self-originated command
   *  (the coordinator IS the host, so there's no remote fp) — the signature alone proves key possession. */
  remoteFp?: string
  /** Now, epoch seconds. */
  now: number
  /** Freshness window (default 120s — short, since commands are live actions). */
  maxAgeSec?: number
  /** Clock-skew allowance for a future-dated iat (default 60s). */
  leewaySec?: number
}

/** Authority/peer-side: verify a host command against the committed host key. Succeeds only if the
 *  signature matches the host key AND the command is bound to THIS room and THIS live connection (fp)
 *  and is fresh. Returns the op + target on success. Fail-closed on every error path. */
export async function verifyHostCommand(
  token: string,
  args: HostVerifyArgs,
): Promise<{ ok: true; op: HostOp; target?: string } | { ok: false; reason: string }> {
  const maxAge = args.maxAgeSec ?? 120
  const leeway = args.leewaySec ?? 60
  if (!token) return { ok: false, reason: 'missing command' }
  if (!args.hostKey) return { ok: false, reason: 'no host key' }

  let pub: CryptoKey
  try {
    pub = await importHostPublicKey(args.hostKey)
  } catch {
    return { ok: false, reason: 'bad host key' }
  }
  const payload = await verifyPayload<HostCommandPayload>(token, pub)
  if (!payload) return { ok: false, reason: 'bad signature' }
  if (payload.k !== HOST_CMD_KIND) return { ok: false, reason: 'wrong command kind' }
  if (payload.room !== args.room) return { ok: false, reason: 'wrong room' }
  if (args.remoteFp && canonicalFingerprint(payload.fp) !== canonicalFingerprint(args.remoteFp))
    return { ok: false, reason: 'not cert-bound to this connection' }
  if (!HOST_OPS.includes(payload.op)) return { ok: false, reason: 'unknown op' }
  if (typeof payload.iat !== 'number') return { ok: false, reason: 'no iat' }
  if (payload.iat - args.now > leeway) return { ok: false, reason: 'command from the future' }
  if (args.now - payload.iat > maxAge) return { ok: false, reason: 'stale command' }
  return { ok: true, op: payload.op, target: typeof payload.target === 'string' ? payload.target : undefined }
}
