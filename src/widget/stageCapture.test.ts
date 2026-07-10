import { describe, it, expect } from 'vitest'
import widgetSrc from './Widget.tsx?raw'

// Staging media must work on iOS Safari, which has NO HTMLMediaElement.captureStream. captureStagedVideo
// capability-detects and, where it's absent, falls back to a canvas render loop (video) + Web Audio (audio) —
// both iOS-supported. Node-only suite (no DOM render) → assert the wiring statically; iOS needs a device check.
describe('staged video/audio capture — iOS fallback', () => {
  it('capability-detects native captureStream, with a force flag for testing', () => {
    expect(widgetSrc).toMatch(/el\.captureStream \|\| el\.mozCaptureStream/)
    expect(widgetSrc).toMatch(/kbz\.stageCanvas/) // force the fallback on a capable browser (for e2e)
  })
  it('iOS fallback: a canvas render loop for the video + Web Audio for the sound', () => {
    expect(widgetSrc).toMatch(/createMediaElementSource\(el\)/) // tap the element's audio
    expect(widgetSrc).toMatch(/createMediaStreamDestination\(\)/) // → a shareable audio track
    expect(widgetSrc).toMatch(/drawImage\(el, 0, 0, canvas\.width, canvas\.height\)/) // mirror frames to a canvas
    expect(widgetSrc).toMatch(/canvas\.captureStream\(\)/) // canvas.captureStream IS supported on iOS
  })
  it('speaker-off mutes LOCAL playback via the gain — the share tap stays full', () => {
    expect(widgetSrc).toMatch(/localGainRef\.current\.gain\.value = deaf \? 0 : 1/)
  })
})
