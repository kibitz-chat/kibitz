// Platform-blind agent memory (kibitz docs/encrypted-memory.md). The room key `mk` lives in the room-link
// FRAGMENT (client-only — fragments are never sent to any server), and is delivered to the agent over the call's
// E2EE channel. The creator also includes a COMMITMENT to `mk` in the summon, so the agent can reject a forged key
// (anti-poisoning) without the server ever seeing `mk`. Generic + inert for any room without an `mk` (e.g. all of
// kibitz.chat): no `mk` ⇒ these are no-ops.
import { splitRoomHash } from './joinGateLink'

/** The room key from the room-link FRAGMENT (`#room?…&mk=…`), or '' if none. Fragment-only by design — `mk` must
 *  never ride the query string (which a server would see). Read client-side only. */
export function roomKeyFromHash(hash: string = typeof location !== 'undefined' ? location.hash : ''): string {
  try {
    return splitRoomHash(hash).params.get('mk') || ''
  } catch {
    return ''
  }
}

const toB64url = (bytes: Uint8Array): string => {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Commitment to the room key: base64url(SHA-256(mk-string)). MUST match the agent's `envelope.commit()` byte for
 *  byte (same string → same SHA-256 → same base64url, no padding). The server sees only this hash, never `mk`. */
export async function memCommit(mk: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(mk))
  return toB64url(new Uint8Array(digest))
}

/** True if a roster participant is an AI agent (so the creator delivers `mk` to it). */
export function isAgentParticipant(p: { isSelf?: boolean; meta?: Record<string, unknown> }): boolean {
  return !p.isSelf && (p.meta?.kind === 'voice-assistant' || p.meta?.role === 'agent')
}

// ── Room CONTROL secrets (the "summoner" model, docs/encrypted-memory.md) ──────────────────────────────────────
// A room link can carry control secrets that grant power over the room: `sk` (summon key — re-summon the agent),
// `mk` (memory key — read/seal session memory), and `st` (a summoner token for rooms with no `mk`, so the agent
// can still tell who the summoner is). These live in the CREATOR's "control link" and must be STRIPPED from the
// invite shared with others — otherwise every invitee could summon (and read memory). Whoever holds the control
// link is the summoner; that's the bearer model kibitz already uses for gate keys. Keep this list in sync with the
// kibitz wizard (web/store.js) that mints them.
export const CONTROL_SECRET_KEYS = ['sk', 'mk', 'st'] as const

/** True if a query/fragment param key is a room control secret (never shared in an invite). */
export const isControlSecret = (k: string): boolean => (CONTROL_SECRET_KEYS as readonly string[]).includes(k)

/** A copy of `params` with every control secret removed — i.e. the join-only invite's params. */
export function stripControlSecrets(params: URLSearchParams): URLSearchParams {
  const out = new URLSearchParams()
  for (const [k, v] of params) if (!isControlSecret(k)) out.set(k, v)
  return out
}

/** Strip control secrets from a full room URL — BOTH the query and the room fragment (`#room?…`). Used to make a
 *  shareable invite from a link that may carry `sk`/`mk`. Returns the input unchanged if it can't be parsed. */
export function stripControlSecretsFromUrl(url: string): string {
  try {
    const u = new URL(url)
    const q = stripControlSecrets(u.searchParams).toString()
    u.search = q ? `?${q}` : ''
    if (u.hash) {
      const { room, params } = splitRoomHash(u.hash)
      const fp = stripControlSecrets(params).toString()
      u.hash = fp ? `#${room}?${fp}` : room ? `#${room}` : ''
    }
    return u.toString()
  } catch {
    return url
  }
}

/** The summon key for this page: the FRAGMENT's (control-link form, client-only) first, else the legacy QUERY
 *  (`?sk=`). Only the summoner — who holds the control link — has it; stripped invites don't. '' if none. */
export function summonKeyFromLink(hash: string = typeof location !== 'undefined' ? location.hash : '', search: string = typeof location !== 'undefined' ? location.search : ''): string {
  try {
    return splitRoomHash(hash).params.get('sk') || new URLSearchParams(search).get('sk') || ''
  } catch {
    return ''
  }
}

// ── Summoner key persistence (per-room, on the summoner's device) ────────────────────────────────────────────
// `summonKeyFromLink` reads `sk` from the URL, but leaving a room runs `location.hash = ''` (App.tsx goHome),
// which wipes the fragment — and the `sk` with it. So leave→re-enter would lose the summon button even for the
// room's OWN summoner. Persist the key LOCALLY, keyed by room, and fall back to it when the URL carries none.
// Same bearer model + exposure the URL/history already had; scoped to ONE room; never synced or shared — only
// the summoner's own device holds it, so it does not widen who can summon.
const SUMMON_KEY_PREFIX = 'kbz.sk:'
function summonStore(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null
  } catch {
    return null // storage disabled (private mode / blocked)
  }
}
export function stashSummonKey(roomId: string, sk: string): void {
  if (!roomId || !sk) return
  try {
    summonStore()?.setItem(SUMMON_KEY_PREFIX + roomId, sk)
  } catch {
    /* quota / blocked — non-fatal; the URL still works for this session */
  }
}
export function storedSummonKey(roomId: string): string {
  if (!roomId) return ''
  try {
    return summonStore()?.getItem(SUMMON_KEY_PREFIX + roomId) || ''
  } catch {
    return ''
  }
}
/** The summon key for a room: the URL (control link) first — and when present, PERSIST it for this room — else
 *  the per-room stash from a prior visit. So the summoner keeps the button across leave→re-enter. '' if neither. */
export function summonKeyForRoom(roomId: string, hash?: string, search?: string): string {
  const fromUrl = summonKeyFromLink(hash, search)
  if (fromUrl) {
    stashSummonKey(roomId, fromUrl)
    return fromUrl
  }
  return storedSummonKey(roomId)
}
