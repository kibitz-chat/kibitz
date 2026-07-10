// Single active instance per browser (per-origin). When a brand opts in (e.g. kibitz), only the
// MOST-RECENTLY-opened tab/window may hold a live call; when a newer one opens, older tabs bow out
// (SingleInstanceGuard leaves the call and returns home). Tabs coordinate over a same-origin
// BroadcastChannel with a tiny leader election:
//
//   • Each instance holds a CLAIM = { id, epoch }. `newer` orders claims by epoch, then id (a stable
//     tiebreak). The NEWEST claim is the active instance — "the last one wins".
//   • On mount an instance claims; anyone it out-ranks yields (goes dormant). A dormant instance that
//     is itself out-ranked simply adopts the newer leader.
//   • The active instance heartbeats; if a dormant instance stops hearing the leader (it closed/crashed)
//     it holds an election and the newest survivor takes over. A clean close broadcasts `bye` so the
//     handoff is instant, not timeout-bound.
//   • `takeOver()` bumps this instance's epoch above the current leader and claims — guaranteed to win
//     (kept for an optional manual "use this tab" affordance; the default guard just goes home instead).
//
// The election reducer (`decide`/`elect`/`newer`) is PURE and time-injected, so it unit-tests without a
// real BroadcastChannel or timers. The hook wires it to the channel + heartbeat interval + pagehide.

import { useCallback, useEffect, useRef, useState } from 'react'

export type Claim = { id: string; epoch: number }
export type Msg = { t: 'claim' | 'heartbeat' | 'bye'; claim: Claim }
export type InstanceState = { self: Claim; leader: Claim; active: boolean; lastBeat: number }

const CHANNEL = 'kbz-instance'
export const HEARTBEAT_MS = 2000
export const TIMEOUT_MS = 6000 // 3 missed beats ⇒ the leader is gone ⇒ elect

/** Strict ordering of claims: a newer epoch wins; equal epochs break by id (deterministic across tabs). */
export function newer(a: Claim, b: Claim): boolean {
  return a.epoch > b.epoch || (a.epoch === b.epoch && a.id > b.id)
}

/** Freshly outrank a reference epoch (and never go backwards on the wall clock). */
const bump = (now: number, ref: number): number => Math.max(now, ref + 1)

/** Run for leader: mint an epoch above the last-known leader and become active. */
export function elect(st: InstanceState, now: number): { state: InstanceState; send?: Msg } {
  const self: Claim = { id: st.self.id, epoch: bump(now, st.leader.epoch) }
  return { state: { self, leader: self, active: true, lastBeat: now }, send: { t: 'claim', claim: self } }
}

/** The pure election step: fold an incoming message into the state, optionally emitting one to broadcast. */
export function decide(st: InstanceState, m: Msg, now: number): { state: InstanceState; send?: Msg } {
  if (m.t === 'claim') {
    // Someone newer than the instance I currently believe leads ⇒ they lead now; I'm dormant.
    if (newer(m.claim, st.leader)) return { state: { ...st, leader: m.claim, active: false, lastBeat: now } }
    // An OLDER instance claimed while I'm the active leader ⇒ re-assert so it yields to me.
    if (st.active && m.claim.id !== st.self.id && newer(st.self, m.claim)) return { state: st, send: { t: 'claim', claim: st.self } }
    return { state: st }
  }
  if (m.t === 'heartbeat') {
    if (m.claim.id === st.leader.id) return { state: { ...st, lastBeat: now } } // my leader is alive
    if (newer(m.claim, st.leader)) return { state: { ...st, leader: m.claim, active: false, lastBeat: now } } // a newer leader announced itself
    return { state: st }
  }
  if (m.t === 'bye') {
    if (m.claim.id === st.leader.id) return elect(st, now) // the leader left ⇒ survivors race; newest wins
    return { state: st }
  }
  return { state: st }
}

// Module-scoped mirror of THIS tab's dormancy, so non-React callers (e.g. the app's leave→go-home wiring)
// can tell an INVOLUNTARY single-instance leave apart from a user hang-up and skip the navigation.
let _dormant = false
export const isSingleInstanceDormant = (): boolean => _dormant

const rid = (): string => {
  const c = globalThis.crypto as Crypto | undefined
  return c?.randomUUID ? c.randomUUID() : `i${Date.now().toString(36)}${Math.floor(Math.random() * 1e9).toString(36)}`
}

/**
 * Leader-elect this tab among same-origin instances. `enabled=false` (or no BroadcastChannel) ⇒ always
 * active (feature-off / graceful degradation). Returns `active` and `takeOver()` (claim leadership now).
 */
export function useSingleInstance(enabled: boolean): { active: boolean; takeOver: () => void } {
  const [active, setActive] = useState(true)
  const stRef = useRef<InstanceState | null>(null)
  const chRef = useRef<BroadcastChannel | null>(null)

  useEffect(() => {
    if (!enabled || typeof BroadcastChannel === 'undefined') {
      _dormant = false
      setActive(true)
      return
    }
    const now = Date.now()
    const self: Claim = { id: rid(), epoch: now }
    let st: InstanceState = { self, leader: self, active: true, lastBeat: now }
    stRef.current = st
    const ch = new BroadcastChannel(CHANNEL)
    chRef.current = ch

    const commit = (r: { state: InstanceState; send?: Msg }) => {
      st = r.state
      stRef.current = st
      _dormant = !st.active
      setActive(st.active)
      if (r.send) ch.postMessage(r.send)
    }

    ch.onmessage = (e) => {
      const m = e.data as Msg
      if (!m || !m.claim || typeof m.claim.epoch !== 'number') return
      commit(decide(st, m, Date.now()))
    }
    ch.postMessage({ t: 'claim', claim: self }) // announce myself → outranked incumbents yield

    const iv = setInterval(() => {
      const t = Date.now()
      if (st.active) ch.postMessage({ t: 'heartbeat', claim: st.self })
      else if (t - st.lastBeat > TIMEOUT_MS) commit(elect(st, t)) // leader went silent ⇒ take the room
    }, HEARTBEAT_MS)

    const bye = () => {
      try {
        ch.postMessage({ t: 'bye', claim: st.self })
      } catch {
        /* channel already closing */
      }
    }
    window.addEventListener('pagehide', bye)

    return () => {
      clearInterval(iv)
      window.removeEventListener('pagehide', bye)
      bye()
      ch.close()
      chRef.current = null
      _dormant = false
    }
  }, [enabled])

  const takeOver = useCallback(() => {
    const st = stRef.current
    const ch = chRef.current
    if (!st || !ch) return
    const self: Claim = { id: st.self.id, epoch: bump(Date.now(), st.leader.epoch) }
    st.self = self
    st.leader = self
    st.active = true
    st.lastBeat = Date.now()
    _dormant = false
    setActive(true)
    ch.postMessage({ t: 'claim', claim: self })
  }, [])

  return { active: enabled ? active : true, takeOver }
}
