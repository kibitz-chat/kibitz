import { nameAllowed } from './joinGate'
import { encodeGateParams, withGateFragment, type GateDescriptor } from './joinGateLink'
import { decryptManifest, encryptManifest } from './gateSecret'
import {
  exportInvitePublicKey,
  generateInviteKeypair,
  importInvitePublicKey,
  signInvite,
  verifyInvite,
} from './inviteToken'
import { memberAllowed, signManifest, verifyManifest, type AgentEntry, type Invitee, type RoomManifest, type VerifyMethod } from './roomManifest'

// The stateless glue for the "link is everything" gate: build the authority's verify()
// purely from the link descriptor (no stored secret), and — at creation — mint per-guest
// invites + their links, then drop the signing key. Nothing here persists anything.

export type GateVerify = (cred: string | undefined, remoteFp: string | null) => Promise<{ ok: boolean; reason?: string }>

/**
 * Build the authority's verify() from a descriptor read off the link. Everything it needs
 * is in `d`, so any peer that holds the link can enforce the gate with zero local state.
 * `nowSec` is injected for deterministic tests. Modes not yet implemented (code/email/google)
 * fall through to the existing paths / open.
 */
export async function gateVerifierFor(
  d: GateDescriptor,
  room: string,
  nowSec: () => number = () => Math.floor(Date.now() / 1000),
): Promise<GateVerify> {
  if (d.mode === 'names') {
    const names = d.names ?? []
    return async (cred) => (nameAllowed(cred ?? '', names) ? { ok: true } : { ok: false, reason: 'name not on the list' })
  }
  if (d.mode === 'invite') {
    if (!d.pubKey) return async () => ({ ok: false, reason: 'invite key missing from link' })
    const pub = await importInvitePublicKey(d.pubKey)
    // Verified-roster: if the link carries a manifest, verify it ONCE (same creator key) and
    // then admit a credential only if its identity is on the committed roster. A bad/expired
    // manifest fails closed — no one gets in. This same verifier is what each PEER runs for
    // the mutual, host-included check (docs/verification.md §7).
    let roster: RoomManifest | null = null
    if (d.manifest) {
      // This is the INVITE branch, so the manifest must be an invite-mode roster — pin it so a
      // google-mode (or other) manifest can't be crossed in here.
      const mv = await verifyManifest(d.manifest, pub, { room, now: nowSec(), mode: 'invite' })
      if (!mv.ok) return async () => ({ ok: false, reason: `manifest ${mv.reason}` })
      roster = mv.manifest
      // Agent-only manifest — agentKeys committed but NO human members/domains — means there is NO human
      // gate: humans join OPEN, and the agent is admitted separately by its own cert-bound key (withAgentGate
      // in Widget.tsx; agentKeys are orthogonal to the human gate, per roomManifest.ts). Honor that here, or
      // mode:'invite' would demand a per-guest token (gt) that an agent-room link never carries → every human
      // is denied → they never roster each other (the agent-room "split roster" bug).
      if (!roster.members?.length && !roster.domains?.length && roster.agentKeys?.length) {
        return async () => ({ ok: true })
      }
    }
    return async (cred) => {
      if (!cred) return { ok: false, reason: 'no invite presented' }
      const r = await verifyInvite(cred, pub, { room, now: nowSec() })
      if (!r.ok) return { ok: false, reason: r.reason }
      if (roster && !memberAllowed(roster, r.name)) return { ok: false, reason: 'not on the room roster' }
      return { ok: true }
    }
  }
  // open / not-yet-wired → no gate here
  return async () => ({ ok: true })
}

/** Merge gate params into a room URL that already carries the room in its hash — into the
 *  FRAGMENT (host-private), so the roster/credential never reaches the web host. See
 *  withGateFragment / gateParamsFrom in joinGateLink. */
function withParams(base: string, params: URLSearchParams): string {
  return withGateFragment(base, params)
}

/** Layer 2 (privacy): open a passphrase-sealed descriptor. If it carries an `encManifest`
 *  (a room protected by an out-of-band group secret), decrypt it with `passphrase` → a descriptor
 *  with the plaintext `manifest` set, ready for the normal verified-roster flow; or null on a
 *  wrong passphrase / tampered blob. A descriptor with no `encManifest` is returned unchanged
 *  (nothing to unlock). The decrypted manifest is STILL verified (signature, room, expiry) downstream
 *  — the passphrase only gates READING the roster, it doesn't replace the cryptographic gate. */
export async function unlockGate(d: GateDescriptor, passphrase: string): Promise<GateDescriptor | null> {
  if (!d.encManifest) return d
  const manifest = await decryptManifest(d.encManifest, passphrase)
  if (!manifest) return null
  return { ...d, manifest, encManifest: undefined }
}

export interface GuestInvite {
  name: string
  /** That guest's personal link: the room link PLUS their signed token (`gt`). */
  link: string
}
export interface InviteBundle {
  /** The room link carrying just the public key — anyone uses it to VERIFY (the authority). */
  roomLink: string
  /** One personal invite link per guest, to send out. */
  guests: GuestInvite[]
}

/**
 * Creation step: mint one signed token per guest and build their personal links (room link
 * + their token). The signing key is generated, used here, and then goes out of scope —
 * NOTHING is stored or kept. `base` is the room URL without gate params (e.g.
 * `https://host/#standup`); `expSec` is the absolute epoch-seconds expiry.
 */
export async function buildInviteBundle(
  base: string,
  room: string,
  names: readonly string[],
  expSec: number,
): Promise<InviteBundle> {
  const kp = await generateInviteKeypair()
  const pubKey = await exportInvitePublicKey(kp.publicKey)
  const roomParams = encodeGateParams({ mode: 'invite', pubKey })
  const roomLink = withParams(base, roomParams)
  const guests: GuestInvite[] = []
  for (const name of names) {
    const clean = name.trim()
    if (!clean) continue
    const token = await signInvite(kp.privateKey, { name: clean, room, exp: expSec })
    const p = new URLSearchParams(roomParams)
    p.set('gt', token)
    guests.push({ name: clean, link: withParams(base, p) })
  }
  return { roomLink, guests }
  // kp.privateKey is now unreachable — discarded. The link (pubKey) is everything.
}

/**
 * Creation step for the VERIFIED-ROSTER mode (docs/verification.md §7): like buildInviteBundle,
 * but the room link also carries a **signed manifest** of the members, so every peer (the host
 * included) can be checked against the committed roster — not just trusted from the authority.
 * The same keypair signs the manifest and each guest's token, then is discarded. Each `members`
 * entry gets a personal link; any of them can be the host (first-come) once verified.
 */
export async function buildVerifiedRoom(
  base: string,
  room: string,
  members: readonly string[],
  expSec: number,
): Promise<InviteBundle> {
  const kp = await generateInviteKeypair()
  const pubKey = await exportInvitePublicKey(kp.publicKey)
  const clean = members.map((m) => m.trim()).filter(Boolean)
  const manifest = await signManifest(kp.privateKey, { members: clean, mode: 'invite', room, exp: expSec })
  const roomParams = encodeGateParams({ mode: 'invite', pubKey, manifest })
  const roomLink = withParams(base, roomParams)
  const guests: GuestInvite[] = []
  for (const name of clean) {
    const token = await signInvite(kp.privateKey, { name, room, exp: expSec })
    const p = new URLSearchParams(roomParams)
    p.set('gt', token)
    guests.push({ name, link: withParams(base, p) })
  }
  return { roomLink, guests }
  // kp.privateKey discarded. The link carries the verifier (pubKey) + the committed roster.
}

/**
 * Creation step for a VERIFIED-ROSTER room in the cert-bound `google` mode (docs §7): the
 * link commits a signed roster of allowed EMAILS, and every member proves a listed identity
 * by signing in with Google (cert-bound, peer-to-peer) — so there are no per-guest tokens to
 * mint or distribute, just the one shareable room link. The creator's key signs the manifest
 * and its public key rides the link (`gk`) to verify it; the private key is then discarded.
 * `clientId` is the embedder's OAuth client_id (the same one passed as `verifyIdentity`).
 * Returns only the room link — every member opens the SAME link.
 */
export async function buildVerifiedGoogleRoom(
  base: string,
  room: string,
  emails: readonly string[],
  clientId: string,
  expSec: number,
): Promise<{ roomLink: string }> {
  const kp = await generateInviteKeypair()
  const pubKey = await exportInvitePublicKey(kp.publicKey)
  const members = emails.map((e) => e.trim().toLowerCase()).filter(Boolean)
  const manifest = await signManifest(kp.privateKey, { members, mode: 'google', room, exp: expSec })
  const roomParams = encodeGateParams({ mode: 'google', clientId, pubKey, manifest })
  return { roomLink: withParams(base, roomParams) }
  // kp.privateKey discarded. The link carries: the gate mode (google), the OAuth client_id,
  // the creator pubkey (verifies the manifest), and the signed, committed roster of emails.
}

/** One invitee as the creator types it: how they verify + the parameter that gates them. */
export interface InviteeInput {
  method?: VerifyMethod
  /** Pinned email — for `signin`/`mail`. */
  email?: string
  /** Allowed domain — for `oidc`. */
  domain?: string
  name?: string
  /** Show this row's email/domain in the visible preview (default false). */
  show?: boolean
}

const lc = (s?: string) => (s ?? '').trim().toLowerCase()

/**
 * Creation step for a VERIFIED-ROSTER room with a PER-INVITEE method + a published preview
 * (docs/verification.md §7). Each invitee carries its own method; the signed manifest commits the
 * gate's match lists — `members` (exact emails from `signin` rows) and `domains` (from `oidc`
 * rows, any verified address at that domain) — plus an `invitees` roster so a joiner can be shown
 * WHO is invited and HOW, BEFORE entering. `mail` invitees ride the published roster for display
 * but can't be admitted until the mailed-code backend ships (no email/domain contribution). The
 * creator key signs the whole manifest then is discarded.
 */
export async function buildVerifiedRoster(
  base: string,
  room: string,
  invitees: readonly InviteeInput[],
  clientId: string,
  expSec: number,
  /** Layer 2: when set, the signed manifest is SEALED under this out-of-band group passphrase and
   *  rides the link as `ge` (ciphertext) instead of cleartext `gm` — so a link-holder without the
   *  passphrase, and the host, can't read the roster. Joiners enter the passphrase (unlockGate). */
  passphrase?: string,
  /** Pre-authorized AI agents (anchor (a)): their public keys (+ optional caps/label) committed
   *  into the signed manifest. An agent with the matching private key enters by a cert-bound
   *  assertion, read-only by default. Absent ⇒ the room pre-authorizes no agents. */
  agentKeys?: readonly AgentEntry[],
): Promise<{ roomLink: string }> {
  const kp = await generateInviteKeypair()
  const pubKey = await exportInvitePublicKey(kp.publicKey)
  const clean = invitees
    .map((i) => ({
      method: (i.method ?? 'signin') as VerifyMethod,
      email: lc(i.email),
      domain: lc(i.domain).replace(/^@/, ''),
      name: i.name?.trim() || undefined,
      show: !!i.show,
    }))
    // keep only rows that carry the parameter their method needs
    .filter((i) => (i.method === 'oidc' ? true : !!i.email))
  // Admission lists: exact emails (signin via Google, OR mail via the email-code backend) and
  // allowed domains (oidc). Both signin and mail gate on the exact verified email — they differ
  // only in which provider proves it — so both contribute their email to `members`.
  const members = clean.filter((i) => (i.method === 'signin' || i.method === 'mail') && i.email).map((i) => i.email)
  const domains = [...new Set(clean.filter((i) => i.method === 'oidc' && i.domain).map((i) => i.domain))]
  const roster: Invitee[] = clean.map((i) => ({
    method: i.method,
    ...(i.method !== 'oidc' && i.email ? { id: i.email } : i.method === 'oidc' && i.show && i.email ? { id: i.email } : {}),
    ...(i.method === 'oidc' && i.domain ? { domain: i.domain } : {}),
    ...(i.name ? { name: i.name } : {}),
    ...(i.show ? { show: true } : {}),
  }))
  const manifest = await signManifest(kp.privateKey, {
    members,
    ...(domains.length ? { domains } : {}),
    mode: 'google',
    room,
    exp: expSec,
    invitees: roster,
    ...(agentKeys && agentKeys.length ? { agentKeys: [...agentKeys] } : {}),
  })
  // Passphrase-protected room: seal the signed manifest and carry only ciphertext (`ge`).
  const sealed = passphrase ? { encManifest: await encryptManifest(manifest, passphrase) } : { manifest }
  const roomParams = encodeGateParams({ mode: 'google', clientId, pubKey, ...sealed })
  return { roomLink: withParams(base, roomParams) }
  // kp.privateKey discarded. The link carries the gate (google), client id, creator pubkey, and
  // the signed roster (matchable members + domains + the previewable per-invitee method list).
}
