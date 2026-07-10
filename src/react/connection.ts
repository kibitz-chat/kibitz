import { useEffect, useRef, useState } from 'react'
import type { ConnInfo } from '../core/connStats'

/**
 * Poll each peer's connection diagnostic (direct/relay + RTT + packet loss) while
 * `active`, for a small badge + tooltip on the tiles. Cheap (getStats), and the map
 * keeps a stable reference between polls when nothing meaningful changed so it
 * doesn't churn renders.
 */
const POLL_MS = 6000

/** Same kind + RTT + loss → treat as unchanged (avoids a re-render every poll on tiny
 *  RTT jitter; values are already rounded by connInfo). */
function sameInfo(a: ConnInfo | null, b: ConnInfo | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.kind === b.kind && a.rttMs === b.rttMs && a.lossPct === b.lossPct
}

export function useConnections(
  peerIds: readonly string[],
  getConnectionInfo: (id: string) => Promise<ConnInfo | null>,
  active: boolean,
): Record<string, ConnInfo | null> {
  const [conns, setConns] = useState<Record<string, ConnInfo | null>>({})
  const getRef = useRef(getConnectionInfo)
  getRef.current = getConnectionInfo
  const idsKey = JSON.stringify([...peerIds].sort())

  useEffect(() => {
    if (!active) {
      setConns((prev) => (Object.keys(prev).length ? {} : prev))
      return
    }
    let cancelled = false
    const tick = async () => {
      const ids = JSON.parse(idsKey) as string[]
      const readings = await Promise.all(
        ids.map((id) => getRef.current(id).then((info) => [id, info] as const, () => [id, null] as const)),
      )
      if (cancelled) return
      setConns((prev) => {
        const next: Record<string, ConnInfo | null> = {}
        let changed = ids.length !== Object.keys(prev).length
        for (const [id, info] of readings) {
          next[id] = info
          if (!sameInfo(prev[id] ?? null, info)) changed = true
        }
        return changed ? next : prev
      })
    }
    void tick()
    const iv = setInterval(() => void tick(), POLL_MS)
    return () => {
      cancelled = true
      clearInterval(iv)
    }
  }, [active, idsKey])

  return conns
}
