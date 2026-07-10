/**
 * A tiny global diagnostic line, surfaced in the widget's ?debug overlay so
 * WebRTC/broker failures are visible ON A PHONE (where there's no console). The
 * data/media transports write the latest notable event here (peer errors,
 * connection phase, give-up reason); the overlay reads it on each render.
 */
let line = ''
const fields: Record<string, string> = {}

export function setDiag(s: string): void {
  line = s
}

/** Persistent labeled fields (broker / role / peers / gate) shown in the ?debug overlay alongside the
 *  transient transport `line`. TEMP — for diagnosing the split-roster on phones with no console. */
export function setDiagField(key: string, val: string): void {
  fields[key] = val
}

export function getDiag(): string {
  const f = Object.entries(fields)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ')
  return [f, line].filter(Boolean).join(' · ')
}

/**
 * Signaling event ring — broker WebSocket open/close (from connDebug's WS wrapper) + PeerJS peer errors (from
 * transport.ts, which owns the peer). Read by the ?debug overlay + its copy-dump. The peer error TYPE is the
 * diagnostic that distinguishes a broker WS killed by the network ('network' / 'socket-error' / 'server-error')
 * from authority-id contention ('unavailable-id') — the two causes of a `WS close 1006` "join alone".
 */
const signal: string[] = []
export function logSignalEvent(msg: string): void {
  signal.unshift(msg)
  if (signal.length > 16) signal.length = 16
}
export function getSignalLog(): string[] {
  return signal
}
