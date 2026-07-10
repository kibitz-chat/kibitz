import { describe, expect, it } from 'vitest'
import { checkRetired, decideRetired, fetchFloor, isBelow } from './minVersion'

describe('isBelow — semver floor comparison', () => {
  it('compares major.minor.patch', () => {
    expect(isBelow('0.1.0', '0.2.0')).toBe(true)
    expect(isBelow('0.1.9', '0.2.0')).toBe(true)
    expect(isBelow('1.0.0', '0.9.9')).toBe(false)
    expect(isBelow('0.2.0', '0.2.0')).toBe(false) // equal is NOT below
    expect(isBelow('0.2.1', '0.2.0')).toBe(false)
  })
  it('tolerates v-prefix and junk', () => {
    expect(isBelow('v0.1.0', '0.2.0')).toBe(true)
    expect(isBelow('0.1.0-beta', '0.2.0')).toBe(true)
    expect(isBelow('', '0.0.1')).toBe(true) // unknown ⇒ 0.0.0
  })
})

describe('decideRetired — pure decision', () => {
  it('retires a build below the floor (carries the message)', () => {
    expect(decideRetired('0.1.0', { min: '0.2.0', message: 'upgrade' })).toEqual({
      retired: true,
      min: '0.2.0',
      message: 'upgrade',
    })
  })
  it('does NOT retire at/above the floor', () => {
    expect(decideRetired('0.2.0', { min: '0.2.0' })).toEqual({ retired: false })
    expect(decideRetired('0.3.0', { min: '0.2.0' })).toEqual({ retired: false })
  })
  it('fails OPEN with no floor / no min', () => {
    expect(decideRetired('0.1.0', null)).toEqual({ retired: false })
    expect(decideRetired('0.1.0', {})).toEqual({ retired: false })
  })
})

const res = (ok: boolean, body: unknown): Response =>
  ({ ok, json: async () => body }) as unknown as Response

describe('fetchFloor / checkRetired — fail-open I/O', () => {
  it('reads a floor and retires an old build', async () => {
    const fake = (async () => res(true, { min: '0.2.0', message: 'retired for CVE-x' })) as unknown as typeof fetch
    expect(await checkRetired('0.1.0', '/min-version.json', fake)).toEqual({
      retired: true,
      min: '0.2.0',
      message: 'retired for CVE-x',
    })
  })
  it('fails OPEN on a network error (a blip must never brick a call)', async () => {
    const boom = (async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    expect(await fetchFloor('/min-version.json', boom)).toBeNull()
    expect(await checkRetired('0.1.0', '/min-version.json', boom)).toEqual({ retired: false })
  })
  it('fails OPEN on a 404 (no floor deployed)', async () => {
    const notFound = (async () => res(false, null)) as unknown as typeof fetch
    expect(await checkRetired('0.1.0', '/min-version.json', notFound)).toEqual({ retired: false })
  })
})
