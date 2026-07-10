// Data channel as master — when to RE-DIAL a media link that's receiving ~nothing.
//
// The reliable data channel (+ its media-health heartbeat, `mh`) is the source of truth for link liveness. So a media
// re-dial is only warranted for a REAL half-open: the peer reports it IS sending (peerOutbound > 0) but we receive
// ~0 — a path that carries the data channel but has gone dead for RTP. A peer that is simply QUIET (peerOutbound ~0:
// a voice agent with no microphone, or a muted human) is alive-but-silent — re-dialing would only CHURN the
// connection (it did: a silent agent's link got re-dialed every few seconds and its replies stopped arriving). This
// is why the agent needed a constant outgoing "keep-alive" dither before — to fake an always-on signal so its link
// never looked dead. With this check the dither is unnecessary and was removed.
//
// Recover ONLY a CONFIRMED half-open: the peer reports it IS sending (peerOutbound > 0) but we receive ~0 — RTP died on
// a path whose data channel still carries the `mh` heartbeat. A quiet peer (peerOutbound ~0: a mic-less voice agent or
// a muted/typing human) is alive-but-silent → never re-dial. And when the peer's outbound is UNKNOWN (no `mh` arriving)
// there is NO positive evidence of a half-open, so we don't recover here either.
//
// Liveness is the DATA CHANNEL's job, not this function's: every media re-dial signal (m-recreate + offer/answer + ICE)
// rides the data channel, so reDial() is gated on the sig channel being open — "data channel as master." A genuinely
// dead media path is still caught by the pc 'failed' trigger and recovered once the data channel is up, so refusing to
// recover on "unknown outbound" can't strand a dead link — it just stops a MISSING control signal from churning a
// WORKING one (the bug: a typing/muted human's healthy relay link re-dialled every ~9s while the data channel was fine).
export function shouldRecoverMedia(
  args: { inboundKbps: number; sinceFlowMs: number; peerOutboundKbps: number | null | undefined; neverFlowed?: boolean; connected?: boolean },
  cfg: { minFlowKbps: number; recoverAfterMs: number },
): boolean {
  if (args.inboundKbps >= cfg.minFlowKbps) return false // we're receiving — healthy, nothing to do
  if (args.sinceFlowMs <= cfg.recoverAfterMs) return false // not been dead long enough yet
  const peerTx = args.peerOutboundKbps
  if (peerTx != null && peerTx >= cfg.minFlowKbps) return true // confirmed half-open (peer sending, we hear ~0)
  // Dead-from-birth: a pc that reached ice=connected but NEVER carried a byte (the prflx one-way case) has no working
  // link to churn — recover it even when peerTx is UNKNOWN (no heartbeat), so it can escalate to relay. A link that
  // FLOWED then went quiet with unknown peerTx stays protected (the missing-heartbeat-on-a-healthy-link guard).
  return !!args.neverFlowed && !!args.connected
}

// Which rung of the re-dial ladder to run for a link that isn't receiving. The gentle rungs — an in-place ICE-restart
// (n=0), then a plain re-create (n=1) — RE-GATHER the same candidates; that's right when a path FLOWED then died (a
// network change orphaned the candidates). But a pc that reached ice=connected and NEVER carried media is the 4G-CGNAT
// one-way case: STUN checks pass over a peer-reflexive (prflx) pair, yet the return media 5-tuple is dropped by the
// carrier NAT — so re-gathering just reconnects to that SAME dead prflx pair. Such a link must jump STRAIGHT to
// RELAY-only (skip the gentle rungs) so the CGNAT'd peer receives over its own stable TURN relay (the path that works).
export function redialPlan(n: number, o: { connected: boolean; everFlowed: boolean }): { iceRestart: boolean; relay: boolean } {
  const connectedDead = o.connected && !o.everFlowed // reached ice=connected but never carried media → the prflx/CGNAT one-way case
  return { iceRestart: n === 0 && !connectedDead, relay: n >= 2 || connectedDead }
}
