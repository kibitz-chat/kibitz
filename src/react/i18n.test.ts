import { describe, it, expect } from 'vitest'
import { wt, wlang, isRtl, noteAgentLang } from './i18n'

// No `l=` in the test URL → the call defaults to English; the agent's advertised lang then overrides it.
// Ordered on purpose: the English assertions run BEFORE noteAgentLang flips the module to Hebrew.
describe('widget i18n', () => {
  it('defaults to English — the English text passes through unchanged', () => {
    expect(wlang()).toBe('en')
    expect(isRtl()).toBe(false)
    expect(wt('Listening')).toBe('Listening')
    expect(wt('Leave call')).toBe('Leave call')
    expect(wt('~{n} min left', { n: 5 })).toBe('~5 min left')
  })

  it('an agent-advertised lang switches the chrome, with English as the fallback for unknown keys', () => {
    noteAgentLang('he')
    expect(wlang()).toBe('he')
    expect(isRtl()).toBe(true)
    expect(wt('Listening')).toBe('מקשיב')
    expect(wt('listening')).toBe('מקשיב') // tile activity label (lowercase key)
    expect(wt('~{n} min left', { n: 5 })).toBe('~5 דק׳ נותרו') // interpolation after lookup
    expect(wt('{name} controls', { name: 'צייר' })).toBe('בקרות צייר')
    expect(wt('a string with no translation')).toBe('a string with no translation') // fall through to English
  })

  it('ignores an unsupported lang code (keeps the last good language)', () => {
    noteAgentLang('xx') // not in the table → no-op
    expect(wlang()).toBe('he')
    noteAgentLang('') // empty → no-op
    expect(wlang()).toBe('he')
  })

  it('localizes to any of the 17 supported languages, with Arabic right-to-left', () => {
    noteAgentLang('ar')
    expect(wlang()).toBe('ar')
    expect(isRtl()).toBe(true) // Arabic joins Hebrew as RTL
    expect(wt('Listening')).toBe('يستمع')
    expect(wt('~{n} min left', { n: 5 })).toBe('يتبقّى ~5 دقيقة') // token survives translation + interpolation
    noteAgentLang('ko')
    expect(wlang()).toBe('ko')
    expect(isRtl()).toBe(false)
    expect(wt('Listening')).toBe('듣는 중')
  })
})
