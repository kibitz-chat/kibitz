import { describe, expect, it } from 'vitest'
import { nextStageWAt, pickStagedWidget, stageClearAtOf, stagedWidgetOf, stageWAtOf } from './stageWidget'

const p = (id: string, meta: Record<string, unknown> = {}) => ({ id, meta })

describe('stageWidget — shared "which widget is on the stage" convention', () => {
  it('reads a participant\'s staged-widget push from meta', () => {
    expect(stagedWidgetOf(p('a'))).toBeNull()
    expect(stagedWidgetOf(p('a', { stageWidget: 'w1', stageWAt: 3 }))).toBe('w1')
    expect(stageWAtOf(p('a', { stageWidget: 'w1', stageWAt: 3 }))).toBe(3)
    expect(stageWAtOf(p('a', { stageWidget: '', stageWAt: 3 }))).toBe(0) // empty id → not pushing
  })

  it('nobody pushing → no staged widget', () => {
    expect(pickStagedWidget([p('a'), p('b')])).toBeNull()
  })

  it('the NEWEST push wins (anyone can take over the stage)', () => {
    const parts = [
      p('agent', { stageWidget: 'mapA', stageWAt: 1 }),
      p('alice', { stageWidget: 'mapB', stageWAt: 5 }), // pushed later → wins
      p('bob', { stageWidget: 'mapC', stageWAt: 3 }),
    ]
    expect(pickStagedWidget(parts)).toEqual({ id: 'mapB', from: 'alice' })
  })

  it('a cleared push (stageWidget undefined) drops out of contention', () => {
    const parts = [
      p('agent', { stageWidget: 'mapA', stageWAt: 1 }),
      p('alice', { stageWidget: undefined, stageWAt: 9 }), // took it down
    ]
    expect(pickStagedWidget(parts)).toEqual({ id: 'mapA', from: 'agent' })
  })

  it('nextStageWAt is one past the highest push OR clear (monotonic take-over)', () => {
    expect(nextStageWAt([p('a', { stageWidget: 'w', stageWAt: 4 }), p('b', { stageWidget: 'w2', stageWAt: 7 })])).toBe(8)
    expect(nextStageWAt([p('a', { stageClearAt: 11 }), p('b', { stageWidget: 'w', stageWAt: 7 })])).toBe(12) // a clear counts
    expect(nextStageWAt([p('a'), p('b')])).toBe(1)
  })

  it('a CLEAR newer than the newest push takes it off the stage — ANYONE can un-stage (tombstone)', () => {
    expect(stageClearAtOf(p('a', { stageClearAt: 6 }))).toBe(6)
    // agent auto-staged it (push @5); a human (who never pushed) clears @6 → newest action is the clear → empty.
    const cleared = [p('agent', { stageWidget: 'chart1', stageWAt: 5 }), p('alice', { stageWidget: undefined, stageClearAt: 6 })]
    expect(pickStagedWidget(cleared)).toBeNull()
    // …but a push NEWER than the clear re-stages (a fresh request wins).
    const restaged = [...cleared, p('bob', { stageWidget: 'table9', stageWAt: 7 })]
    expect(pickStagedWidget(restaged)).toEqual({ id: 'table9', from: 'bob' })
  })
})
