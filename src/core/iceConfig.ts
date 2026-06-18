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

let cached: RTCIceServer[] | null = null
let inflight: Promise<RTCIceServer[]> | null = null

async function load(): Promise<RTCIceServer[]> {
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
      if (Array.isArray(data.iceServers) && data.iceServers.length) return data.iceServers
    }
  } catch {
    /* offline, local dev, or endpoint not configured — fall back to STUN */
  }
  return STUN_FALLBACK
}

/**
 * Best available ICE servers: TURN+STUN when the relay is configured, else
 * STUN-only. Cached per session; concurrent callers share one fetch.
 */
export async function getIceServers(): Promise<RTCIceServer[]> {
  if (cached) return cached
  if (!inflight) inflight = load().then((servers) => (cached = servers))
  return inflight
}

/** Test seam: clear the session cache. */
export function _resetIceCache(): void {
  cached = null
  inflight = null
}
