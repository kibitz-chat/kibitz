// "Presence rides the P2P data channel" (light version) — now the DEFAULT.
//
// The broker WebSocket (signal.kibitz.chat) owns presence/roster. When it flaps (`WS close 1006` on a marginal
// mobile path) a lone authority can broadcast a roster that DROPS a peer you still have a healthy peer-to-peer
// link to — so the app showed you "alone" on a working connection (the iPhone/Samsung capture: media dead, data
// channel up, 328KB flowing, 20ms RTT, yet roster = self only). With rosterHold on, a peer whose P2P SIG data
// channel is still open is KEPT — the mesh doesn't tear its links down, and useCall keeps it in the displayed
// roster with its last-known meta — until the sig channel actually closes (a real leave). The broker becomes
// setup-only, not keep-alive.
//
// Default ON as of 2026-07-03 (owner decision, after the field capture proved the P2P link outlives the broker).
// Per-device escape hatch: `?rhold=0` disables it on that device (persisted); `?rhold=1` forces it back on.
// Revert everyone: set ROSTER_HOLD_DEFAULT=false + redeploy.

const ROSTER_HOLD_DEFAULT = true

/** Hold a peer at most this long after we STOP hearing from it (its data-channel keepalive). A broker flap keeps
 *  the keepalive flowing P2P (so the peer stays); a real leave/crash stops it → the tile clears after this. Long
 *  enough to ride out a flaky link, bounded so a departed peer doesn't linger forever. */
export const ROSTER_HOLD_TIMEOUT_MS = 60000

export function rosterHoldOn(): boolean {
  try {
    const p = new URLSearchParams(location.search).get('rhold')
    if (p === '0' || p === '1') localStorage.setItem('kbz.rosterHold', p)
    const o = localStorage.getItem('kbz.rosterHold')
    if (o === '1' || o === 'true') return true
    if (o === '0' || o === 'false') return false
  } catch {
    /* no window/localStorage (SSR/tests) → the default */
  }
  return ROSTER_HOLD_DEFAULT
}
