import { describe, it, expect } from 'vitest'
import barSrc from './AgentActionsBar.tsx?raw'
import menuSrc from './AgentsMenu.tsx?raw'

// Agents publish meta.busy + meta.activity. While the agent is WORKING on a task (busy && activity !== 'listening'),
// its task actions GRAY OUT so a re-tap can't pile on another job; leave-the-call (the last action) stays live, as
// does the 🙏 Thanks closer. Crucially, the 'listening' follow-up window (the cyan "your turn" ear) does NOT gray —
// tapping is the point there (gating on activity!=='listening' is what fixed the old "silence got grayed" bug).
// Node-only suite (no DOM render, see widgetHooks.test.ts) → assert wiring statically.
describe('agent actions: gray out while WORKING, live while listening, Thanks closer', () => {
  it('AgentActionsBar disables task actions only while working (not while listening); Thanks live', () => {
    expect(barSrc).toMatch(/activity\s*!==\s*'listening'/) // working = busy AND not the 'listening' ear
    expect(barSrc).toMatch(/const working = !!meta\?\.busy && meta\?\.activity !== 'listening'/)
    expect(barSrc).toMatch(/const disabled = working && !isLeave/) // gray every action except leave (the last)
    expect(barSrc).toMatch(/disabled=\{disabled\}/)
    expect(barSrc).toMatch(/kw-agentbar-chip--disabled/)
    expect(barSrc).toMatch(/kw-agentbar-working/) // the ⏳ working indicator
    expect(barSrc).toMatch(/sendChat\('thank you friend', menu\.from\)/) // Thanks → the closing signal
  })
  it('AgentsMenu (the pop-out) grays task actions while working, keeps leave + Thanks live', () => {
    expect(menuSrc).toMatch(/const working = !!meta\?\.busy && meta\?\.activity !== 'listening'/)
    expect(menuSrc).toMatch(/const disabled = working && i !== m\.actions\.length - 1/) // leave (last) stays live
    expect(menuSrc).toMatch(/disabled=\{disabled\}/)
    expect(menuSrc).toMatch(/sendChat\('thank you friend', m\.from\)/)
  })
})
