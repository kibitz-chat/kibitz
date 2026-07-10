/**
 * Room-grant: the SAFE "opener pays". A sponsor (license holder) mints a
 * short-lived, room-scoped, server-SIGNED grant (POST /api/room-grant), shares it
 * in the invite link (`?grant=`), and joiners present it to /api/turn as the
 * `X-Kibitz-Grant` header → premium TURN metered to the sponsor, with no open
 * relay and the sponsor's key never leaving their browser.
 *
 * This replaces the unsafe `?turn=host` link (which pointed joiners at an
 * unauthenticated endpoint = open-relay-or-broken). The grant rides the LINK so a
 * joiner that needs relay to connect at all has it BEFORE gathering ICE — same
 * reason `?galaxy=`/`?turn=` do, but now it's a verifiable, time-boxed token.
 *
 * The grant is held for the session (sessionStorage) so it survives a reload, and
 * stripped from the address bar after it's read (a credential shouldn't linger in
 * the URL / history / a re-shared link).
 */
import { fetchWithTimeout } from './fetchTimeout'

const STORAGE_KEY = 'kbz_grant'
let grant: string | null = null
let loaded = false

function load(): void {
  if (loaded) return
  loaded = true
  try {
    grant = sessionStorage.getItem(STORAGE_KEY)
  } catch {
    /* storage unavailable — grant just stays in memory */
  }
}

export function setGrant(token: string | null): void {
  grant = token && token.trim() ? token.trim() : null
  loaded = true
  try {
    if (grant) sessionStorage.setItem(STORAGE_KEY, grant)
    else sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    /* storage unavailable */
  }
}

/** The current room-grant token to send to /api/turn, or null. */
export function getGrant(): string | null {
  load()
  return grant
}

/** Pure: read a grant from a link's `?grant=` param, or null. */
export function grantFromUrl(href: string): string | null {
  try {
    const v = new URL(href).searchParams.get('grant')
    return v && v.trim() ? v.trim() : null
  } catch {
    return null
  }
}

/** Pure: return `href` with `?grant=<token>` set, or stripped when blank. */
export function linkWithGrant(href: string, token: string | null | undefined): string {
  try {
    const url = new URL(href)
    if (token && token.trim()) url.searchParams.set('grant', token.trim())
    else url.searchParams.delete('grant')
    return url.toString()
  } catch {
    return href
  }
}

/**
 * Sponsor side: mint a fresh grant for `room`, authenticated by the sponsor's
 * license key. Returns the token + unix-seconds expiry, or null if not
 * entitled / the endpoint is dormant / offline. Bounded so a stall can't hang
 * the Copy-link button. `base` lets an off-origin caller (the extension on a
 * chrome-extension:// page) point at kibitz.chat's endpoint; default is same-origin.
 */
export async function requestRoomGrant(
  room: string,
  licenseKey: string,
  base = '',
): Promise<{ grant: string; exp: number } | null> {
  try {
    const res = await fetchWithTimeout(
      `${base}/api/room-grant`,
      {
        method: 'POST',
        credentials: 'omit',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${licenseKey}` },
        body: JSON.stringify({ room }),
      },
      5000,
    )
    if (!res.ok) return null
    const data = (await res.json()) as { grant?: string; exp?: number }
    return data.grant && data.exp ? { grant: data.grant, exp: data.exp } : null
  } catch {
    return null
  }
}
