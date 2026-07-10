import { describe, expect, it } from 'vitest'
import { sameIdentities } from './useIdentity'
import type { VerifiedIdentity } from '../core/identity'

const id = (email: string, sub = 's'): VerifiedIdentity => ({ email, emailVerified: true, sub, iss: 'x' })

describe('sameIdentities', () => {
  it('is true for identical maps (same emails + subs)', () => {
    expect(sameIdentities({ a: id('x@y'), b: null }, { a: id('x@y'), b: null })).toBe(true)
  })
  it('is false when an email changes', () => {
    expect(sameIdentities({ a: id('x@y') }, { a: id('z@y') })).toBe(false)
  })
  it('is false when sub changes (same email, different account)', () => {
    expect(sameIdentities({ a: id('x@y', 's1') }, { a: id('x@y', 's2') })).toBe(false)
  })
  it('is false when a peer appears/disappears or flips null↔verified', () => {
    expect(sameIdentities({ a: id('x@y') }, { a: id('x@y'), b: null })).toBe(false)
    expect(sameIdentities({ a: null }, { a: id('x@y') })).toBe(false)
  })
})
