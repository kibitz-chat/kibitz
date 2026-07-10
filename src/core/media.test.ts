import { describe, it, expect } from 'vitest'
import { micErrorMessage } from './media'

describe('micErrorMessage', () => {
  it('a true block routes to the right place — iOS Settings in the installed app, browser settings in a tab', () => {
    expect(micErrorMessage('NotAllowedError', true)).toMatch(/iOS Settings → Safari/)
    expect(micErrorMessage('NotAllowedError', false)).toMatch(/browser settings/)
    expect(micErrorMessage('SecurityError', true)).toMatch(/iOS Settings/)
  })

  it('distinguishes busy vs no-mic from "blocked" (the old catch-all)', () => {
    expect(micErrorMessage('NotReadableError')).toMatch(/busy in another app/)
    expect(micErrorMessage('AbortError')).toMatch(/busy in another app/)
    expect(micErrorMessage('NotFoundError')).toMatch(/No microphone/)
    expect(micErrorMessage('OverconstrainedError')).toMatch(/No microphone/)
  })

  it('falls back to a named generic for an unknown cause', () => {
    expect(micErrorMessage('WeirdError')).toMatch(/WeirdError/)
    expect(micErrorMessage('')).toBe('Couldn’t open the microphone.')
  })
})
