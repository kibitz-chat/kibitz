import { describe, it, expect } from 'vitest'
import widgetSrc from '../widget/Widget.tsx?raw'
import useCallSrc from './useCall.ts?raw'
import mediaSrc from '../core/media.ts?raw'
import pipSrc from './useVideoPip.ts?raw'
import connDebugSrc from '../core/connDebug.ts?raw'
import pwaSrc from '../pwa.tsx?raw'

// CPU/battery teardown fixes. Widget mounts once and NEVER unmounts, and leaveCall tears down the mesh but
// not the peripheral engines it spun up — so several loops/contexts leaked onto the idle post-call landing.
// These are lifecycle/DOM/module-global behaviours (no pure-function seam and no hook-render harness in this
// node suite), so — as with stageControl.test.ts — we pin the wiring statically; the runtime win is verified
// on-device. Each assertion guards against a specific regression of a shipped fix.

describe('② silent AudioContext is closed on call teardown', () => {
  it('media.ts exports closeSilentAudio that closes + nulls the shared context', () => {
    expect(mediaSrc).toMatch(/export function closeSilentAudio\(\)/)
    expect(mediaSrc).toMatch(/silentAudioCtx = null/)
    expect(mediaSrc).toMatch(/ctx\?\.close\(\)/)
  })
  it('useCall.teardown closes it AFTER stopping the placeholder tracks', () => {
    const teardown = useCallSrc.slice(useCallSrc.indexOf('const teardown = useCallback('))
    const stopIdx = teardown.indexOf('gateAudioPhRef.current = null')
    const closeIdx = teardown.indexOf('closeSilentAudio()')
    expect(stopIdx).toBeGreaterThanOrEqual(0)
    expect(closeIdx).toBeGreaterThan(stopIdx) // close only once every silent-derived track is stopped
  })
})

describe('①⑤ Widget releases peripheral engines on inCall→false', () => {
  it('has a !inCall effect that tears down the stage capture rig and PiP', () => {
    expect(widgetSrc).toMatch(/if \(call\.inCall\) return\n\s*teardownCapture\(\)/)
    expect(widgetSrc).toMatch(/setStagedVideoSrc\(null\)/)
    expect(widgetSrc).toMatch(/const pipRelease = videoPip\.release/)
    expect(widgetSrc).toMatch(/pipRelease\(\)/)
  })
})

describe('⑤ useVideoPip exposes an idempotent release()', () => {
  it('returns release and uses it for the unmount teardown', () => {
    expect(pipSrc).toMatch(/const release = useCallback\(/)
    expect(pipSrc).toMatch(/useEffect\(\(\) => release, \[release\]\)/)
    expect(pipSrc).toMatch(/return \{ supported, active, toggle, release \}/)
  })
})

describe('③ connDebug per-pc getStats interval self-cleans on close', () => {
  it('stores the interval id and clears + prunes the pc once it closes', () => {
    expect(connDebugSrc).toMatch(/info\.statTimer = window\.setInterval/)
    expect(connDebugSrc).toMatch(/pc\.connectionState === 'closed'/)
    expect(connDebugSrc).toMatch(/clearInterval\(info\.statTimer\)/)
    expect(connDebugSrc).toMatch(/pcs\.splice\(i, 1\)/)
  })
})

describe('④ connDebug 1Hz redraw runs only while the panel is enabled', () => {
  it('gates the draw loop behind start/stopDrawLoop instead of an always-on interval', () => {
    expect(connDebugSrc).toMatch(/function startDrawLoop\(\)/)
    expect(connDebugSrc).toMatch(/function stopDrawLoop\(\)/)
    expect(connDebugSrc).toMatch(/if \(debugEnabled\(\)\) startDrawLoop\(\)/)
    expect(connDebugSrc).toMatch(/stopDrawLoop\(\)/)
    expect(connDebugSrc).not.toMatch(/setInterval\(draw, 1000\)/) // the old always-on loop is gone
  })
})

describe('⑥ SW update poll is visibility-gated and cleaned up', () => {
  it('polls only while visible and clears the interval on cleanup', () => {
    expect(pwaSrc).toMatch(/document\.visibilityState === 'visible'\) (?:void )?check\(\)/)
    expect(pwaSrc).toMatch(/clearInterval\(id\)/)
    expect(pwaSrc).toMatch(/return \(\) => swCleanup\?\.\(\)/)
    expect(pwaSrc).not.toMatch(/setInterval\(check, 60_000\)/) // no ungated always-on poll
  })
})
