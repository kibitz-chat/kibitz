import { describe, it, expect } from 'vitest'
import { buildHelpPrompt, HELP_SOURCES } from './helpPrompt'

describe('buildHelpPrompt', () => {
  const p = buildHelpPrompt()

  it('frames the assistant as a Kibitz support agent', () => {
    expect(p).toMatch(/support assistant for \*\*Kibitz\*\*/)
  })

  it('tells the model to read the live sources (assumes web access)', () => {
    expect(p).toContain(HELP_SOURCES.full)
    expect(p).toContain(HELP_SOURCES.manual)
    expect(p).toMatch(/read the official sources/i)
    expect(p).toMatch(/follow links/i) // may open additional pages as needed
  })

  it('points the model at the live site and the open-source repo to read', () => {
    expect(p).toContain(HELP_SOURCES.site)
    expect(p).toContain(HELP_SOURCES.github)
    expect(p).toMatch(/open source/i)
  })

  it('includes the sibling open-source repos (Whist + Offline mode)', () => {
    expect(p).toContain(HELP_SOURCES.whist)
    expect(p).toContain(HELP_SOURCES.offline)
    expect(p).toContain(HELP_SOURCES.whistSite)
    expect(p).toContain(HELP_SOURCES.offlineGuide)
  })

  it('keeps the privacy claim exact and forbids inventing features', () => {
    expect(p).toContain('end-to-end encrypted')
    expect(p).toMatch(/no media server/i)
    expect(p).toMatch(/don't invent/i)
  })

  it('points to the human-facing fallback (docs)', () => {
    expect(p).toContain(HELP_SOURCES.docs)
  })

  it('kicks off the conversation rather than dumping text', () => {
    expect(p).toMatch(/greet me/i)
  })
})
