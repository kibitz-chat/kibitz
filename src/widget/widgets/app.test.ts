import { describe, expect, it } from 'vitest'
import { type AppConfig, appTierEnabled, clampAppHeight, safeAppPayload, sanitizeApp } from './app'

const OFF: AppConfig = { origins: [], allowHtml: false }
const URLS: AppConfig = { origins: ['example.com'], allowHtml: false }
const HTML: AppConfig = { origins: [], allowHtml: true }

describe('kbz.app (OPEN tier) — off by default + author-allowlisted', () => {
  it('renders NOTHING with no config (the safe default)', () => {
    expect(sanitizeApp({ url: 'https://example.com/app' }, OFF)).toBeNull()
    expect(sanitizeApp({ html: '<b>hi</b>' }, OFF)).toBeNull()
    expect(sanitizeApp(null, OFF)).toBeNull()
    expect(appTierEnabled(OFF)).toBe(false)
  })
  it('accepts ONLY an allowlisted https origin (+ subdomains), rejects others / http', () => {
    expect(sanitizeApp({ url: 'https://example.com/a', height: 500 }, URLS)).toMatchObject({ mode: 'url', height: 500 })
    expect(sanitizeApp({ url: 'https://sub.example.com/a' }, URLS)?.mode).toBe('url')
    expect(sanitizeApp({ url: 'https://evil.com/a' }, URLS)).toBeNull()
    expect(sanitizeApp({ url: 'http://example.com/a' }, URLS)).toBeNull() // https required
    expect(sanitizeApp({ url: 'https://example.com.evil.com/a' }, URLS)).toBeNull() // suffix-spoof
    expect(appTierEnabled(URLS)).toBe(true)
  })
  it('accepts raw html ONLY when explicitly enabled, and never accepts a url without an allowlist', () => {
    expect(sanitizeApp({ html: '<b>hi</b>' }, HTML)).toMatchObject({ mode: 'html' })
    expect(sanitizeApp({ url: 'https://example.com/a' }, HTML)).toBeNull() // no origins ⇒ url still off
    expect(appTierEnabled(HTML)).toBe(true)
  })
  it('clamps height + bounds the src', () => {
    expect(sanitizeApp({ url: 'https://example.com/a', height: 99999 }, URLS)?.height).toBe(1200)
    expect(sanitizeApp({ url: 'https://example.com/a', height: -5 }, URLS)?.height).toBe(80)
  })
})

describe('kbz.app bridge helpers', () => {
  it('clampAppHeight bounds a resize request', () => {
    expect(clampAppHeight(500)).toBe(500)
    expect(clampAppHeight(5000)).toBe(1200)
    expect(clampAppHeight('x')).toBeNull()
  })
  it('safeAppPayload keeps small JSON, drops functions / oversize', () => {
    expect(safeAppPayload({ a: 1, b: 'x' })).toEqual({ a: 1, b: 'x' })
    expect(safeAppPayload({ f: () => 1 })).toEqual({}) // function dropped by JSON
    expect(safeAppPayload('z'.repeat(9000))).toBeNull() // oversize
  })
})
