import { describe, it, expect } from 'vitest'
// Vite's `?raw` import (typed via vite/client) hands us the component source as a string — no
// node:fs, no DOM render, no new dependency. We assert a structural invariant on that source.
import widgetSrc from './Widget.tsx?raw'

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
