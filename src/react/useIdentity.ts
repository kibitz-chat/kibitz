import { useEffect, useRef, useState } from 'react'
import type { VerifiedIdentity } from '../core/identity'

/** Per-participant-id verified identity (null = not proven). */
export type IdentityMap = Record<string, VerifiedIdentity | null>

/** Stable-compare two identity maps so a steady call doesn't re-render each poll. */
export function sameIdentities(a: IdentityMap, b: IdentityMap): boolean {
  const ak = Object.keys(a)
  if (ak.length !== Object.keys(b).length) return false
  for (const k of ak) {
    if (!(k in b)) return false
    const x = a[k]
    const y = b[k]
    if ((x?.email ?? null) !== (y?.email ?? null) || (x?.sub ?? null) !== (y?.sub ?? null)) return false
  }
  return true
}

const POLL_MS = 4000

/**
 * Poll each id's cert-bound verified identity while `active`. `ids` should include
 * yourself (getIdentity returns your own on your id). A reading of null — not proven,
 * not yet connected, or verification failed — simply shows no badge; once a peer is
 * verified, getIdentity caches it, so it stays stable without refetching.
 */
export function useIdentity(
  ids: readonly string[],
  getIdentity: (id: string) => Promise<VerifiedIdentity | null>,
  active: boolean,
): IdentityMap {
  const [identities, setIdentities] = useState<IdentityMap>({})
  const getRef = useRef(getIdentity)
  getRef.current = getIdentity
  const idsKey = JSON.stringify([...ids].sort())

  // Clear when the call ends so a verified badge can't bleed into the next call.
  const wasActive = useRef(active)
  useEffect(() => {
    if (wasActive.current && !active) setIdentities({})
    wasActive.current = active
  }, [active])

  useEffect(() => {
    if (!active) return
    let cancelled = false
    const tick = async () => {
      const list = JSON.parse(idsKey) as string[]
      const readings = await Promise.all(
        list.map((id) =>
          getRef.current(id).then(
            (v) => [id, v] as const,
            () => [id, null] as const,
          ),
        ),
      )
      if (cancelled) return
      setIdentities((prev) => {
        const next: IdentityMap = {}
        for (const [id, v] of readings) next[id] = v
        return sameIdentities(prev, next) ? prev : next
      })
    }
    void tick()
    const iv = setInterval(() => void tick(), POLL_MS)
    return () => {
      cancelled = true
      clearInterval(iv)
    }
  }, [active, idsKey])

  return identities
}
