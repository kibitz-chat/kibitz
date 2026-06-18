// Throttle short-code guessing at the door. A short, say-aloud join code is low-entropy,
// so the ONLY thing keeping it safe is that an attacker must guess ONLINE against the
// authority — which counts failures per connection and locks out after a few tries. (The
// signed-invite option needs no limiter: minting a token is forging ECDSA, not guessing.)
//
// Pure + clock-injected (every method takes `now` epoch-ms) so it's deterministic to test
// and has no timers of its own — the caller drives it from the gate's verify path.

export interface RateLimiter {
  /** May this key attempt right now? If locked out, `retryInMs` says for how long. */
  check(key: string, now: number): { allowed: boolean; retryInMs: number }
  /** Record a failed attempt (advances toward lockout). */
  fail(key: string, now: number): void
  /** Forget a key — call on success or when the connection drops. */
  clear(key: string): void
}

/**
 * After `maxAttempts` failures a key is locked for `lockoutMs`; when the lockout elapses
 * the counter resets and it gets another window. Keyed by whatever the caller passes
 * (a presence connection id), so one attacker's lockout never affects another joiner.
 */
export function createRateLimiter(opts: { maxAttempts: number; lockoutMs: number }): RateLimiter {
  const state = new Map<string, { fails: number; lockedUntil: number }>()
  return {
    check(key, now) {
      const s = state.get(key)
      if (s && s.lockedUntil > now) return { allowed: false, retryInMs: s.lockedUntil - now }
      return { allowed: true, retryInMs: 0 }
    },
    fail(key, now) {
      const s = state.get(key) ?? { fails: 0, lockedUntil: 0 }
      const fails = s.fails + 1
      if (fails >= opts.maxAttempts) {
        // Lock out and start a fresh window so the next chance comes only after the wait.
        state.set(key, { fails: 0, lockedUntil: now + opts.lockoutMs })
      } else {
        state.set(key, { fails, lockedUntil: s.lockedUntil })
      }
    },
    clear(key) {
      state.delete(key)
    },
  }
}
