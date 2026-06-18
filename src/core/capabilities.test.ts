import { describe, expect, it } from 'vitest'
import {
  ALL_ACT,
  ALL_PERCEIVE,
  canAct,
  canPerceive,
  defaultGrant,
  effectiveGrant,
  fullGrant,
  grantSummary,
  intersectGrant,
  isExpired,
  sanitizeGrant,
  type Grant,
} from './capabilities'

describe('defaultGrant — humans full, agents least-privilege', () => {
  it('an agent defaults to read-only: perceives the room (chat/roster/directed), acts nothing, no media', () => {
    const g = defaultGrant('agent')
    expect(g.perceive.sort()).toEqual(['read-chat', 'read-roster', 'receive-directed'])
    expect(g.act).toEqual([])
    expect(canPerceive(g, 'receive-directed')).toBe(true) // e.g. a kibitzer's hand via sendTo
    expect(canPerceive(g, 'see-screen')).toBe(false) // media is opt-in
    expect(canAct(g, 'send-chat')).toBe(false) // acting is opt-in
  })
  it('a human defaults to the full grant', () => {
    const g = defaultGrant('human')
    expect(g.perceive.sort()).toEqual([...ALL_PERCEIVE].sort())
    expect(g.act.sort()).toEqual([...ALL_ACT].sort())
  })
})

describe('canPerceive / canAct', () => {
  const g: Grant = { perceive: ['read-chat'], act: ['send-chat'] }
  it('is true only for granted capabilities', () => {
    expect(canPerceive(g, 'read-chat')).toBe(true)
    expect(canPerceive(g, 'see-screen')).toBe(false)
    expect(canAct(g, 'send-chat')).toBe(true)
    expect(canAct(g, 'act')).toBe(false)
  })
  it('is false for a null/absent grant', () => {
    expect(canPerceive(null, 'read-chat')).toBe(false)
    expect(canAct(undefined, 'send-chat')).toBe(false)
  })
})

describe('expiry — a stale grant confers nothing', () => {
  const g: Grant = { perceive: ['read-chat'], act: ['send-chat'], expiresAt: 1000 }
  it('isExpired flips at the deadline', () => {
    expect(isExpired(g, 999)).toBe(false)
    expect(isExpired(g, 1000)).toBe(true)
    expect(isExpired({ perceive: [], act: [] }, 9e9)).toBe(false) // no expiry set
  })
  it('effectiveGrant empties an expired grant, passes through a live one', () => {
    expect(effectiveGrant(g, 1000)).toEqual({ perceive: [], act: [] })
    expect(effectiveGrant(g, 999)).toBe(g)
    expect(effectiveGrant(null, 5)).toEqual({ perceive: [], act: [] })
  })
})

describe('sanitizeGrant — never gain a capability from a malformed wire grant', () => {
  it('drops unknown caps + de-dupes', () => {
    const g = sanitizeGrant({ perceive: ['read-chat', 'read-chat', 'bogus' as never], act: ['fly' as never, 'speak'] })
    expect(g.perceive).toEqual(['read-chat'])
    expect(g.act).toEqual(['speak'])
  })
  it('clamps the backend string and coerces egress/expiry', () => {
    const g = sanitizeGrant({ perceive: [], act: [], backend: 'x'.repeat(200), egress: 1 as never, expiresAt: -5 })
    expect(g.backend?.length).toBe(80)
    expect(g.egress).toBe(true)
    expect(g.expiresAt).toBeUndefined() // negative dropped
  })
  it('handles null/garbage input', () => {
    expect(sanitizeGrant(null)).toEqual({ perceive: [], act: [] })
  })
})

describe('intersectGrant — granted = requested ∩ allowed (no surprise powers)', () => {
  it('keeps only capabilities present in BOTH', () => {
    const request: Grant = { perceive: ['read-chat', 'see-screen'], act: ['send-chat', 'act'], backend: 'claude', egress: true }
    const allowed: Grant = { perceive: ['read-chat'], act: ['send-chat'] } // host withholds see-screen + act
    const g = intersectGrant(request, allowed)
    expect(g.perceive).toEqual(['read-chat'])
    expect(g.act).toEqual(['send-chat'])
    expect(g.backend).toBe('claude') // disclosure carries from the request
    expect(g.egress).toBe(true)
  })
  it('never grants more than requested even if the host allows more', () => {
    const request: Grant = { perceive: ['read-chat'], act: [] }
    const g = intersectGrant(request, fullGrant())
    expect(g.perceive).toEqual(['read-chat'])
    expect(g.act).toEqual([])
  })
  it('takes the soonest expiry of the two', () => {
    const g = intersectGrant({ perceive: [], act: [], expiresAt: 500 }, { perceive: [], act: [], expiresAt: 200 })
    expect(g.expiresAt).toBe(200)
  })
})

describe('grantSummary — the can/cannot split for the consent sheet', () => {
  it('partitions all capabilities by what the grant confers', () => {
    const { can, cannot } = grantSummary({ perceive: ['read-chat'], act: ['send-chat'] })
    expect(can.sort()).toEqual(['read-chat', 'send-chat'])
    expect(cannot).toContain('see-screen')
    expect(cannot).toContain('act')
    expect(can.length + cannot.length).toBe(ALL_PERCEIVE.length + ALL_ACT.length)
  })
})
