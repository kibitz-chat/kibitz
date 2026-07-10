import { describe, it, expect } from 'vitest'
import useCallSrc from '../react/useCall.ts?raw'
import relayLaneSrc from '../react/useRelayLane.ts?raw'
import widgetSrc from './Widget.tsx?raw'

// Viewer play/pause for a presenter's staged clip rides a RESERVED `ctl` data-mesh channel (mirroring the
// room-ledger) — NOT the embed's single-slot onApp, and NOT the fragile roster meta. Node-only suite (no DOM
// render) → assert the wiring statically; the live behaviour needs a two-device check.
describe('staged-clip viewer-control relay (reserved ctl channel)', () => {
  it('the ctl transport (now a useRelayLane module) has broadcast, directed send, and registry demux', () => {
    // ctl moved out of the engine into the generic opaque-relay lane (useRelayLane); useCall just instantiates it.
    expect(useCallSrc).toMatch(/useRelayLane\('ctl'/) // the ctl lane is wired
    expect(useCallSrc).toMatch(/sendCtl: ctl\.send/) // presenter → all (allow/playing state)
    expect(useCallSrc).toMatch(/sendCtlTo: ctl\.sendTo/) // viewer → presenter (toggle)
    // the lane's transport itself: broadcast, directed send, and demux via the content-handler registry
    expect(relayLaneSrc).toMatch(/meshBroadcast\(\{ k: kind/)
    expect(relayLaneSrc).toMatch(/meshSendTo\(to, \{ k: kind/)
    expect(relayLaneSrc).toMatch(/registerContentHandler\(kind/)
  })
  it('Widget relays a viewer play/pause + the presenter applies it (offstage works for image OR video)', () => {
    // The suppress toggle was retired (3d7caeb — everyone controls the stage now); the viewer sends a SPECIFIC
    // command. `offstage` must NOT be gated on the video element (else a viewer's Stop on an IMAGE was dropped);
    // play/pause/seek DO need the master <video>.
    expect(widgetSrc).toMatch(/sendCtlTo\(presenter\.id, \{ t: 'stagecmd', cmd: stageXport\.playing \? 'pause' : 'play' \}\)/) // viewer ⏯ → presenter
    expect(widgetSrc).toMatch(/d\?\.t === 'stagecmd'/) // presenter handles viewer stage commands
    expect(widgetSrc).toMatch(/if \(d\.cmd === 'offstage'\) stopImagePresent\(\)/) // offstage: any content, no video gate
    expect(widgetSrc).toMatch(/else if \(imgElRef\.current\)/) // play/pause/seek applied only when it holds the <video>
    expect(widgetSrc).toMatch(/d\.cmd === 'play'/) // play/pause/seek applied to the local <video>
  })
})
