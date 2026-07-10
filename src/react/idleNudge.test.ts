import { describe, it, expect } from 'vitest'
import { createIdleNudge } from './idleNudge'

function harness({ idleMs = 300000, graceMs = 60000 } = {}) {
  let t = 0
  let id = 0
  const timers = new Map<number, { fn: () => void; at: number }>()
  const ev: { nudge: boolean[]; leave: number } = { nudge: [], leave: 0 }
  const c = createIdleNudge({
    idleMs,
    graceMs,
    onNudge: (on) => ev.nudge.push(on),
    onLeave: () => (ev.leave += 1),
    setTimer: (fn, ms) => {
      const k = ++id
      timers.set(k, { fn, at: t + ms })
      return k
    },
    clearTimer: (k) => timers.delete(k as number),
  })
  const adv = (ms: number) => {
    t += ms
    for (const [k, { fn, at }] of [...timers]) if (at <= t) {
      timers.delete(k)
      fn()
    }
  }
  return { c, ev, adv }
}

describe('createIdleNudge', () => {
  it('idle for idleMs → nudge raised; grace passes with no response → leave', () => {
    const h = harness()
    h.adv(300000)
    expect(h.ev.nudge).toEqual([true])
    expect(h.ev.leave).toBe(0)
    h.adv(60000)
    expect(h.ev.leave).toBe(1)
    expect(h.ev.nudge).toEqual([true, false])
  })
  it('engagement before idle → never nudges', () => {
    const h = harness()
    h.adv(200000)
    h.c.bump()
    h.adv(200000)
    expect(h.ev.nudge).toEqual([])
    expect(h.ev.leave).toBe(0)
  })
  it('stay() during the nudge → cleared, no leave, and it re-arms', () => {
    const h = harness()
    h.adv(300000)
    expect(h.ev.nudge).toEqual([true])
    h.c.stay()
    expect(h.ev.nudge).toEqual([true, false])
    h.adv(60000)
    expect(h.ev.leave).toBe(0) // the grace timer was cleared by stay()
    h.adv(300000)
    expect(h.ev.nudge).toEqual([true, false, true]) // idle again → nudges again
  })
  it('engagement during the nudge also clears it (they are clearly here)', () => {
    const h = harness()
    h.adv(300000)
    h.c.bump()
    h.adv(60000)
    expect(h.ev.leave).toBe(0)
    expect(h.ev.nudge).toEqual([true, false])
  })
  it('disable() → never nudges or leaves', () => {
    const h = harness()
    h.c.disable()
    h.adv(999999)
    expect(h.ev.nudge).toEqual([])
    expect(h.ev.leave).toBe(0)
  })
})
