# Shared-screen annotation (doodle), per-image memory, sync & TV mirroring

Pen/laser annotation over the shared screen on the call stage — now **bound to the image it was drawn on**,
**synced** to everyone (including late joiners), drawable **by an AI agent**, and **mirrorable to a TV**.

## What you can do (UX)

- **Show your own image, video, or audio on the stage.** Share media into **chat** (the ＋ attach — **🖼️ Photo /
  📷 Camera / 🎬 Video / 🎥 Record / 🎵 Audio**), then **tap an image** (or use the ⋯ on a video/audio) and pick
  **📺 Stage** to
  put it on the shared screen — no screen-share, so it works on **iOS** too. It's doodle-able, sync'd, and
  mirror-able. **💾 Save** downloads it; **🛑** (control bar) stops showing it. (Reuses the painter's present
  path: canvas/`<video>` → `captureStream` → `shareTrack` + `meta.stageImage`.) **Audio** stages a "🎵 Now
  playing" card on the stage while the sound rides the share-audio lane. **Video sound to remote peers**
  rides a dedicated **share-audio lane** — a 2nd audio m-line parallel to the share-video lane (`GateKind
  'shareAudio'` = `audio[1]`; `publishShareAudio` → `replaceShareAudioTrack`; received via `remoteShareAudioTrack`
  → a hidden `<audio>` sink). **Default ON**, with a per-device opt-OUT (`localStorage 'kbz.shareAudio'='0'`) to
  kill it if a peer/browser misbehaves with the extra m-line; old/opt-out peers just don't negotiate it (graceful,
  the mic lane is untouched). Carries both a **screen-share's** tab/system audio and a **staged clip's** sound.
  Gated by `see-screen` (video + audio together).
- **Watch together — viewers can play/pause.** When you stage a video, others see a **▶/⏸** on the stage to
  play/pause it for *everyone* (it's a live stream, so it stays in sync). The presenter can take **sole control**
  via the **👥 / 🔒** toggle on the control panel. The relay rides a reserved **`ctl`** data-mesh channel
  (`sendCtl`/`sendCtlTo`/`onCtl`, demuxed before `onApp` — not chat, not meta); the presenter applies a viewer's
  toggle only when not suppressed.
- **Draw on the shared screen.** With a screen on the stage, the ink toolbar offers a **laser** (👆 — others
  see where you point, live) and a **pen** (✏️ with a colour swatch). 🧹 clears **your own** strokes only — you
  can't wipe everyone's board.
- **Per-image memory.** When the shared image **changes**, your doodle for the previous image is **saved** and
  the board **clears** for the new one. Show that image **again** → its doodle **comes back**. It's
  content-addressed, so the *same* image always gets *its* doodle. (A live screen-share — no fixed image — keeps
  its running board, unchanged.)
- **Synced, not per-screen.** The annotation is replayed to **everyone**, including someone who **joined after**
  it was drawn — not just whoever was present at the time.
- **The agent can doodle too.** An image-presenting agent (the painter) can **circle / box / point at** something
  on the image it shared ("here's the part I mean"), in everyone's view.
- **Full-screen → mirror to a TV.** A **⛶** button on the stage puts the *shared screen* into real OS fullscreen;
  then mirror your device (AirPlay / Android Cast-screen / Smart View) and the TV shows the shared content
  **edge-to-edge** — no browser or app chrome. The doodle rides along. Exit with the **⤢** button (top-left) or
  **Esc** / the back gesture.

## How it works

### The doodle engine (`src/react/ink.ts`, `src/react/StageInk.tsx`)
- `StageInk` overlays the stage **video's content rect** (letterbox-aware via `containRect`/`toNorm`), so a point
  lands on the same spot on every viewer's screen whatever their panel size. Strokes are normalized 0..1.
- **Per-image store.** `StageInk` takes an `imageKey` prop = the id of the image currently on the stage. On a
  change, `switchDoodle(saved, current, fromKey, toKey)` (pure, unit-tested) snapshots the leaving image's board
  into a per-image store and restores the entering image's (or a clean board for a new image). `imageKey` comes
  from **`presenter.meta.stageImage`** (the stager advertises which image is up). `undefined` (a live screen) →
  the running board is left alone.

### Sync — the stager replays (`{k:'restore'}`)
- New `InkEvent { k:'restore', image, strokes }` (`src/core/protocol.ts`) — a **bulk replay** of an image's
  doodle, keyed by the stage image.
- On receiving a `restore`, `StageInk` writes it into the per-image store **and** paints it if it's the live image
  — **race-proof** (whatever the arrival order, `switchDoodle` reads the store on the next switch).
- `sendInk` is exposed on the controls bridge (`CallControls`) so a **headless agent** can broadcast a replay.
- The **authority is the stager** (the agent/person presenting the image): it accumulates every annotation per
  image and re-broadcasts on **re-show** and when a **new peer joins** → late joiners get it. Per-viewer remains
  the fallback render.

### The agent producer & annotation (kibitz side)
- The painter **presents** its image to the stage (the `screen` surface → `shareTrack` + `presenting`) and stamps
  **`meta.stageImage`** with a content hash (FNV-1a) so doodles bind per image. It accumulates strokes per image
  and `replayDoodle()`s them (sync).
- **`annotate` tool** (brain-callable on image-presenting agents): `{ shape: circle|box|point, x, y, r/w/h }` in
  0..1 image coords, placed from the agent's **native vision** of the image. Geometry is Node-side + tested
  (`agent/inkShapes.mjs`); the driver relays the strokes via `ctrl.sendInk` (reusing this peer-ink rendering) and
  self-accumulates them so they replay. See [kibitz voice-stack](../../kibitz/docs/voice-stack.md).

### Full-screen for mirroring (`StageInk` stage / `Widget.tsx`)
- A **⛶** button (shown only when a screen is shared **and** element-fullscreen is supported) calls
  `requestFullscreen()` on the **stage** (not the whole widget — the old "Full screen" was a CSS fill that still
  mirrored the chrome). `.kw-stage:fullscreen` fills the screen black; the video letterboxes; the ink overlay
  re-measures and stays aligned.

## Caveats
- **iOS Safari** only fullscreens a bare `<video>` (no ink overlay), so the **⛶** button is **hidden** there —
  on iOS use OS **Screen Mirroring** + the fill view instead.
- **In-app casting** of the *stream itself* to AirPlay/Chromecast isn't possible — the Remote Playback API doesn't
  support a live WebRTC `MediaStream` (it's for media URLs/HLS), and transcoding would break E2EE. **OS screen
  mirroring is the supported path**, which the fullscreen toggle is designed for.
- **Agent annotation accuracy** depends on the model's spatial grounding — a circle lands *roughly* where it means.
- A `restore` replaces the board with the authoritative set, so a per-stroke `clear` after a restore is coarser.

## Related
- Agent menu pop-out no longer auto-hides while open (it pins the auto-hiding chrome) — a companion fix.
