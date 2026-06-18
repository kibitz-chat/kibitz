import { describe, it, expect } from 'vitest'
import { liveAgentMenus, menusFor, visibleMenus, actionMessage, parseTheme, AGENT_ACTIONS_SCHEMA, ACTION_MSG_KIND } from './agentActions'
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
