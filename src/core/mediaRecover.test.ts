import { describe, it, expect } from 'vitest'
import { shouldRecoverMedia, redialPlan } from './mediaRecover'

const cfg = { minFlowKbps: 1, recoverAfterMs: 9000 }

describe('shouldRecoverMedia (data channel as master)', () => {
  it('receiving fine → never recover', () => {
    expect(shouldRecoverMedia({ inboundKbps: 5, sinceFlowMs: 99999, peerOutboundKbps: 5 }, cfg)).toBe(false)
  })
  it('no inbound but not dead long enough → wait', () => {
    expect(shouldRecoverMedia({ inboundKbps: 0, sinceFlowMs: 3000, peerOutboundKbps: 8 }, cfg)).toBe(false)
  })
  it('no inbound + peer IS sending (real half-open) → recover', () => {
    expect(shouldRecoverMedia({ inboundKbps: 0, sinceFlowMs: 10000, peerOutboundKbps: 8 }, cfg)).toBe(true)
  })
  it('no inbound + peer NOT sending (silent agent / muted human) → do NOT recover (no churn)', () => {
    expect(shouldRecoverMedia({ inboundKbps: 0, sinceFlowMs: 10000, peerOutboundKbps: 0 }, cfg)).toBe(false)
  })
  it('no inbound + peerOutbound UNKNOWN → do NOT recover here (no confirmed half-open; data-channel liveness is reDial’s gate, not this predicate)', () => {
    expect(shouldRecoverMedia({ inboundKbps: 0, sinceFlowMs: 10000, peerOutboundKbps: null }, cfg)).toBe(false)
    expect(shouldRecoverMedia({ inboundKbps: 0, sinceFlowMs: 10000, peerOutboundKbps: undefined }, cfg)).toBe(false)
  })
  // THE GAP: a pc that reached ice=connected but NEVER carried a byte is dead-from-birth (the prflx one-way case).
  // There's no working link to churn, so recover it even when peerTx is UNKNOWN (no heartbeat arriving) — otherwise it
  // sits forever on the dead pair and never reaches the relay escalation that would fix it.
  it('connected but NEVER flowed + peerTx UNKNOWN → RECOVER (nothing to churn; escalate to relay)', () => {
    expect(shouldRecoverMedia({ inboundKbps: 0, sinceFlowMs: 10000, peerOutboundKbps: null, neverFlowed: true, connected: true }, cfg)).toBe(true)
  })
  it('FLOWED-then-quiet + peerTx UNKNOWN → do NOT recover (protect the healthy link from a missing heartbeat)', () => {
    expect(shouldRecoverMedia({ inboundKbps: 0, sinceFlowMs: 10000, peerOutboundKbps: null, neverFlowed: false, connected: true }, cfg)).toBe(false)
  })
  it('never flowed but NOT connected yet + peerTx UNKNOWN → do NOT recover (still connecting, no evidence of a dead path)', () => {
    expect(shouldRecoverMedia({ inboundKbps: 0, sinceFlowMs: 10000, peerOutboundKbps: null, neverFlowed: true, connected: false }, cfg)).toBe(false)
  })
})

describe('redialPlan (relay-on-no-flow escalation)', () => {
  it('fresh/never-connected link at n=0 → gentle ICE-restart, not relay', () => {
    expect(redialPlan(0, { connected: false, everFlowed: false })).toEqual({ iceRestart: true, relay: false })
  })
  it('a path that FLOWED then died (connected, everFlowed) at n=0 → gentle ICE-restart first (a migration, not CGNAT)', () => {
    expect(redialPlan(0, { connected: true, everFlowed: true })).toEqual({ iceRestart: true, relay: false })
  })
  it('escalates to relay by n≥2 regardless', () => {
    expect(redialPlan(2, { connected: false, everFlowed: false }).relay).toBe(true)
  })
  // THE FIX: a pc that reached ice=connected but NEVER carried media (the 4G-CGNAT one-way case) must skip the gentle
  // rungs and go RELAY-only immediately — re-gathering just reconnects to the same STUN-passing-but-media-dead prflx pair.
  it('connected but NEVER flowed at n=0 → SKIP ICE-restart, go RELAY-only', () => {
    expect(redialPlan(0, { connected: true, everFlowed: false })).toEqual({ iceRestart: false, relay: true })
  })
  it('connected but never flowed at n=1 → still RELAY-only (not a plain re-create to the same dead pair)', () => {
    expect(redialPlan(1, { connected: true, everFlowed: false }).relay).toBe(true)
  })
})
