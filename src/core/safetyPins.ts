/**
 * Trust-on-first-use (TOFU) pins for the safety code (SAS).
 *
 * The flat verified-fingerprint set (see react/safety.ts) already auto-recognises a RETURNING key
 * across calls — if a peer presents a fingerprint you once confirmed, they show as verified again.
 * What it can't do is notice when a CONTACT YOU KNOW turns up with a DIFFERENT key: with no
 * contact→key binding, a swapped cert just reads as "not yet verified", not as a warning.
 *
 * A pin closes that: when you VERIFY a contact (compare the emoji code and confirm), we remember
 * their fingerprint against a stable-ish key — their name. On a later call, a contact with the same
 * key but a DIFFERENT fingerprint raises the same man-in-the-middle alarm — the SSH "REMOTE HOST
 * IDENTIFICATION HAS CHANGED" behaviour — instead of silently downgrading to unverified.
 *
 * Honest limits, by design:
 *  - A pin is keyed on a SELF-ASSERTED name, so it only ever asserts "the contact you call <name> is
 *    using a different key than the one you verified" — useful, but not a cryptographic identity.
 *    For that, use a verified room (OIDC/email, cert-bound, checked peer-to-peer).
 *  - A pin is established on an EXPLICIT verify, not on first connect — so a man-in-the-middle that
 *    is present from the very first call can't auto-pin itself as trusted (you'd have had to compare
 *    the code with the real person first).
 *  - A legitimate new device (new cert) for a known contact will (correctly) trip the alarm, exactly
 *    like SSH — you re-verify and the pin moves to the new key.
 */

/** contactKey (normalised name) -> the fingerprint you last verified for them. Insertion order is
 *  treated as recency (most-recently-pinned last), so the cap drops the oldest. */
export type SafetyPins = Record<string, string>

/** Status of a live reading against the saved pins. */
export type PinStatus =
  | 'unpinned' // no pin for this contact yet (first verify will create one)
  | 'match' //    same key you pinned — nothing changed
  | 'mismatch' // a DIFFERENT key than you pinned — the cross-call MITM alarm

const PIN_CAP = 200 // bound the store; pins are cheap but unbounded growth isn't free

/**
 * Normalise a participant name into a pin key. Trim + lowercase so trivial display differences don't
 * fork a contact; empty (no usable name) → '' so the caller skips pinning rather than aliasing every
 * nameless peer onto one key.
 */
export function pinKeyForName(name: string | undefined | null): string {
  return (name ?? '').trim().toLowerCase()
}

/** Parse the stored pins (tolerant: bad/old data → empty, never throws). */
export function parsePins(raw: string | null): SafetyPins {
  if (!raw) return {}
  try {
    const obj = JSON.parse(raw)
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {}
    const out: SafetyPins = {}
    for (const [k, v] of Object.entries(obj)) if (typeof k === 'string' && k && typeof v === 'string') out[k] = v
    return out
  } catch {
    return {}
  }
}

/** Serialize, keeping only the most-recent `cap` pins (oldest insertion order dropped first). */
export function serializePins(pins: SafetyPins, cap = PIN_CAP): string {
  const entries = Object.entries(pins)
  const kept = entries.length > cap ? entries.slice(entries.length - cap) : entries
  return JSON.stringify(Object.fromEntries(kept))
}

/** How a live fingerprint for `key` compares to what's pinned. Empty key ⇒ never pinned. */
export function pinStatus(pins: SafetyPins, key: string, fp: string): PinStatus {
  if (!key) return 'unpinned'
  const pinned = pins[key]
  if (!pinned) return 'unpinned'
  return pinned === fp ? 'match' : 'mismatch'
}

/** Immutably set a pin (re-inserted last so it counts as most-recent). No-op for an empty key. */
export function withPin(pins: SafetyPins, key: string, fp: string): SafetyPins {
  if (!key) return pins
  const { [key]: _drop, ...rest } = pins // remove first so the re-add lands at the end (recency)
  return { ...rest, [key]: fp }
}

/** Immutably remove a pin (e.g. when you withdraw trust). */
export function dropPin(pins: SafetyPins, key: string): SafetyPins {
  if (!key || !(key in pins)) return pins
  const { [key]: _drop, ...rest } = pins
  return rest
}
