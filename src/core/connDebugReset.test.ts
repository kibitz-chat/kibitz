// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest'
import { clearStaleDebug, debugEnabled } from './connDebug'

// Old testers who 5-tapped the conn-debug overlay ON have kbz.debug='1' persisted, so the app re-opens with
// capture/overlay armed. clearStaleDebug() (run at install, before anything reads debugEnabled) wipes that flag
// ONCE per browser per RESET_EPOCH, without permanently disabling the feature.
describe('sticky debug one-time reset (clearStaleDebug)', () => {
  beforeEach(() => localStorage.clear())

  it('wipes a stale kbz.debug flag on the first load after an epoch bump', () => {
    localStorage.setItem('kbz.debug', '1')
    expect(debugEnabled()).toBe(true)
    clearStaleDebug()
    expect(debugEnabled()).toBe(false)
    expect(localStorage.getItem('kbz.debug')).toBeNull()
  })

  it('runs once per epoch — a later DELIBERATE re-enable is not clobbered', () => {
    clearStaleDebug() // first load stamps the epoch
    localStorage.setItem('kbz.debug', '1') // user turns debug back on on purpose
    clearStaleDebug() // a subsequent load must leave it alone
    expect(debugEnabled()).toBe(true)
  })

  it('is a harmless no-op when nothing was stored', () => {
    clearStaleDebug()
    expect(debugEnabled()).toBe(false)
    expect(localStorage.getItem('kbz.debug')).toBeNull()
  })
})
