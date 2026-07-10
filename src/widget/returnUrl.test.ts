import { describe, it, expect } from 'vitest'
import { safeReturnUrl } from './returnUrl'

const HOSTS = ['witz.chat', 'www.witz.chat']

describe('safeReturnUrl', () => {
  it('allows an https URL whose host is exactly allowlisted', () => {
    expect(safeReturnUrl('https://witz.chat/birthday?room=abc', HOSTS)).toBe('https://witz.chat/birthday?room=abc')
    expect(safeReturnUrl('https://www.witz.chat/birthday?room=abc&lang=he', HOSTS)).toBe('https://www.witz.chat/birthday?room=abc&lang=he')
  })

  it('rejects a non-allowlisted host, incl. a lookalike suffix (open-redirect guard)', () => {
    expect(safeReturnUrl('https://evil.com/phish', HOSTS)).toBeNull()
    expect(safeReturnUrl('https://witz.chat.evil.com/', HOSTS)).toBeNull()
    expect(safeReturnUrl('https://notwitz.chat/', HOSTS)).toBeNull()
  })

  it('rejects non-http(s) schemes', () => {
    expect(safeReturnUrl('javascript:alert(1)', HOSTS)).toBeNull()
    expect(safeReturnUrl('data:text/html,x', HOSTS)).toBeNull()
    expect(safeReturnUrl('file:///etc/passwd', HOSTS)).toBeNull()
  })

  it('is off when there is no allowlist, no url, or the url is unparseable', () => {
    expect(safeReturnUrl('https://witz.chat/', undefined)).toBeNull()
    expect(safeReturnUrl('https://witz.chat/', [])).toBeNull()
    expect(safeReturnUrl(null, HOSTS)).toBeNull()
    expect(safeReturnUrl('not a url', HOSTS)).toBeNull()
  })
})
