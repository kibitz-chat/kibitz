import { b64urlToBytes, bytesToB64url } from './oidcVerify'
import type { JoinGateMode } from './joinGate'

// The stateless gate descriptor carried IN THE LINK — no browser storage. The joiner reads
// it to know HOW to prove themselves; the authority reads it to know HOW to verify. ONLY
// non-secret material goes here: the mode, the invite signing PUBLIC key, the pickable name
// list, the OAuth client id. Secrets (an invite PRIVATE key used to mint tokens; short
// codes) live only in the creating tab's memory for the session and are never encoded.
//
// Params (kept short, namespaced `g*` so they don't collide with the room hash):
//   g  = mode            gk = invite public key (JWK, base64url-json)
//   gn = names (csv)      gc = google client id
//   gh = host public key (JWK, base64url-json)   ghk = host private key SEALED under the host password
//   ghn = SOFT host name (the creator's name; whoever presents it is the host — no crypto, spoofable)
//   gho = OIDC host email (the host proves this verified email via sign-in → un-spoofable; needs gc)
//   gl = "1" → the room starts with the waiting room ON (so the host gates entry from the first moment)

const enc = new TextEncoder()
const dec = new TextDecoder()

// ── Where the gate rides in the URL ───────────────────────────────────────────────────────────
// PRIVACY: the URL fragment (`#…`) is NEVER sent to the web host — so a verified-room link that
// carries its roster/credential in the FRAGMENT (after the room, delimited by `?`) keeps the
// allow-list off the network entirely. Legacy links put the same params in the QUERY string
// (`?…`), which the host receives; we still READ those (additive — bookmarks keep working), but
// new links are built fragment-form. Room codes never contain `?`, so the delimiter is unambiguous.
//
// COMPAT / DOWNGRADE: an OLD build (pre-fragment) reads gate params only from `location.search`, so
// it sees a new fragment-form link as having NO gate → treats the room as OPEN and does not enforce.
// Enforcing requires BOTH the authority and the joiner to be on a build that reads the fragment. On
// kibitz.chat this window is seconds-to-minutes (Cloudflare no-cache HTML + the stale-chunk
// self-reload in App.tsx); self-hosting embedders who control deploy timing should be aware. The
// room id is still unguessable, so the fallback is "open to whoever has the link," not "wide open."
// Beyond the gate descriptor keys, the DISPLAY-only params count too: `d` (room description),
// `ag` (agent-call type) and `n` (consent notice). So a plain open-room link carrying ONLY those
// (no real gate) is still read from the host-private fragment instead of falling back to the query.
const GATE_KEYS = ['g', 'gn', 'gk', 'gm', 'ge', 'gc', 'gt', 'gh', 'ghk', 'ghn', 'gho', 'gl', 'd', 'ag', 'n'] as const

/** Split a `location.hash` into the room code and any gate params carried after a `?` in the
 *  fragment. `#standup?g=google&gm=…` → { room:'standup', params:{g,gm} }. */
export function splitRoomHash(hash: string): { room: string; params: URLSearchParams } {
  const raw = hash.replace(/^#/, '')
  const q = raw.indexOf('?')
  if (q < 0) return { room: raw, params: new URLSearchParams() }
  return { room: raw.slice(0, q), params: new URLSearchParams(raw.slice(q + 1)) }
}

/** The gate params for this page: the FRAGMENT's (host-private) when it carries any gate key,
 *  else the legacy QUERY string. So a new fragment-form link never touches the host, and an old
 *  query-form link still resolves. */
export function gateParamsFrom(hash: string, search: string): URLSearchParams {
  const frag = splitRoomHash(hash).params
  if (GATE_KEYS.some((k) => frag.has(k))) return frag
  return new URLSearchParams(search)
}

/** Append gate params to a room URL's FRAGMENT (after the room), so they stay off the network.
 *  String-based (no URL-API re-encoding); `?` first, `&` to chain (e.g. a per-guest `gt`). */
export function withGateFragment(base: string, params: URLSearchParams): string {
  const qs = params.toString()
  if (!qs) return base
  const hashAt = base.indexOf('#')
  const sep = hashAt < 0 ? '#?' : base.indexOf('?', hashAt) >= 0 ? '&' : '?'
  return base + sep + qs
}

export interface GateDescriptor {
  mode: JoinGateMode
  /** `names` mode — the pickable allow-list (names aren't secret). */
  names?: string[]
  /** `invite` mode — the signing PUBLIC key (JWK). Safe to publish; verifies tokens (and the
   *  manifest, if any — the same creator key signs both). */
  pubKey?: JsonWebKey
  /** Verified-roster mode — the signed room manifest token (the committed allow-list). When
   *  present, a credential is admitted only if its identity is on this roster. Verified with
   *  `pubKey`. See docs/verification.md §7. */
  manifest?: string
  /** Layer 2 (privacy): the manifest SEALED under an out-of-band group passphrase (gateSecret).
   *  Present instead of `manifest` for a passphrase-protected room — a link-holder without the
   *  passphrase (and the host) sees only this ciphertext. `unlockGate` decrypts it back to
   *  `manifest`; until then the verified-roster flow has nothing to act on (stays inert). */
  encManifest?: string
  /** `google` mode — the OAuth client id (public). */
  clientId?: string
  /** Optional VERIFIED HOST (ANY mode, incl. open): the host's PUBLIC key (JWK). A peer that proves it
   *  holds the matching private key (unsealed from `hostKeySealed` with the host password) can drive the
   *  room's discretionary moderation; absent → the room has no admin. See core/hostKey.ts. */
  hostPubKey?: JsonWebKey
  /** The host PRIVATE key SEALED under the host password (a gateSecret blob). Rides the link so the host
   *  can claim admin on any device by entering the password; offline-attackable → use a passphrase. */
  hostKeySealed?: string
  /** SOFT host (the simpler tier): the creator's name. Whoever joins under it is treated as the host —
   *  no crypto, so any link-holder can claim it by using the name. Good for "I'm first in, wait for the
   *  agent, then admit everyone"; NOT a defense against a malicious guest (use `hostPubKey` for that).
   *  Mutually exclusive with `hostPubKey` in practice (the password tier takes precedence). */
  hostName?: string
  /** Start the room with the waiting room (lobby) ON, so the host gates entry from the first moment.
   *  Paired with `hostName` for the soft-host flow; the host can turn it off anytime. */
  lobbyOnStart?: boolean
  /** OIDC host (the strong, portable tier): the host's verified EMAIL. The host signs in (OIDC) and
   *  proves this exact email → the authority verifies it (cert-bound, peer-to-peer) and marks them host.
   *  Un-spoofable and works on any device (sign in anywhere), but needs `clientId` (the OAuth app). */
  hostEmail?: string
}

const isMode = (s: string | null): s is JoinGateMode =>
  s === 'open' || s === 'names' || s === 'code' || s === 'email' || s === 'google' || s === 'invite'

/** Encode a descriptor into URL params (to merge into the room link). `open` adds nothing. */
export function encodeGateParams(d: GateDescriptor): URLSearchParams {
  const p = new URLSearchParams()
  if (d.mode && d.mode !== 'open') p.set('g', d.mode)
  if (d.names?.length) p.set('gn', d.names.join(','))
  if (d.pubKey) p.set('gk', bytesToB64url(enc.encode(JSON.stringify(d.pubKey))))
  if (d.manifest) p.set('gm', d.manifest)
  if (d.encManifest) p.set('ge', d.encManifest)
  if (d.clientId) p.set('gc', d.clientId)
  if (d.hostPubKey) p.set('gh', bytesToB64url(enc.encode(JSON.stringify(d.hostPubKey))))
  if (d.hostKeySealed) p.set('ghk', d.hostKeySealed)
  if (d.hostName) p.set('ghn', d.hostName)
  if (d.hostEmail) p.set('gho', d.hostEmail)
  if (d.lobbyOnStart) p.set('gl', '1')
  return p
}

/** Decode a descriptor from URL params. Absent `g` → an open room. A corrupt key/list is
 *  dropped (best-effort) rather than throwing, so a mangled link still resolves to a mode. */
export function decodeGateParams(p: URLSearchParams): GateDescriptor {
  const g = p.get('g')
  const d: GateDescriptor = { mode: isMode(g) ? g : 'open' }
  // Host fields apply to ANY room (even open), so read them BEFORE the open-mode early return.
  const gh = p.get('gh')
  if (gh) {
    try {
      d.hostPubKey = JSON.parse(dec.decode(b64urlToBytes(gh))) as JsonWebKey
    } catch {
      /* corrupt host key — leave undefined; claiming admin will fail closed */
    }
  }
  const ghk = p.get('ghk')
  if (ghk) d.hostKeySealed = ghk
  const ghn = p.get('ghn')
  if (ghn) d.hostName = ghn
  const gho = p.get('gho')
  if (gho) d.hostEmail = gho
  if (p.get('gl') === '1') d.lobbyOnStart = true
  // The OAuth client id applies to ANY mode (an OPEN room with an OIDC host needs it to verify the
  // host's sign-in), so read it BEFORE the open-mode early return — not just for the verified modes.
  const gc = p.get('gc')
  if (gc) d.clientId = gc
  if (d.mode === 'open') return d
  const gn = p.get('gn')
  if (gn) d.names = gn.split(',').map((s) => s.trim()).filter(Boolean)
  const gk = p.get('gk')
  if (gk) {
    try {
      d.pubKey = JSON.parse(dec.decode(b64urlToBytes(gk))) as JsonWebKey
    } catch {
      /* corrupt key — leave undefined; the gate will fail closed */
    }
  }
  // `ge` (sealed) and `gm` (cleartext) are MUTUALLY EXCLUSIVE: a sealed link carries only ciphertext.
  // If a crafted link smuggles BOTH, the sealed one wins and the cleartext `gm` is ignored — so an
  // attacker can't slip a fake cleartext roster in beside a real sealed one (structural, not order-reliant).
  const ge = p.get('ge')
  const gm = p.get('gm')
  if (ge) d.encManifest = ge
  else if (gm) d.manifest = gm
  // (clientId / `gc` is read above, before the open-mode return, so it covers every mode.)
  return d
}
