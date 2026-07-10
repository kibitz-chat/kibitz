// Personal "hide my IP" preference. When ON, this browser routes its media + data through the TURN
// relay (the call mounts with `relayOnly`), so other participants see the relay's IP, not yours. It's
// per-BROWSER (your own choice), not a room setting — the relay (and the host) still see your IP, and
// it can add a little latency, but it can't read your media/data (still end-to-end encrypted).
const RELAY_KEY = 'kibitz.relayOnly'

export const getRelayOnly = (): boolean => {
  try {
    return localStorage.getItem(RELAY_KEY) === '1'
  } catch {
    return false
  }
}

export const setRelayOnly = (on: boolean): void => {
  try {
    if (on) localStorage.setItem(RELAY_KEY, '1')
    else localStorage.removeItem(RELAY_KEY)
  } catch {
    /* storage unavailable */
  }
}
