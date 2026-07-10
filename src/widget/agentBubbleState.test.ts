import { describe, it, expect } from 'vitest'
import {
  deriveState,
  isPresentState,
  subStatus,
  bubbleVisible,
  pillWord,
  splitActions,
  scribeEnabledFromLabel,
  engagedFromMeta,
  ENGAGE_ID,
  LISTEN_ID,
  LEAVE_ID,
} from './agentBubbleState'
import type { AgentAction } from './agentActions'

describe('deriveState', () => {
  it('is absent with no agent and no summon in flight', () => {
    expect(deriveState({ present: false, summoning: false, engaged: false })).toBe('absent')
  })
  it('is summoning while a summon is in flight and no agent yet', () => {
    expect(deriveState({ present: false, summoning: true, engaged: false })).toBe('summoning')
  })
  it('is ready once present and not engaged', () => {
    expect(deriveState({ present: true, summoning: false, engaged: false })).toBe('ready')
  })
  it('is engaged once present and engaged', () => {
    expect(deriveState({ present: true, summoning: false, engaged: true })).toBe('engaged')
  })
  it('present wins over a stale summoning flag', () => {
    expect(deriveState({ present: true, summoning: true, engaged: false })).toBe('ready')
  })
})

describe('isPresentState', () => {
  it('is true only for ready/engaged', () => {
    expect(isPresentState('ready')).toBe(true)
    expect(isPresentState('engaged')).toBe(true)
    expect(isPresentState('absent')).toBe(false)
    expect(isPresentState('summoning')).toBe(false)
  })
})

describe('subStatus', () => {
  it('is null outside engaged', () => {
    expect(subStatus('ready', true)).toBeNull()
    expect(subStatus('absent', true)).toBeNull()
  })
  it('reflects speaking vs listening inside engaged', () => {
    expect(subStatus('engaged', true)).toBe('speaking')
    expect(subStatus('engaged', false)).toBe('listening')
  })
})

describe('bubbleVisible', () => {
  it('creator always sees the bubble', () => {
    for (const s of ['absent', 'summoning', 'ready', 'engaged'] as const) {
      expect(bubbleVisible(s, true)).toBe(true)
    }
  })
  it('participant only sees a present agent', () => {
    expect(bubbleVisible('absent', false)).toBe(false)
    expect(bubbleVisible('summoning', false)).toBe(false)
    expect(bubbleVisible('ready', false)).toBe(true)
    expect(bubbleVisible('engaged', false)).toBe(true)
  })
})

describe('pillWord', () => {
  it('absent shows Add agent, or Re-summon when known', () => {
    expect(pillWord('absent', null, true, false)).toBe('Add agent')
    expect(pillWord('absent', null, true, true)).toBe('Re-summon')
  })
  it('summoning shows Summoning…', () => {
    expect(pillWord('summoning', null, true, false)).toBe('Summoning…')
  })
  it('ready shows Ready when scribe enabled, Disabled when off', () => {
    expect(pillWord('ready', null, true, false)).toBe('Ready')
    expect(pillWord('ready', null, false, false)).toBe('Disabled')
  })
  it('engaged shows the live listen/speak word', () => {
    expect(pillWord('engaged', 'listening', true, false)).toBe('Listening')
    expect(pillWord('engaged', 'speaking', true, false)).toBe('Speaking')
  })
})

describe('splitActions', () => {
  const a = (id: string, label = id): AgentAction => ({ id, label })
  it('picks out engage/listen/leave and leaves the rest as capabilities', () => {
    const actions = [a(ENGAGE_ID, '🎙️ Talk to me'), a('paint', 'Paint'), a(LISTEN_ID, 'Pause'), a('sing', 'Sing'), a(LEAVE_ID, 'Leave')]
    const s = splitActions(actions)
    expect(s.engage?.label).toBe('🎙️ Talk to me')
    expect(s.listen?.label).toBe('Pause')
    expect(s.leave?.label).toBe('Leave')
    expect(s.capabilities.map((c) => c.id)).toEqual(['paint', 'sing'])
  })
  it('tolerates a manifest missing the control actions', () => {
    const s = splitActions([a('paint'), a('sing')])
    expect(s.engage).toBeUndefined()
    expect(s.listen).toBeUndefined()
    expect(s.leave).toBeUndefined()
    expect(s.capabilities).toHaveLength(2)
  })
  it('returns no capabilities when only controls are published', () => {
    const s = splitActions([a(ENGAGE_ID), a(LISTEN_ID), a(LEAVE_ID)])
    expect(s.capabilities).toHaveLength(0)
  })
})

describe('engagedFromMeta', () => {
  it('is not engaged when dormant (no meta / no busy)', () => {
    expect(engagedFromMeta(undefined)).toBe(false)
    expect(engagedFromMeta({})).toBe(false)
    expect(engagedFromMeta({ busy: false })).toBe(false)
  })
  it('is engaged while busy responding', () => {
    expect(engagedFromMeta({ busy: true, activity: 'thinking' })).toBe(true)
  })
  it('is engaged in the follow-up listening window', () => {
    expect(engagedFromMeta({ busy: false, activity: 'listening' })).toBe(true)
  })
  it('prefers meta.phase when present — engaged/closing have the floor, listening is dormant', () => {
    expect(engagedFromMeta({ phase: 'engaged' })).toBe(true)
    expect(engagedFromMeta({ phase: 'closing' })).toBe(true)
    expect(engagedFromMeta({ phase: 'listening' })).toBe(false)
  })
  it('meta.phase overrides the busy/activity proxy', () => {
    expect(engagedFromMeta({ phase: 'listening', busy: true })).toBe(false)
    expect(engagedFromMeta({ phase: 'engaged', busy: false })).toBe(true)
  })
})

describe('scribeEnabledFromLabel', () => {
  it('assumes enabled when no listen toggle is published', () => {
    expect(scribeEnabledFromLabel(undefined)).toBe(true)
  })
  it('is enabled when the label offers to Pause (currently hearing)', () => {
    expect(scribeEnabledFromLabel({ id: LISTEN_ID, label: '⏸ Pause listening' })).toBe(true)
  })
  it('is disabled when the label offers to Resume/unmute (currently paused)', () => {
    expect(scribeEnabledFromLabel({ id: LISTEN_ID, label: '▶ Resume' })).toBe(false)
    expect(scribeEnabledFromLabel({ id: LISTEN_ID, label: 'Unmute' })).toBe(false)
  })
})
