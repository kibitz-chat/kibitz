import { useCallback, useEffect, useRef, useState } from 'react'
import type { SafetyInfo } from '../core/safetyCode'
import {
  dropPin,
  parsePins,
  pinKeyForName,
  pinStatus,
  serializePins,
  withPin,
  type PinStatus,
  type SafetyPins,
} from '../core/safetyPins'

/**
 * Per-peer safety-code (SAS) state for the Verify panel. The emoji code lets two
 * people on a call rule out a man-in-the-middle by comparing it aloud; we remember
 * which remote certificates the user has confirmed, and flag when a peer reconnects
 * with NEW key material (so a swapped cert mid-call can't quietly inherit an old
 * "verified" badge). See core/safetyCode.ts for where the code comes from.
 */
export interface PeerSafety {
  /** Emoji code to compare aloud; null while it's unavailable. */
  code: string | null
  /** Remote DTLS fingerprint the code was derived from (null if unavailable). */
  remoteFp: string | null
  /** You've confirmed this exact remote cert with the other person. */
  verified: boolean
  /** The peer's cert changed to something you haven't verified — worth a warning. */
  changed: boolean
}

const VERIFIED_KEY = 'kibitz.verified.fps'
const VERIFIED_CAP = 100 // bound the remembered set; certs are ephemeral anyway
const PINS_KEY = 'kibitz.safety.pins'
const POLL_MS = 4000 // re-read live codes so a mid-call key change surfaces

/**
 * Pure transition for one peer's safety entry given a fresh reading. An unavailable
 * reading (`info === null`) is treated as a transient blip — we keep the last known
 * state rather than wiping a hard-won verification.
 *
 * `pin` is the TOFU status of this reading against the saved pins (see core/safetyPins):
 * a 'mismatch' means a contact you verified before is now on a DIFFERENT key, so it raises
 * the SAME `changed` alarm as an in-call swap — across calls, not just within one.
 */
export function nextPeerSafety(
  prev: PeerSafety | undefined,
  info: SafetyInfo | null,
  verified: ReadonlySet<string>,
  pin: PinStatus = 'unpinned',
): PeerSafety {
  if (!info) {
    return {
      code: prev?.code ?? null,
      remoteFp: prev?.remoteFp ?? null,
      verified: prev?.verified ?? false,
      changed: prev?.changed ?? false,
    }
  }
  const isVerified = verified.has(info.remoteFp)
  // A peer we already had a fingerprint for now presents a DIFFERENT, untrusted one
  // → the key changed under us; surface it (a benign re-dial keeps the same cert).
  const inCallChanged = prev?.remoteFp != null && prev.remoteFp !== info.remoteFp && !isVerified
  // TOFU across calls: a known contact (name) whose key differs from the one you pinned.
  const pinMismatch = pin === 'mismatch' && !isVerified
  return { code: info.code, remoteFp: info.remoteFp, verified: isVerified, changed: inCallChanged || pinMismatch }
}

/** True when two safety maps carry identical per-peer state (same peers + fields) —
 *  lets the poll keep a stable reference and skip a re-render when nothing moved. */
export function sameSafety(a: Record<string, PeerSafety>, b: Record<string, PeerSafety>): boolean {
  const ak = Object.keys(a)
  if (ak.length !== Object.keys(b).length) return false
  for (const k of ak) {
    const x = a[k]
    const y = b[k]
    if (!y || x.code !== y.code || x.remoteFp !== y.remoteFp || x.verified !== y.verified || x.changed !== y.changed)
      return false
  }
  return true
}

/** Parse the stored verified-fingerprint list (tolerant: bad data → empty set). */
export function parseVerifiedFps(raw: string | null): Set<string> {
  if (!raw) return new Set()
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? new Set(arr.filter((x): x is string => typeof x === 'string')) : new Set()
  } catch {
    return new Set()
  }
}

/** Serialize the verified set, keeping only the most-recent `cap` fingerprints. */
export function serializeVerifiedFps(set: ReadonlySet<string>, cap = VERIFIED_CAP): string {
  return JSON.stringify(Array.from(set).slice(-cap))
}

function loadVerifiedFps(): Set<string> {
  try {
    return parseVerifiedFps(localStorage.getItem(VERIFIED_KEY))
  } catch {
    return new Set()
  }
}

function persistVerifiedFps(set: ReadonlySet<string>): void {
  try {
    localStorage.setItem(VERIFIED_KEY, serializeVerifiedFps(set))
  } catch {
    /* storage blocked — verification just won't persist across reloads */
  }
}

function loadPins(): SafetyPins {
  try {
    return parsePins(localStorage.getItem(PINS_KEY))
  } catch {
    return {}
  }
}

function persistPins(pins: SafetyPins): void {
  try {
    localStorage.setItem(PINS_KEY, serializePins(pins))
  } catch {
    /* storage blocked — pins just won't persist across reloads */
  }
}

export interface SafetyApi {
  /** Per-participant-id safety state for the rendered peers. */
  safety: Record<string, PeerSafety>
  /** Mark the participant's current remote cert as confirmed (persists). */
  verify: (id: string) => void
  /** Withdraw confirmation for the participant's current remote cert. */
  unverify: (id: string) => void
}

/**
 * Drive the Verify panel: while `active`, poll each peer's live safety code, fold it
 * into per-peer state (with change detection), and let the user confirm/withdraw a
 * code. `getSafetyCode` is useCall's per-peer accessor; `peerIds` are the remote
 * participants' ids. Polling is gated on `active` (costs nothing when false); the
 * caller decides when — Kibitz polls for the whole call so the key-change alarm is
 * proactive, not only while the panel is open.
 */
export function useSafety(
  peerIds: readonly string[],
  getSafetyCode: (id: string) => Promise<SafetyInfo | null>,
  active: boolean,
  /** Map a participant id → a stable contact key (their name) for TOFU pinning. Omit (or return '')
   *  to disable pinning for a peer — then only the in-call key-change alarm applies. */
  keyOf?: (id: string) => string,
): SafetyApi {
  const [safety, setSafety] = useState<Record<string, PeerSafety>>({})
  const verifiedRef = useRef<Set<string>>(loadVerifiedFps())
  const pinsRef = useRef<SafetyPins>(loadPins())
  const getRef = useRef(getSafetyCode)
  getRef.current = getSafetyCode
  const keyRef = useRef(keyOf)
  keyRef.current = keyOf

  // A stable, collision-free dep for the effect (the array identity changes every
  // render). Sorted so a roster reorder doesn't needlessly restart the poll, and
  // JSON-encoded so an id can't smuggle the delimiter or alias another id set.
  const idsKey = JSON.stringify([...peerIds].sort())

  // Drop stale per-peer state when the call ends, so a warning (or a "verified"
  // badge) from a finished call can't bleed into the next one.
  const wasActive = useRef(active)
  useEffect(() => {
    if (wasActive.current && !active) setSafety({})
    wasActive.current = active
  }, [active])

  useEffect(() => {
    if (!active) return
    let cancelled = false
    const tick = async () => {
      const ids = JSON.parse(idsKey) as string[]
      const readings = await Promise.all(
        ids.map((id) =>
          getRef.current(id).then(
            (info) => [id, info] as const,
            () => [id, null] as const,
          ),
        ),
      )
      if (cancelled) return
      setSafety((prev) => {
        const next: Record<string, PeerSafety> = {}
        for (const [id, info] of readings) {
          const pin = info ? pinStatus(pinsRef.current, keyRef.current?.(id) ?? '', info.remoteFp) : 'unpinned'
          next[id] = nextPeerSafety(prev[id], info, verifiedRef.current, pin)
        }
        // Return the SAME reference when nothing changed, so a steady call doesn't
        // re-render the panel every poll (this can run continuously for the alarm).
        return sameSafety(prev, next) ? prev : next
      })
    }
    void tick()
    const iv = setInterval(() => void tick(), POLL_MS)
    return () => {
      cancelled = true
      clearInterval(iv)
    }
  }, [active, idsKey])

  const verify = useCallback((id: string) => {
    setSafety((prev) => {
      const cur = prev[id]
      if (!cur?.remoteFp) return prev
      const set = new Set(verifiedRef.current)
      set.delete(cur.remoteFp) // re-insert so a re-verified fp counts as most-recent
      set.add(cur.remoteFp)
      verifiedRef.current = set
      persistVerifiedFps(set)
      // TOFU: confirming a contact PINS this fingerprint to their name, so a different key on a
      // later call trips the alarm (a pin is set on explicit verify, never on first connect).
      const key = pinKeyForName(keyRef.current?.(id))
      if (key) {
        pinsRef.current = withPin(pinsRef.current, key, cur.remoteFp)
        persistPins(pinsRef.current)
      }
      return { ...prev, [id]: { ...cur, verified: true, changed: false } }
    })
  }, [])

  const unverify = useCallback((id: string) => {
    setSafety((prev) => {
      const cur = prev[id]
      if (!cur?.remoteFp) return prev
      const set = new Set(verifiedRef.current)
      set.delete(cur.remoteFp)
      verifiedRef.current = set
      persistVerifiedFps(set)
      // Withdrawing trust forgets the pin too — a clean slate, not a lingering alarm.
      const key = pinKeyForName(keyRef.current?.(id))
      if (key) {
        pinsRef.current = dropPin(pinsRef.current, key)
        persistPins(pinsRef.current)
      }
      // Clearing trust is a clean slate, not an alarm — drop any stale `changed`.
      return { ...prev, [id]: { ...cur, verified: false, changed: false } }
    })
  }, [])

  return { safety, verify, unverify }
}
