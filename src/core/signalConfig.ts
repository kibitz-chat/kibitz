import { fetchWithTimeout } from './fetchTimeout'
import type { PeerConfig } from './transport'

/**
 * Which signaling broker the ONLINE call uses for peer discovery — chosen
 * DYNAMICALLY, but CONSISTENTLY across participants.
 *
 * The choice is one shared, server-side signal: the `/api/signal` Pages Function
 * reports our self-hosted signaling worker's host when it's healthy, or null (→
 * the public PeerJS broker) when it isn't. Every client reads that same endpoint,
 * so they agree on the broker — which they must, since two peers on different
 * brokers can't find each other. If our worker goes down, the health check fails
 * for everyone alike and the whole call falls back to the public broker together,
 * then auto-recovers when it returns.
 *
 * Per-CLIENT probing is deliberately avoided: a single client's local network
 * blip must not put it on a different broker than the rest of the call.
 */

const CHOICE_TTL_MS = 30_000

/** Pure builder (testable): PeerJS config for `host`, or undefined when blank. */
export function buildSignalConfig(host: string | null | undefined): PeerConfig | undefined {
  const h = (host ?? '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '')
  return h ? { host: h, port: 443, path: '/', secure: true } : undefined
}

/** A forced signaling host that bypasses the /api/signal probe. The browser
 *  extension sets this (it runs on a chrome-extension:// origin where /api/signal
 *  doesn't exist, so it must point straight at our worker). null = auto-probe. */
let forcedHost: string | null = null
export function setSignalHost(host: string | null): void {
  forcedHost = host && host.trim() ? host.trim() : null
  cached = null
}

let cached: { at: number; cfg: PeerConfig | undefined } | null = null
let inflight: Promise<PeerConfig | undefined> | null = null

// We NEVER use the public PeerJS cloud (0.peerjs.com): peers there land on different backend instances and can't
// discover each other (the confirmed "join alone on 4G" bug — iPhone's probe times out → public, desktop → our
// worker → different brokers → never meet). Signaling is ALWAYS self-hosted: the host /api/signal reports, the
// last one we saw work, or this default — but never public. chooseSignal() therefore never returns undefined.
const DEFAULT_SIGNAL_HOST = 'signal.kibitz.chat'
const HOST_STORE_KEY = 'kbz.signalHost'
function rememberHost(host: string): void {
  try {
    localStorage.setItem(HOST_STORE_KEY, host)
  } catch {
    /* ignore */
  }
}
function rememberedHost(): string | null {
  try {
    return localStorage.getItem(HOST_STORE_KEY)
  } catch {
    return null
  }
}

async function fetchChoice(): Promise<PeerConfig | undefined> {
  try {
    // Bounded so a stalled fetch can't block joining (see fetchTimeout).
    const res = await fetchWithTimeout('/api/signal', { credentials: 'omit' })
    if (res.ok) {
      const data = (await res.json()) as { host?: string | null }
      if (data.host) {
        rememberHost(data.host) // so a later probe failure reuses the SAME broker
        return buildSignalConfig(data.host)
      }
      // host null/empty → fall through to a self-hosted broker (NOT the public cloud).
    }
  } catch {
    /* network / timeout — fall through to a self-hosted broker, never public */
  }
  // Probe returned no host or failed (on cellular, usually a slow fetch — not a dead worker). Stay self-hosted:
  // the last broker that worked, else the default. NEVER undefined ⇒ PeerJS can never fall through to public.
  return buildSignalConfig(rememberedHost() || DEFAULT_SIGNAL_HOST)
}

/**
 * The signaling broker to use now: our worker (when `/api/signal` reports it
 * healthy) or undefined → the public PeerJS broker. Briefly cached so a call's
 * room + media peers share one answer; the shared endpoint keeps clients in sync.
 */
export async function chooseSignal(): Promise<PeerConfig | undefined> {
  if (forcedHost) return buildSignalConfig(forcedHost) // extension: skip the /api/signal probe
  if (cached && Date.now() - cached.at < CHOICE_TTL_MS) return cached.cfg
  if (!inflight) {
    inflight = fetchChoice().then((cfg) => {
      cached = { at: Date.now(), cfg }
      inflight = null
      return cfg
    })
  }
  return inflight
}

/** Test seam: clear the cached choice. */
export function _resetSignalChoice(): void {
  cached = null
  inflight = null
}
