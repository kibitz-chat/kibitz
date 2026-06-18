import { describe, it, expect, vi, afterEach } from 'vitest'
import { grantFromUrl, linkWithGrant, setGrant, getGrant, requestRoomGrant } from './grant'

const ok = (body: unknown) => ({ ok: true, json: async () => body }) as unknown as Response

describe('grantFromUrl', () => {
  it('reads the ?grant= token', () => {
    expect(grantFromUrl('https://kibitz.chat/?grant=body.sig#ember-x9')).toBe('body.sig')
  })
  it('returns null when absent, blank, or unparseable', () => {
    expect(grantFromUrl('https://kibitz.chat/#ember-x9')).toBeNull()
    expect(grantFromUrl('https://kibitz.chat/?grant=%20%20#r')).toBeNull()
    expect(grantFromUrl('not a url')).toBeNull()
  })
})

describe('linkWithGrant', () => {
  it('adds ?grant= and preserves the room hash', () => {
    expect(linkWithGrant('https://kibitz.chat/#ember-x9', 'body.sig')).toBe('https://kibitz.chat/?grant=body.sig#ember-x9')
  })
  it('strips the param when blank', () => {
    expect(linkWithGrant('https://kibitz.chat/?grant=body.sig#r', '')).toBe('https://kibitz.chat/#r')
  })
})

describe('setGrant / getGrant', () => {
  afterEach(() => setGrant(null))
  it('round-trips, and blank clears it', () => {
    setGrant('body.sig')
    expect(getGrant()).toBe('body.sig')
    setGrant('   ')
    expect(getGrant()).toBeNull()
  })
})

describe('requestRoomGrant', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('returns the minted grant on success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ grant: 'b.s', exp: 1781000000 })))
    expect(await requestRoomGrant('ember-x9', 'lic-key')).toEqual({ grant: 'b.s', exp: 1781000000 })
  })
  it('returns null when dormant / not entitled', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ configured: false })))
    expect(await requestRoomGrant('ember-x9', 'lic-key')).toBeNull()
  })
  it('returns null on network failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline')
      }),
    )
    expect(await requestRoomGrant('ember-x9', 'lic-key')).toBeNull()
  })
})
