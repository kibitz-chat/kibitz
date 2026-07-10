import { describe, it, expect, afterEach } from 'vitest'
import { buildTurnEndpoint, setTurnHost, getTurnEndpoint } from './turnConfig'

describe('buildTurnEndpoint', () => {
  it('returns the same-origin path when blank/null', () => {
    expect(buildTurnEndpoint('')).toBe('/api/turn')
    expect(buildTurnEndpoint('   ')).toBe('/api/turn')
    expect(buildTurnEndpoint(null)).toBe('/api/turn')
    expect(buildTurnEndpoint(undefined)).toBe('/api/turn')
  })

  it('builds a secure URL for a bare host', () => {
    expect(buildTurnEndpoint('turn.example.com')).toBe('https://turn.example.com/api/turn')
  })

  it('strips scheme and trailing slashes from a full origin', () => {
    expect(buildTurnEndpoint('https://turn.example.com/')).toBe('https://turn.example.com/api/turn')
    expect(buildTurnEndpoint('http://turn.example.com///')).toBe('https://turn.example.com/api/turn')
  })
})

describe('setTurnHost / getTurnEndpoint', () => {
  afterEach(() => setTurnHost(null))

  it('defaults to the same-origin endpoint', () => {
    expect(getTurnEndpoint()).toBe('/api/turn')
  })

  it('points at the configured provider once set', () => {
    setTurnHost('turn.acme.dev')
    expect(getTurnEndpoint()).toBe('https://turn.acme.dev/api/turn')
  })

  it('clearing (null/blank) reverts to same-origin', () => {
    setTurnHost('turn.acme.dev')
    setTurnHost('   ')
    expect(getTurnEndpoint()).toBe('/api/turn')
  })
})
