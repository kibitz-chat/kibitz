import { describe, it, expect } from 'vitest'
import { parseRoomConfig, roomConfigToJson, SAMPLE_ROOM_CONFIG } from './roomConfig'

describe('parseRoomConfig', () => {
  it('parses a full verified config (host first), normalizing email/domain', () => {
    const r = parseRoomConfig(
      JSON.stringify({
        description: 'Standup',
        access: 'verified',
        clientId: 'XYZ.apps.googleusercontent.com',
        invitees: [
          { name: 'You', method: 'signin', email: 'You@Acme.com' },
          { name: 'Team', method: 'oidc', domain: '@Acme.com' },
          { name: 'Carol', method: 'mail', email: 'carol@x.com', show: true },
        ],
      }),
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.config.description).toBe('Standup')
    expect(r.config.clientId).toBe('XYZ.apps.googleusercontent.com')
    expect(r.config.invitees).toEqual([
      { name: 'You', method: 'signin', email: 'you@acme.com' },
      { name: 'Team', method: 'oidc', domain: 'acme.com' },
      { name: 'Carol', method: 'mail', email: 'carol@x.com', show: true },
    ])
  })

  it('accepts a minimal open room', () => {
    const r = parseRoomConfig('{"access":"open"}')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.config.access).toBe('open')
  })

  it('rejects junk, a bad access, a verified room with no invitees, and bad methods/params', () => {
    expect(parseRoomConfig('not json').ok).toBe(false)
    expect(parseRoomConfig('"a string"').ok).toBe(false)
    expect(parseRoomConfig('{"access":"public"}').ok).toBe(false)
    expect(parseRoomConfig('{"access":"verified","invitees":[]}').ok).toBe(false)
    const badMethod = parseRoomConfig('{"access":"verified","invitees":[{"method":"sms","email":"a@b.com"}]}')
    expect(badMethod.ok).toBe(false)
    const oidcNoDomain = parseRoomConfig('{"access":"verified","invitees":[{"method":"oidc"}]}')
    expect(oidcNoDomain.ok === false && oidcNoDomain.error).toContain('domain')
    const signinNoEmail = parseRoomConfig('{"access":"verified","invitees":[{"method":"signin"}]}')
    expect(signinNoEmail.ok === false && signinNoEmail.error).toContain('email')
  })

  it('round-trips: sample → JSON → parse equals the sample (modulo the placeholder clientId)', () => {
    const json = roomConfigToJson({ ...SAMPLE_ROOM_CONFIG, clientId: 'REAL.apps.googleusercontent.com' })
    const r = parseRoomConfig(json)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.config.access).toBe('verified')
      expect(r.config.invitees?.[0]?.method).toBe('signin')
      expect(r.config.invitees?.length).toBe(3)
    }
  })
})
