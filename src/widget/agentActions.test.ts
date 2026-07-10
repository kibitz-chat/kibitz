import { describe, it, expect } from 'vitest'
import { liveAgentMenus, menusFor, visibleMenus, actionMessage, agentsHubVisible, parseTheme, AGENT_ACTIONS_SCHEMA, ACTION_MSG_KIND } from './agentActions'
import type { SchemaInfo } from '../react/useCall'

const manifest = {
  kind: 'agent-actions@1',
  agent: 'Kibitzer 🧐',
  actions: [
    { id: 'summarize', label: 'Summarize', desc: 'Recap', chat: ['/summarize'] },
    { id: 'song', label: 'Summarize with a song' },
  ],
}
const schema = (from: string, name = AGENT_ACTIONS_SCHEMA, doc: unknown = manifest): SchemaInfo => ({ from, name, version: '1', schema: doc })

describe('liveAgentMenus', () => {
  it('builds a menu for an agent that is present', () => {
    const menus = liveAgentMenus([schema('agent1')], new Set(['agent1', 'me']))
    expect(menus).toHaveLength(1)
    expect(menus[0].from).toBe('agent1')
    expect(menus[0].agent).toBe('Kibitzer 🧐')
    expect(menus[0].actions.map((a) => a.id)).toEqual(['summarize', 'song'])
  })

  it('drops an agent that has left (not in presentIds)', () => {
    expect(liveAgentMenus([schema('gone')], new Set(['me']))).toHaveLength(0)
  })

  it('parses the optional wake hint (bounded), and omits it when absent or malformed', () => {
    const withWake = liveAgentMenus([schema('a1', AGENT_ACTIONS_SCHEMA, { ...manifest, wake: ['hey friend', 'hey Tutor', 5] })], new Set(['a1']))
    expect(withWake[0].wake).toEqual(['hey friend', 'hey Tutor'])
    expect(liveAgentMenus([schema('a1')], new Set(['a1']))[0].wake).toBeUndefined()
    expect(liveAgentMenus([schema('a1', AGENT_ACTIONS_SCHEMA, { ...manifest, wake: 'nope' })], new Set(['a1']))[0].wake).toBeUndefined()
  })

  it('parses the optional manifest lang (so the UI can localize its own chrome), omitting it when absent', () => {
    expect(liveAgentMenus([schema('a1', AGENT_ACTIONS_SCHEMA, { ...manifest, lang: 'he' })], new Set(['a1']))[0].lang).toBe('he')
    expect(liveAgentMenus([schema('a1')], new Set(['a1']))[0].lang).toBeUndefined()
    expect(liveAgentMenus([schema('a1', AGENT_ACTIONS_SCHEMA, { ...manifest, lang: 42 })], new Set(['a1']))[0].lang).toBeUndefined()
  })

  it('ignores schemas that are not agent-actions', () => {
    expect(liveAgentMenus([schema('a1', 'cobrowse')], new Set(['a1']))).toHaveLength(0)
  })

  it('drops a malformed manifest (no valid actions)', () => {
    expect(liveAgentMenus([schema('a1', AGENT_ACTIONS_SCHEMA, { actions: [{ id: 1 }] })], new Set(['a1']))).toHaveLength(0)
    expect(liveAgentMenus([schema('a1', AGENT_ACTIONS_SCHEMA, 'nope')], new Set(['a1']))).toHaveLength(0)
  })

  it('keeps one menu per publisher (latest wins) and only valid action fields', () => {
    const menus = liveAgentMenus([schema('a1'), schema('a1')], new Set(['a1']))
    expect(menus).toHaveLength(1)
    const summarize = menus[0].actions.find((a) => a.id === 'summarize')!
    expect(summarize.desc).toBe('Recap')
    expect(summarize.chat).toEqual(['/summarize'])
  })

  it('defaults the agent name when missing', () => {
    const menus = liveAgentMenus([schema('a1', AGENT_ACTIONS_SCHEMA, { actions: [{ id: 'x', label: 'X' }] })], new Set(['a1']))
    expect(menus[0].agent).toBe('Agent')
  })

  it('reads ui.placement, defaulting to chat for back-compat', () => {
    const withUi = { ...manifest, ui: { placement: 'stage' } }
    expect(liveAgentMenus([schema('a1', AGENT_ACTIONS_SCHEMA, withUi)], new Set(['a1']))[0].placement).toBe('stage')
    // no ui → chat (the original surface)
    expect(liveAgentMenus([schema('a2')], new Set(['a2']))[0].placement).toBe('chat')
    // unknown value → chat
    const bad = { ...manifest, ui: { placement: 'nope' } }
    expect(liveAgentMenus([schema('a3', AGENT_ACTIONS_SCHEMA, bad)], new Set(['a3']))[0].placement).toBe('chat')
  })
})

describe('parseTheme', () => {
  it('defaults every knob when no theme is given', () => {
    expect(parseTheme(undefined)).toEqual({ chip: 'solid', size: 'normal', button: 'icon' })
  })

  it('accepts valid values and clamps enums', () => {
    expect(parseTheme({ chip: 'outline', size: 'large', button: 'labeled', icon: '🦉' })).toEqual({
      chip: 'outline',
      size: 'large',
      button: 'labeled',
      icon: '🦉',
    })
    // unknown enum values fall back to defaults
    expect(parseTheme({ chip: 'sparkly', size: 'huge', button: 'nope' })).toMatchObject({ chip: 'solid', size: 'normal', button: 'icon' })
  })

  it('only accepts a safe color for accent (CSS-injection guard)', () => {
    expect(parseTheme({ accent: '#7c3aed' }).accent).toBe('#7c3aed')
    expect(parseTheme({ accent: 'hsl(265 83% 58%)' }).accent).toBe('hsl(265 83% 58%)')
    expect(parseTheme({ accent: 'red; background:url(x)' }).accent).toBeUndefined()
    expect(parseTheme({ accent: 'red' }).accent).toBeUndefined() // named colors not allowed (keep the surface tiny)
    expect(parseTheme({ accent: 'url(javascript:1)' }).accent).toBeUndefined()
  })

  it('caps the icon length and is parsed into the menu', () => {
    const m = liveAgentMenus([schema('a1', AGENT_ACTIONS_SCHEMA, { ...manifest, ui: { theme: { accent: '#abc', chip: 'pill' } } })], new Set(['a1']))
    expect(m[0].theme.accent).toBe('#abc')
    expect(m[0].theme.chip).toBe('pill')
  })
})

describe('menusFor', () => {
  it('keeps only menus that asked for a given placement', () => {
    const menus = liveAgentMenus(
      [
        schema('a1', AGENT_ACTIONS_SCHEMA, { ...manifest, ui: { placement: 'stage' } }),
        schema('a2', AGENT_ACTIONS_SCHEMA, { ...manifest, ui: { placement: 'tile' } }),
      ],
      new Set(['a1', 'a2']),
    )
    expect(menusFor(menus, 'stage').map((m) => m.from)).toEqual(['a1'])
    expect(menusFor(menus, 'tile').map((m) => m.from)).toEqual(['a2'])
    expect(menusFor(menus, 'controls')).toHaveLength(0)
  })
})

describe('visibleMenus', () => {
  const menus = liveAgentMenus([schema('a1'), schema('a2')], new Set(['a1', 'a2']))
  it('returns all menus when nothing is hidden', () => {
    expect(visibleMenus(menus).map((m) => m.from)).toEqual(['a1', 'a2'])
    expect(visibleMenus(menus, new Set()).map((m) => m.from)).toEqual(['a1', 'a2'])
  })
  it('drops locally-hidden agents (by participant id)', () => {
    expect(visibleMenus(menus, new Set(['a1'])).map((m) => m.from)).toEqual(['a2'])
    expect(visibleMenus(menus, new Set(['a1', 'a2']))).toHaveLength(0)
  })
})

describe('actionMessage', () => {
  it('wraps an action id in the protocol envelope', () => {
    expect(actionMessage('song')).toEqual({ kind: ACTION_MSG_KIND, id: 'song' })
  })
})

describe('agentsHubVisible', () => {
  it('hides the 🤖 hub when there are no agents', () => {
    expect(agentsHubVisible(0, 0)).toBe(false)
  })
  it('hides the 🤖 hub for a single SHOWN agent (its own actions button is enough)', () => {
    expect(agentsHubVisible(1, 1)).toBe(false)
  })
  it('keeps the 🤖 hub when the lone agent is HIDDEN (the only way to bring it back)', () => {
    expect(agentsHubVisible(1, 0)).toBe(true)
  })
  it('keeps the 🤖 hub for 2+ agents, however many are shown', () => {
    expect(agentsHubVisible(2, 2)).toBe(true)
    expect(agentsHubVisible(2, 0)).toBe(true)
    expect(agentsHubVisible(3, 1)).toBe(true)
  })
})

describe('parseManifest hardening (M7)', () => {
  const acts: { id: string; label: string; desc?: string }[] = [{ id: 'ok', label: 'Do\u202Eit', desc: 'D'.repeat(500) }, ...Array.from({ length: 40 }, (_, i) => ({ id: 'a' + i, label: 'L' + i }))]
  const bad = { agent: 'Evil\u202E' + 'X'.repeat(100), actions: acts }
  it('caps + strips control/bidi chars and caps the action count', () => {
    const m = liveAgentMenus([schema('a1', AGENT_ACTIONS_SCHEMA, bad)], new Set(['a1']))[0]
    expect(m.agent.includes('\u202E')).toBe(false) // bidi override stripped
    expect(m.agent.length).toBeLessThanOrEqual(40) // name capped
    expect(m.actions[0].label).toBe('Doit') // RLO stripped from the label
    expect((m.actions[0].desc || '').length).toBeLessThanOrEqual(240) // desc capped
    expect(m.actions.length).toBeLessThanOrEqual(24) // action count capped
  })
})
