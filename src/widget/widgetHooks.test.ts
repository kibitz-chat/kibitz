import { describe, it, expect } from 'vitest'
// Vite's `?raw` import (typed via vite/client) hands us the component source as a string — no
// node:fs, no DOM render, no new dependency. We assert a structural invariant on that source.
import widgetSrc from './Widget.tsx?raw'
import bubbleLayerSrc from './AgentBubbleLayer.tsx?raw'

// Regression guard for React error #310 ("rendered more hooks than during the previous render").
//
// The Widget component returns a tiny floating pill while collapsed (`if (!open) return <pill>`)
// and the full panel while open. React's Rules of Hooks require an IDENTICAL sequence of hook
// calls on every render — so EVERY hook must run before that early return. A hook placed after it
// (as the auto-hide-chrome effect once was) runs only in the open render, so the very first tap of
// the pill renders "more hooks than the previous render" and crashes the whole widget. The test
// suite is node-only (no DOM render), so nothing exercised the collapsed→open transition and the
// crash shipped to kibitz.chat/embed. This static check fails the build if a hook ever slips below
// the collapse return again.
//
// The invariant, expressed lexically: within the Widget component, every top-level hook call (a
// line indented exactly two spaces — the component body — calling useX(...)) must come BEFORE the
// `if (!open) {` collapse return.
const lines = widgetSrc.split('\n')

const HOOK = /^ {2}(?:const \[?[^\]]*\]? = |const [\w$]+ = )?use(?:State|Effect|LayoutEffect|Memo|Callback|Ref|Reducer|Context|ImperativeHandle)\(/

describe('Widget collapse-return / Rules of Hooks', () => {
  it('places the `if (!open)` pill return after every top-level hook', () => {
    const widgetStart = lines.findIndex((l: string) => l.startsWith('export function Widget('))
    expect(widgetStart).toBeGreaterThan(-1)

    const collapseReturn = lines.findIndex((l: string, i: number) => i > widgetStart && l.trimEnd() === '  if (!open) {')
    expect(collapseReturn).toBeGreaterThan(widgetStart)

    // Any component-body hook (2-space indent) AFTER the collapse return is the bug.
    const offenders = lines
      .map((l: string, i: number) => ({ l, i }))
      .filter(({ l, i }: { l: string; i: number }) => i > collapseReturn && HOOK.test(l))
      .map(({ l, i }: { l: string; i: number }) => `  ${i + 1}: ${l.trim()}`)

    expect(
      offenders,
      `A React hook is called AFTER the \`if (!open)\` collapse return — it will crash the widget on ` +
        `the first pill tap (React #310). Move it above the collapse return:\n${offenders.join('\n')}`,
    ).toEqual([])
  })
})

// Regression guard for the engage-nudge ("go ahead, friend") never firing.
//
// The nudge is armed by a 60s setTimeout in a useEffect. `engageAction` is rebuilt fresh on EVERY render
// (splitActions() returns a new object), so if it — or the changing `anyEngaged` — sits in that effect's dep
// array, the effect re-runs on every render (the layer re-renders every ~1–2s on presence ticks), clearing and
// restarting the timer so the 60s countdown never elapses and the nudge never appears. The suite is node-only
// (no DOM render), so nothing catches this at runtime — pin the stable-boolean deps lexically.
describe('AgentBubbleLayer engage-nudge timer survives to fire', () => {
  it('does not put fresh-per-render refs (engageAction/anyEngaged) in the 60s-timer effect deps', () => {
    const t = bubbleLayerSrc.indexOf('}, 60_000)')
    expect(t, 'the 60s nudge timer moved or was removed — update this guard').toBeGreaterThan(-1)
    const deps = bubbleLayerSrc.slice(t).match(/\}, \[([^\]]*)\]\)/) // the effect's dep array, right after the timer
    expect(deps, 'could not locate the nudge effect dep array').not.toBeNull()
    expect(
      deps![1],
      `The 60s engage-nudge effect depends on a fresh-per-render value, so its timer resets every render and the ` +
        `nudge never fires. Depend on stable booleans only:\n  deps were: [${deps![1]}]`,
    ).not.toMatch(/engageAction|anyEngaged/)
  })
})

// Regression guard for the summon→arrival→greet handoff (fix agent-panel: "expand on explicit meta.greeted,
// not audio-silence guessing"). A newly-arrived agent's panel INTENTIONALLY collapses while it greets — the summon
// bubble unmounts, so openId ('__summon') matches nothing — then auto-opens to the Engage prompt when the agent
// EXPLICITLY sets meta.greeted, with a GREET_MAX timeout as the ONLY fallback. Pin that so a future refactor can't
// silently regress to audio-silence guessing, drop the fallback, or re-open a manually-closed / re-summoned agent.
describe('AgentBubbleLayer auto-open is driven by explicit meta.greeted (+ a fallback), not guessing', () => {
  it('opens the panel on the explicit meta.greeted signal', () => {
    expect(bubbleLayerSrc, 'greetedKey must be derived from each agent’s meta.greeted').toMatch(/\?\.greeted\b/)
    // an effect keyed on the greeted set calls openArrival for each greeted agent
    expect(bubbleLayerSrc, 'the meta.greeted signal must call openArrival').toMatch(/greetedKey[\s\S]{0,160}openArrival\(id\)/)
  })
  it('keeps a GREET_MAX_MS fallback so a lost/absent flag still opens the panel', () => {
    expect(bubbleLayerSrc, 'the GREET_MAX fallback timeout must call openArrival').toMatch(/setTimeout\([\s\S]*?openArrival\(id\),\s*GREET_MAX_MS\)/)
  })
  it('opens each agent at most once and forgets leavers (so a re-summon re-runs it)', () => {
    expect(bubbleLayerSrc, 'openArrival must no-op if already auto-opened (once per agent; a manual close stays closed)').toMatch(/autoOpenedRef\.current\.has\(id\)\)\s*return/)
    expect(bubbleLayerSrc, 'a departed agent must be forgotten from autoOpenedRef so a re-summon re-runs the auto-open').toMatch(/!live\.has\(id\)\)\s*autoOpenedRef\.current\.delete\(id\)/)
  })
})
