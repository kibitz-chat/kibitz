import { describe, it, expect } from 'vitest'
import { createRateLimiter } from './gateRateLimit'

describe('createRateLimiter — throttling short-code guesses', () => {
  it('allows attempts until maxAttempts failures, then locks out', () => {
    const rl = createRateLimiter({ maxAttempts: 3, lockoutMs: 10_000 })
    expect(rl.check('c1', 0).allowed).toBe(true)
    rl.fail('c1', 0)
    rl.fail('c1', 0)
    expect(rl.check('c1', 0).allowed).toBe(true) // 2 fails — still under the limit
    rl.fail('c1', 0) // 3rd fail → locked
    const c = rl.check('c1', 0)
    expect(c.allowed).toBe(false)
    expect(c.retryInMs).toBe(10_000)
  })

  it('frees the key once the lockout window elapses', () => {
    const rl = createRateLimiter({ maxAttempts: 2, lockoutMs: 5_000 })
    rl.fail('c1', 1_000)
    rl.fail('c1', 1_000) // locked at t=1000 until t=6000
    expect(rl.check('c1', 5_999).allowed).toBe(false)
    expect(rl.check('c1', 6_000).allowed).toBe(true) // window elapsed
  })

  it('counts each key independently (one attacker never locks out another joiner)', () => {
    const rl = createRateLimiter({ maxAttempts: 1, lockoutMs: 9_999 })
    rl.fail('attacker', 0) // attacker locked
    expect(rl.check('attacker', 0).allowed).toBe(false)
    expect(rl.check('honest', 0).allowed).toBe(true) // unaffected
  })

  it('clear() forgets a key (call on success / disconnect)', () => {
    const rl = createRateLimiter({ maxAttempts: 1, lockoutMs: 9_999 })
    rl.fail('c1', 0)
    expect(rl.check('c1', 0).allowed).toBe(false)
    rl.clear('c1')
    expect(rl.check('c1', 0).allowed).toBe(true)
  })

  it('gives a fresh window after a lockout elapses (counter resets)', () => {
    const rl = createRateLimiter({ maxAttempts: 2, lockoutMs: 1_000 })
    rl.fail('c1', 0)
    rl.fail('c1', 0) // locked until 1000
    expect(rl.check('c1', 1_000).allowed).toBe(true)
    rl.fail('c1', 1_000) // first fail of the new window — not immediately re-locked
    expect(rl.check('c1', 1_000).allowed).toBe(true)
  })
})
