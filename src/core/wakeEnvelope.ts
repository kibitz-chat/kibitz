// Pure parser/validator for the wake-push payload — the wire contract between a Hub and
// Kibitz's service worker. Shared by src/sw.ts AND its unit tests, so it has NO DOM /
// browser deps and bundles cleanly in a worker. See docs/wake-seam.md.
//
// The SW treats the payload as UNTRUSTED (the Hub is across a trust boundary, and may be
// compromised): one verb only, versioned, room id bounded. Anything off-spec → null, and
// the SW drops it without showing a notification.

export interface WakeEnvelope {
  /** The room to offer to join. normalizeRoom() output shape: lowercase alnum + hyphens. */
  roomId: string
  /** Optional caller-supplied DISPLAY text (e.g. "Alice is calling"). Never the room id. */
  label: string
}

// Room ids are normalizeRoom() output: lowercase alphanumerics + hyphens, ≤40 chars. Bound
// it here (a little wider, ≤64) so a malformed/compromised Hub can't push an oversized or
// odd value into the URL the SW opens.
const ROOM_RE = /^[a-z0-9-]{3,64}$/
const LABEL_MAX = 80

export function parseWakeEnvelope(raw: unknown): WakeEnvelope | null {
  if (!raw || typeof raw !== 'object') return null
  const m = raw as Record<string, unknown>
  if (m.v !== 1 || m.kind !== 'wake') return null // unknown version/verb → drop
  if (typeof m.roomId !== 'string' || !ROOM_RE.test(m.roomId)) return null
  const label = typeof m.label === 'string' ? m.label.slice(0, LABEL_MAX) : ''
  return { roomId: m.roomId, label }
}
