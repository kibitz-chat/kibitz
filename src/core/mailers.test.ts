import { describe, expect, it } from 'vitest'
import { configuredMailers, parseFrom, sendWithRotation, type MailerEnv, type MailMessage, type Provider } from './mailers'

const MSG: MailMessage = { to: 't@x.com', from: 'Kibitz <noreply@x.com>', subject: 's', text: 'b' }

// A fake provider that records that it was tried, then succeeds or fails.
const fake = (name: string, behavior: 'ok' | 'fail', calls: string[]): Provider => ({
  name,
  isConfigured: () => true,
  send: async () => {
    calls.push(name)
    if (behavior === 'fail') throw new Error(`${name} boom`)
  },
})

describe('parseFrom', () => {
  it('parses "Name <email>"', () => {
    expect(parseFrom('Kibitz <noreply@mail.kibitz.chat>')).toEqual({ name: 'Kibitz', email: 'noreply@mail.kibitz.chat' })
  })
  it('parses a bare email (no name)', () => {
    expect(parseFrom('noreply@x.com')).toEqual({ name: '', email: 'noreply@x.com' })
  })
})

describe('configuredMailers — only providers whose key is bound, in rotation order', () => {
  const A: Provider = { name: 'a', isConfigured: (e: MailerEnv) => !!e.RESEND_API_KEY, send: async () => {} }
  const B: Provider = { name: 'b', isConfigured: (e: MailerEnv) => !!e.BREVO_API_KEY, send: async () => {} }
  it('keeps configured providers, preserving order', () => {
    expect(configuredMailers({ RESEND_API_KEY: '1', BREVO_API_KEY: '1' }, [A, B]).map((p) => p.name)).toEqual(['a', 'b'])
    expect(configuredMailers({ BREVO_API_KEY: '1' }, [A, B]).map((p) => p.name)).toEqual(['b'])
    expect(configuredMailers({}, [A, B])).toEqual([])
  })
})

describe('sendWithRotation — fall through until one succeeds', () => {
  it('returns the first success and does not try the rest', async () => {
    const calls: string[] = []
    const name = await sendWithRotation({}, MSG, [fake('p1', 'ok', calls), fake('p2', 'ok', calls)])
    expect(name).toBe('p1')
    expect(calls).toEqual(['p1'])
  })
  it('falls through a failing provider to the next', async () => {
    const calls: string[] = []
    const name = await sendWithRotation({}, MSG, [fake('p1', 'fail', calls), fake('p2', 'ok', calls)])
    expect(name).toBe('p2')
    expect(calls).toEqual(['p1', 'p2'])
  })
  it('throws when EVERY provider fails (and tried them all)', async () => {
    const calls: string[] = []
    await expect(sendWithRotation({}, MSG, [fake('p1', 'fail', calls), fake('p2', 'fail', calls)])).rejects.toThrow()
    expect(calls).toEqual(['p1', 'p2'])
  })
  it('throws when no providers are configured', async () => {
    await expect(sendWithRotation({}, MSG, [])).rejects.toThrow('no mailer configured')
  })
})
