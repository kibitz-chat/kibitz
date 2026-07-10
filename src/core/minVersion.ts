/**
 * Minimum-supported-version floor — the kill-switch counterpart to versioned pinning
 * (COMPATIBILITY.md). Because a pinned/cached build can live forever in a serverless P2P
 * system, an operator needs a way to RETIRE a known-vulnerable old build: a small static
 * `min-version.json` at the deployment's origin, e.g. `{ "min": "0.2.0", "message": "…" }`.
 *
 * A running build fetches it at boot and, if its own version is BELOW `min`, treats itself
 * as retired (the UI shows a notice and refuses to connect). FAIL-OPEN by design: a missing
 * file, a network error, or no `min` means "no floor → run" — a blip must never brick a call,
 * and the default deployment ships `min: 0.0.0` (nothing retired) until an operator raises it.
 */

export interface MinVersionFloor {
  /** Builds strictly below this version are retired. Absent ⇒ no floor. */
  min?: string
  /** Optional operator note shown to a retired build's users. */
  message?: string
}

export interface RetirementCheck {
  retired: boolean
  min?: string
  message?: string
}

/** Parse 'a.b.c' (extra/junk ignored) into a numeric triple; missing parts ⇒ 0. */
function parse(v: string): [number, number, number] {
  const m = /^\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(v || '')
  return m ? [Number(m[1]) || 0, Number(m[2]) || 0, Number(m[3]) || 0] : [0, 0, 0]
}

/** True iff `version` is strictly older than `floor` (major.minor.patch). */
export function isBelow(version: string, floor: string): boolean {
  const a = parse(version)
  const b = parse(floor)
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i]
  return false
}

/** Pure decision: is this version retired by this floor? (Testable with no I/O.) */
export function decideRetired(version: string, floor: MinVersionFloor | null): RetirementCheck {
  if (floor && typeof floor.min === 'string' && isBelow(version, floor.min)) {
    return { retired: true, min: floor.min, message: floor.message }
  }
  return { retired: false }
}

/** Fetch the floor; FAIL-OPEN to null on any error / non-ok / bad JSON / timeout. */
export async function fetchFloor(
  url: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 4000,
): Promise<MinVersionFloor | null> {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timeoutMs)
    const res = await fetchImpl(url, { signal: ctrl.signal, cache: 'no-store' })
    clearTimeout(t)
    if (!res.ok) return null
    const j = (await res.json()) as MinVersionFloor
    return j && typeof j === 'object' ? j : null
  } catch {
    return null // fail open — no floor reachable ⇒ run
  }
}

/** Fetch the floor and decide. Never throws; fail-open (not retired) on any problem. */
export async function checkRetired(
  version: string,
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RetirementCheck> {
  return decideRetired(version, await fetchFloor(url, fetchImpl))
}
