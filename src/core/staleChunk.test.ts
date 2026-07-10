import { describe, it, expect } from 'vitest'
import { isStaleChunkError, shouldReloadNow, staleChunkAction } from './staleChunk'

describe('isStaleChunkError', () => {
  it('detects a failed dynamic-import / chunk-load across browsers + the SPA-fallback MIME case', () => {
    expect(isStaleChunkError(new Error('Failed to fetch dynamically imported module: https://x/assets/a.js'))).toBe(true)
    expect(isStaleChunkError(new Error('error loading dynamically imported module'))).toBe(true)
    expect(isStaleChunkError(new Error('Importing a module script failed.'))).toBe(true)
    expect(isStaleChunkError(new Error('Failed to load module script: Expected a JavaScript module script but the server responded with a MIME type of text/html'))).toBe(true)
    const e = new Error('Loading chunk 42 failed'); e.name = 'ChunkLoadError'
    expect(isStaleChunkError(e)).toBe(true)
    expect(isStaleChunkError({ name: 'ChunkLoadError' })).toBe(true) // name alone, no message
  })

  it('ignores unrelated errors and falsy reasons (no spurious reloads)', () => {
    expect(isStaleChunkError(new Error('NetworkError when attempting to fetch resource'))).toBe(false)
    expect(isStaleChunkError(new Error('getUserMedia permission denied'))).toBe(false)
    expect(isStaleChunkError('a plain string')).toBe(false)
    expect(isStaleChunkError(null)).toBe(false)
    expect(isStaleChunkError(undefined)).toBe(false)
  })
})

describe('shouldReloadNow (reload-loop guard)', () => {
  it('reloads when the last reload was outside the cooldown', () => {
    expect(shouldReloadNow(0, 20_000, 10_000)).toBe(true)
    expect(shouldReloadNow(1_000, 11_001, 10_000)).toBe(true)
  })
  it('refuses a second reload inside the cooldown (the chunk is truly gone → would loop)', () => {
    expect(shouldReloadNow(5_000, 9_000, 10_000)).toBe(false)
    expect(shouldReloadNow(5_000, 5_000, 10_000)).toBe(false)
  })
})

describe('staleChunkAction (never reload out from under a live call)', () => {
  it('reloads now when idle + outside the cooldown', () => {
    expect(staleChunkAction(false, 0, 20_000, 10_000)).toBe('reload')
  })
  it('DEFERS while a call is live (waits for it to end) instead of dropping the call', () => {
    expect(staleChunkAction(true, 0, 20_000, 10_000)).toBe('defer')
  })
  it('skips inside the cooldown regardless of call state (loop guard wins)', () => {
    expect(staleChunkAction(false, 5_000, 9_000, 10_000)).toBe('skip')
    expect(staleChunkAction(true, 5_000, 9_000, 10_000)).toBe('skip') // don't even defer — the chunk is truly gone
  })
})
