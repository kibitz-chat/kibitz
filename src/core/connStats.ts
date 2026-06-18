/**
 * Read a peer connection's WebRTC stats for a small connection diagnostic: whether
 * the media flows DIRECTLY between browsers or via a TURN relay, plus round-trip
 * time and inbound packet loss. P2P is the norm; a relay kicks in only when a strict
 * NAT/firewall blocks a direct path. Purely diagnostic (never changes the call) and
 * pure, so it's unit-testable against a mock stats report.
 */
export type ConnKind = 'direct' | 'relay'

/** The few stat fields we read — a structural subset of RTCStats. */
export interface RtcStatLike {
  type: string
  id?: string
  [k: string]: unknown
}

export interface ConnInfo {
  /** Direct (P2P) or relayed, or null while still connecting. */
  kind: ConnKind | null
  /** Round-trip time in ms, or null if unavailable. */
  rttMs: number | null
  /** Inbound packet loss as a percentage (0–100), or null if unavailable. */
  lossPct: number | null
}

/** Index the report once: the selected/active candidate pair + inbound-rtp stats. */
function index(stats: Iterable<RtcStatLike>) {
  const byId = new Map<string, RtcStatLike>()
  const pairs: RtcStatLike[] = []
  const inbound: RtcStatLike[] = []
  let selectedPairId: string | undefined
  for (const s of stats) {
    if (s.id) byId.set(s.id, s)
    if (s.type === 'candidate-pair') pairs.push(s)
    else if (s.type === 'inbound-rtp') inbound.push(s)
    else if (s.type === 'transport' && typeof s.selectedCandidatePairId === 'string') selectedPairId = s.selectedCandidatePairId
  }
  // Active pair: the transport's selected one, else a succeeded + nominated pair,
  // else any succeeded pair (Firefox flags it `selected` rather than `nominated`).
  const pair =
    (selectedPairId ? byId.get(selectedPairId) : undefined) ??
    pairs.find((p) => p.state === 'succeeded' && (p.nominated === true || p.selected === true)) ??
    pairs.find((p) => p.state === 'succeeded')
  return { byId, pair, inbound }
}

/** Classify an already-indexed report's active pair as direct/relayed, or null. */
function kindOf(byId: Map<string, RtcStatLike>, pair: RtcStatLike | undefined): ConnKind | null {
  if (!pair) return null
  const local = typeof pair.localCandidateId === 'string' ? byId.get(pair.localCandidateId) : undefined
  const remote = typeof pair.remoteCandidateId === 'string' ? byId.get(pair.remoteCandidateId) : undefined
  const types = [local?.candidateType, remote?.candidateType].filter((t): t is string => typeof t === 'string')
  if (!types.length) return null
  return types.includes('relay') ? 'relay' : 'direct'
}

/**
 * Classify the ACTIVE candidate pair as direct or relayed, or null when no pair has
 * succeeded yet. A relay on EITHER end means the media is being forwarded.
 */
export function summarizeConnection(stats: Iterable<RtcStatLike>): ConnKind | null {
  const { byId, pair } = index(stats)
  return kindOf(byId, pair)
}

/** Kind + round-trip time + inbound packet loss, in one pass. Fields are null when
 *  the stat isn't present yet (e.g. still connecting). */
export function connInfo(stats: Iterable<RtcStatLike>): ConnInfo {
  const { byId, pair, inbound } = index(stats)
  const kind = kindOf(byId, pair)
  let rttMs: number | null = null
  const rtt = pair?.currentRoundTripTime
  if (typeof rtt === 'number' && isFinite(rtt) && rtt >= 0) rttMs = Math.round(rtt * 1000)
  let lost = 0
  let recv = 0
  let have = false
  for (const r of inbound) {
    if (typeof r.packetsLost === 'number') {
      lost += r.packetsLost
      have = true
    }
    if (typeof r.packetsReceived === 'number') recv += r.packetsReceived
  }
  const total = lost + recv
  const lossPct = have ? Math.max(0, Math.min(100, total > 0 ? Math.round((lost / total) * 100) : 0)) : null
  return { kind, rttMs, lossPct }
}

/** Collect an RTCStatsReport (Map-like) into the plain array the summarizers want —
 *  used by the meshes; kept here so the read is in one place. */
export function statsToArray(report: { forEach(cb: (s: RtcStatLike) => void): void }): RtcStatLike[] {
  const out: RtcStatLike[] = []
  report.forEach((s) => out.push(s))
  return out
}
