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

async function fetchChoice(): Promise<PeerConfig | undefined> {
  try {
    // Bounded so a stalled fetch can't block joining (see fetchTimeout) — fall
    // back to the public broker fast instead of hanging the Join button.
    const res = await fetchWithTimeout('/api/signal', { credentials: 'omit' })
    if (res.ok) {
      const data = (await res.json()) as { host?: string | null }
      return buildSignalConfig(data.host)
    }
  } catch {
    /* offline / endpoint missing — fall back to the public broker */
  }
  return undefined
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
