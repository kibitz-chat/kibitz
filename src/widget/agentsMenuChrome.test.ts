import { describe, it, expect } from 'vitest'
import widgetSrc from './Widget.tsx?raw'
import agentsMenuSrc from './AgentsMenu.tsx?raw'

// Regression guard for "the agent pop-out menu auto-hides." The 🤖 AgentsMenu lives INSIDE the auto-hiding
// control chrome, so when it's open the chrome must be PINNED — otherwise the idle timer flips chromeHidden
// after ~3s and the open menu vanishes mid-use. The suite is node-only (no DOM render, see widgetHooks.test.ts),
// so we assert the wiring statically: (1) AgentsMenu lifts its open state, (2) Widget pins the chrome on it.
describe('agent menu pins the auto-hide chrome', () => {
  it('AgentsMenu reports its open state via onOpenChange', () => {
    expect(agentsMenuSrc).toMatch(/onOpenChange\?\.\(open\)/) // notifies the parent on open/close
    expect(widgetSrc).toMatch(/<AgentsMenu[^>]*onOpenChange=\{setAgentsMenuOpen\}/)
  })
  it('agentsMenuOpen is part of the autoHideChrome pin condition', () => {
    expect(widgetSrc).toMatch(/const \[agentsMenuOpen, setAgentsMenuOpen\] = useState\(false\)/)
    expect(widgetSrc).toMatch(/!agentsMenuOpen &&/) // pins the chrome (alongside !hostMenuOpen / !pickerOpen)
  })
})
