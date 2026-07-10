/**
 * ICE servers for ONLINE calls (the "robust internet relay").
 *
 * Fetches short-lived TURN+STUN credentials from a `/api/turn` Cloudflare Pages
 * Function so peers behind strict/symmetric NATs can relay their media instead
 * of failing to connect. The long-term TURN key never reaches the browser —
 * only ephemeral credentials do.
 *
 * The endpoint is same-origin by default but can be pointed at an INDEPENDENT
 * TURN + billing provider via the `turnHost` mount option (see turnConfig) —
 * the twin of signalHost.
 *
 * Falls back to public STUN if TURN isn't configured yet (no secrets) or the
 * fetch fails, so a call is NEVER worse than today's direct-P2P + STUN. Cached
 * in-memory for the session (the credentials are valid for hours).
 *
 * The offline/LAN path does NOT use this — it runs `iceServers: []` (see
 * lanMesh.ts), since media there is same-subnet direct.
 */
import { fetchWithTimeout } from './fetchTimeout'
import { getLicenseKey } from './license'
import { getGrant } from './grant'
import { getTurnEndpoint } from './turnConfig'

// Public STUN keeps NAT discovery working when TURN is unavailable.
const STUN_FALLBACK: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }]

// Persisted TURN credentials, so a STALLED /api/turn fetch (the classic after-a-network-change / reload-on-cellular
// case) reuses creds we already have instead of collapsing to a host-only (uncon­nectable) config. TURN creds are
// valid for hours, so a recent set still connects; the reuse window is well under that so we never hand out a stale
// one. This is the ICE twin of signalConfig's "remember the broker, never fall through to public".
const PERSIST_KEY = 'kbz.iceServers'
const PERSIST_TTL_MS = 30 * 60 * 1000 // 30 min — recent enough to still be valid, short enough to never be stale
const hasTurn = (servers: RTCIceServer[]): boolean => servers.some((s) => /turn:/i.test([s.urls].flat().join(' ')))
function persistIce(servers: RTCIceServer[]): void {
  try {
    if (hasTurn(servers)) localStorage.setItem(PERSIST_KEY, JSON.stringify({ at: Date.now(), servers }))
  } catch {
    /* ignore */
  }
}
function freshPersistedIce(): RTCIceServer[] | null {
  try {
    const raw = localStorage.getItem(PERSIST_KEY)
    if (!raw) return null
    const { at, servers } = JSON.parse(raw) as { at: number; servers: RTCIceServer[] }
    if (typeof at === 'number' && Date.now() - at < PERSIST_TTL_MS && Array.isArray(servers) && servers.length)
      return servers
  } catch {
    /* ignore */
  }
  return null
}

let cached: RTCIceServer[] | null = null
let inflight: Promise<RTCIceServer[]> | null = null

async function load(): Promise<{ servers: RTCIceServer[]; ok: boolean }> {
  try {
    // Premium auth (both optional; gating is server-side, none → free STUN tier):
    //  • license key  — your own premium (Authorization: Bearer)
    //  • room grant   — sponsored by the room opener ("opener pays"; X-Kibitz-Grant)
    const key = getLicenseKey()
    const grant = getGrant()
    const headers: Record<string, string> = {}
    if (key) headers.authorization = `Bearer ${key}`
    if (grant) headers['x-kibitz-grant'] = grant
    // Bounded: a stalled fetch must not leave the Join button disabled forever on
    // a slow cellular link — time out and fall back to STUN.
    const res = await fetchWithTimeout(
      getTurnEndpoint(),
      { credentials: 'omit', headers: Object.keys(headers).length ? headers : undefined },
      5000, // a touch longer than the default — this is the fetch we WANT to win (TURN on cellular)
    )
    if (res.ok) {
      const data = (await res.json()) as { iceServers?: RTCIceServer[] | null }
      if (Array.isArray(data.iceServers) && data.iceServers.length) {
        persistIce(data.iceServers) // remember real TURN creds, so a later STALLED fetch can reuse them
        return { servers: data.iceServers, ok: true }
      }
      // A 200 with no usable iceServers is a DEFINITIVE "no TURN configured here" (self-host / TURN switched off) —
      // cache the STUN fallback (ok:true) so warmIceServers/getIceServers don't keep retrying a relay that will never
      // arrive (which would stall the online-but-no-TURN join ~7s). Only a FETCH FAILURE below is transient.
      return { servers: STUN_FALLBACK, ok: true }
    }
  } catch {
    /* offline, local dev, or endpoint unreachable — TRANSIENT, fall through to ok:false (retryable) */
  }
  // Fetch FAILED (timeout/offline/non-200). On cellular this is usually a STALLED fetch, not "no TURN here" — so
  // before collapsing to host-only-prone STUN, reuse the last TURN creds we saw (still valid for hours). That keeps
  // a working `relay` candidate across a network change / reload. Cache it (ok:true) so the presence peer's single
  // connect-time fetch gets the relay too — the whole point.
  const reuse = freshPersistedIce()
  if (reuse) return { servers: reuse, ok: true }
  // No saved creds either: STUN for THIS attempt, but ok:false so the caller does NOT cache it (a transient miss
  // must not pin the session to STUN-only — the next consumer re-fetches and can still land TURN).
  return { servers: STUN_FALLBACK, ok: false }
}

/**
 * Best available ICE servers: TURN+STUN when the relay is configured, else
 * STUN-only. Cached per session; concurrent callers share one fetch.
 */
export async function getIceServers(): Promise<RTCIceServer[]> {
  if (cached) return cached
  // Recent saved TURN creds → use them IMMEDIATELY so the Join button never waits on a possibly-stalled fetch and a
  // network change reconnects via relay at once; refresh in the background for next time. (This is what un-grays the
  // slow cellular Join AND keeps relay across a 4G↔WiFi switch.)
  const fresh = freshPersistedIce()
  if (fresh) {
    cached = fresh
    void load().then((r) => {
      if (r.ok) cached = r.servers
    })
    return cached
  }
  if (!inflight) {
    inflight = load().then((r) => {
      if (r.ok)
        cached = r.servers // cache a REAL server answer (TURN, or a deliberate STUN-only free tier) for the session
      else inflight = null // a transient miss is NOT cached → the next consumer (e.g. the media peer after presence) re-fetches and can still land TURN
      return r.servers
    })
  }
  return inflight
}

/**
 * PRE-WARM the TURN relay in the background: keep fetching until a real answer is CACHED, so by the time a call
 * connects, the presence PeerJS peer — whose reliable DataConnections carry the ROSTER — gets the relay on its
 * SINGLE connect-time fetch. Without this, a slow cellular first fetch leaves that peer on STUN-only and the
 * cross-network roster DataConnection never establishes → "joined the room but 0 participants" (the split roster).
 * The media peer re-fetches on its own, so it was unaffected — only the once-fetched presence peer needed this.
 * Fire-and-forget at app load (after the brand turnHost is applied). Bounded; stops on the first real answer.
 */
export async function warmIceServers(tries = 5): Promise<void> {
  for (let i = 0; i < tries; i++) {
    await getIceServers()
    if (cached) return // a real answer (TURN, or a deliberate free-tier STUN) is now cached for the session
    await new Promise((r) => setTimeout(r, 700 * (i + 1))) // transient miss (timeout/offline) → back off and retry
  }
}

/** Test seam: clear the session cache. */
export function _resetIceCache(): void {
  cached = null
  inflight = null
  try {
    localStorage.removeItem(PERSIST_KEY)
  } catch {
    /* ignore */
  }
}
