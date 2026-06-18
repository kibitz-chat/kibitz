import { signPayload, verifyPayload } from './inviteToken'
import { matchesMemberHash } from './rosterHash'
import { verifyAgentAssertion } from './agentKey'
import { defaultGrant, sanitizeGrant, type Grant } from './capabilities'

// The ROOM MANIFEST — the "verified roster, no privileged host" mode (docs/verification.md §7).
// A creator publishes a signed, committed roster of allowed identities in the link; the
// creator's PUBLIC key rides the link too (the private key is then discarded). Any peer can
// confirm the manifest is authentic and check that every participant — THE HOST INCLUDED — is
// a listed member. Combined with mutual, pre-share verification, this removes admission trust
// in the authority: a malicious host can neither admit an off-manifest peer nor host without
// proving a listed identity. Signing reuses the ECDSA primitive behind signed invites.

/** How a single invitee proves they are who the roster says:
 *  - `signin` — OIDC sign-in pinned to a specific email (only that verified address gets in);
 *  - `oidc`   — OIDC sign-in for ANY verified account, optionally limited to a domain;
 *  - `mail`   — a code mailed to a specific address (needs a backend — display-only until it ships).
 *  Both `signin` and `oidc` use the same cert-bound, peer-to-peer OIDC verification. */
export type VerifyMethod = 'oidc' | 'signin' | 'mail'

/** One row of the published, pre-entry roster (docs/verification.md §7): how a person verifies,
 *  the parameter that gates them, and an optional name. Shown to a joiner BEFORE they enter; the
 *  gate matches on the manifest's `members` (emails) + `domains`, so this is the human-readable
 *  face of the committed roster. */
export interface Invitee {
  /** How this person proves they belong. */
  method: VerifyMethod
  /** The pinned email — for `signin`/`mail` (required), or an `oidc` row the creator chose to show. */
  id?: string
  /** Allowed email domain — for an `oidc` row: any verified address at this domain is admitted. */
  domain?: string
  /** Optional display name shown in the preview (the email/domain is shown only when `show`). */
  name?: string
  /** Reveal this row's email/domain in the visible preview (default: hidden). */
  show?: boolean
}

export interface RoomManifest {
  /** Exact allowed EMAILS the gate matches against (the `signin` invitees). Normalized
   *  (trimmed + lowercased). Only methods that can verify today contribute (see `invitees`).
   *  In the privacy mode the allow-list is committed as hashes in `mh` instead, and `members`
   *  carries only the addresses the creator chose to REVEAL (`show:true`) — or is empty. */
  members: string[]
  /** Privacy mode: the allow-list as room-bound `memberHash()` values instead of cleartext
   *  emails, so the link / host can't harvest the roster. Either `members` or `mh` (non-empty)
   *  satisfies "has an allow-list"; when `mh` is present the gate matches by hashing (see
   *  `memberAllowedAsync` + rosterHash). Additive: a legacy cleartext manifest just omits it. */
  mh?: string[]
  /** Allowed email DOMAINS (the `oidc` invitees): any verified address at one of these is in. */
  domains?: string[]
  /** Which gate the manifest governs (how a member proves they're who they claim). */
  mode: 'invite' | 'google' | 'names'
  /** The room id this manifest is valid in (binds it — no cross-room reuse). */
  room: string
  /** Expiry, epoch SECONDS. */
  exp: number
  /** Optional published roster for the pre-entry preview: each invitee's method + parameter
   *  (+ name). Signed with the rest of the manifest, so the preview is tamper-proof. */
  invitees?: Invitee[]
  /** Pre-authorized AI agents (anchor (a) "per-agent key"): each entry pins an agent's PUBLIC key
   *  plus the capability policy it gets on admission. Signed with the rest of the manifest (so the
   *  allow-list + the granted powers are tamper-proof + room-bound) and PUBLIC (safe in the link).
   *  An agent proves possession of the matching private key with a cert-bound assertion (agentKey.ts).
   *  Orthogonal to `mode` (which gates humans). Additive: absent ⇒ no agent is pre-authorized.
   *  This is also what makes AGENT-ONLY rooms work: a collaboration room grants `act` here; a
   *  human-hosted room leaves `caps` absent so the agent is perceive-only. */
  agentKeys?: AgentEntry[]
}

/** One pre-authorized agent on the manifest. */
export interface AgentEntry {
  /** The agent's PUBLIC key (ECDSA P-256 JWK) — its stable identity. */
  key: JsonWebKey
  /** What this agent may do once admitted. Absent ⇒ perceive-only (`defaultGrant('agent')`).
   *  An agent-collaboration room sets this to grant `act`/media. Clamped via `sanitizeGrant`. */
  caps?: Grant
  /** Optional human-readable label for display / audit (e.g. "notes-bot"). */
  label?: string
}

/** Admit an agent against a manifest's allow-list: verify its cert-bound assertion, then resolve
 *  the matched entry's capability policy (default perceive-only). The single bridge the room's
 *  gate calls — keeps agentKey.ts pure (keys only) and capability policy here with the manifest. */
export async function admitAgentByManifest(
  assertion: string,
  manifest: RoomManifest,
  ctx: { remoteFp: string; now: number; maxAgeSec?: number; leewaySec?: number },
): Promise<{ ok: true; keyId: string; caps: Grant; label?: string } | { ok: false; reason: string }> {
  const entries = manifest.agentKeys ?? []
  if (entries.length === 0) return { ok: false, reason: 'no agent keys' }
  const res = await verifyAgentAssertion(assertion, {
    allowedKeys: entries.map((e) => e.key),
    room: manifest.room,
    remoteFp: ctx.remoteFp,
    now: ctx.now,
    maxAgeSec: ctx.maxAgeSec,
    leewaySec: ctx.leewaySec,
  })
  if (!res.ok) return res
  const entry = entries.find((e) => e.key === res.key)
  // Default to perceive-only; clamp whatever the manifest granted so a malformed policy can't
  // confer an unknown capability.
  const caps = sanitizeGrant(entry?.caps ?? defaultGrant('agent'))
  return { ok: true, keyId: res.keyId, caps, label: entry?.label }
}

// NFKC first so visually/compatibility-equivalent identities canonicalize the same on both
// sides (a creator's roster entry and a peer's verified email), then case-fold + trim.
const norm = (s: string) => s.normalize('NFKC').trim().toLowerCase()

/** Sign a manifest with the creator's private key → a compact token for the link. */
export function signManifest(priv: CryptoKey, manifest: RoomManifest): Promise<string> {
  return signPayload(priv, manifest)
}

/** Verify a manifest token against the creator's public key (from the link): authentic
 *  signature, correct room, not expired, has a member list. */
export async function verifyManifest(
  token: string,
  pub: CryptoKey,
  opts: { room: string; now: number; mode?: RoomManifest['mode'] },
): Promise<{ ok: true; manifest: RoomManifest } | { ok: false; reason: string }> {
  const m = await verifyPayload<RoomManifest>(token, pub)
  if (!m) return { ok: false, reason: 'bad signature' }
  if (m.room !== opts.room) return { ok: false, reason: 'wrong room' }
  // Pin the gate mode when the caller expects one: a manifest is signed for ONE mode (how a
  // member proves themselves), so an invite-mode roster must never be accepted where a
  // google-mode (cert-bound peer-to-peer) roster is expected, even if both are signed by the
  // same creator key. Without this, the manifest's mode is advisory and modes could be crossed.
  if (opts.mode && m.mode !== opts.mode) return { ok: false, reason: 'wrong mode' }
  if (typeof m.exp !== 'number' || opts.now >= m.exp) return { ok: false, reason: 'expired' }
  // An allow-list is required, in SOME form — cleartext `members` (legacy/revealed), hashed `mh`
  // (privacy mode), OR an agent allow-list (`agentKeys`, for an agent-only / agents-gated room
  // where humans stay open). Domains alone aren't enough (a pinned membership must exist).
  const hasMembers = Array.isArray(m.members) && m.members.length > 0
  const hasHashed = Array.isArray(m.mh) && m.mh.length > 0
  const hasAgents = Array.isArray(m.agentKeys) && m.agentKeys.length > 0
  if (!hasMembers && !hasHashed && !hasAgents) return { ok: false, reason: 'no members' }
  return { ok: true, manifest: m }
}

/** Is `identity` (a verified name/email) on the manifest's CLEARTEXT list? Normalized, so
 *  case/space-insensitive. Legacy/sync path — for a hashed roster use `memberAllowedAsync`. */
export function memberAllowed(manifest: RoomManifest, identity: string | undefined): boolean {
  if (!identity) return false
  const id = norm(identity)
  return manifest.members.map(norm).includes(id)
}

/** Is `identity` on the manifest, handling BOTH the hashed allow-list (`mh`, privacy mode —
 *  matched by hashing the identity, room-bound) and the cleartext `members`. Async (WebCrypto).
 *  Prefer this everywhere the gate matches a verified email; it degrades to the cleartext path
 *  for a legacy manifest. A hashed manifest matches ONLY via `mh` (cleartext `members` there
 *  holds just the revealed rows, never the full list). */
export async function memberAllowedAsync(manifest: RoomManifest, identity: string | undefined): Promise<boolean> {
  if (!identity) return false
  if (manifest.mh?.length) return matchesMemberHash(manifest.mh, identity, manifest.room)
  return memberAllowed(manifest, identity)
}
