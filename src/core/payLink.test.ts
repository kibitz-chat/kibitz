import { describe, expect, it } from 'vitest'
import { normalizePayLink } from './payLink'

describe('normalizePayLink — transport-only payment strings', () => {
  it('accepts web checkout URLs as-is (trimmed)', () => {
    expect(normalizePayLink('https://buy.stripe.com/abc')).toEqual({
      display: 'https://buy.stripe.com/abc',
      href: 'https://buy.stripe.com/abc',
    })
    expect(normalizePayLink('  https://paypal.me/alice/20  ')?.href).toBe('https://paypal.me/alice/20')
  })

  it('accepts payment URIs (bitcoin / lightning / upi)', () => {
    expect(normalizePayLink('bitcoin:bc1qxy?amount=0.01')?.href).toMatch(/^bitcoin:/)
    expect(normalizePayLink('lightning:lnbc10u1pabc')?.href).toBe('lightning:lnbc10u1pabc')
    expect(normalizePayLink('upi://pay?pa=alice@bank')?.href).toMatch(/^upi:/)
  })

  it('wraps a bare Lightning invoice / LNURL so a wallet opens it', () => {
    expect(normalizePayLink('lnbc10u1pabc')).toEqual({ display: 'lnbc10u1pabc', href: 'lightning:lnbc10u1pabc' })
    expect(normalizePayLink('LNURL1DP68C')?.href).toBe('lightning:LNURL1DP68C')
  })

  it('rejects unsafe or unknown schemes', () => {
    expect(normalizePayLink('javascript:alert(1)')).toBeNull()
    expect(normalizePayLink('data:text/html,<script>')).toBeNull()
    expect(normalizePayLink('ftp://x')).toBeNull()
    expect(normalizePayLink('just some text')).toBeNull()
  })

  it('rejects empty and over-long input', () => {
    expect(normalizePayLink('   ')).toBeNull()
    expect(normalizePayLink(`https://x.com/${'a'.repeat(600)}`)).toBeNull()
  })
})
