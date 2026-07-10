# A dedicated screen-share video lane (camera + share coexist) — AS BUILT

> **Status: shipped.** This started as a plan; it is now implemented. `mesh.ts` carries a third up-front
> `GateKind 'share'` lane (alongside `audio` and `video`), `replaceShareTrack` swaps the screen onto it, and
> `shareScreen`/`shareTrack` in `useCall.ts` publish on the **share** lane while the camera lane is left
> untouched (the stage renders the peer's share stream, the filmstrip tile keeps their real camera/avatar).
> The avatar-only `presentingElsewhere` workaround was **removed**. The "do the step-1 spike in a throwaway
> branch first" recommendation below was carried out and the dual-lane model proved viable; the original plan
> framing is kept for the design rationale.

## Goal
A presenter shows **both** their camera/avatar (in the tile) **and** their screen-share (on the
stage) at once — for humans and AI agents. The *old* single-lane behavior was that `shareScreen`
*replaced* the camera, so while you shared, your face was gone and a camera-less agent had no tile at all
(papered over with an avatar-only tile). The separate **share lane** below fixes that root cause, and is
what ships today.

## The hard constraint (why this is an engine change, not a UI tweak)
`mesh.ts` negotiates lanes **up-front** and **never renegotiates mid-call** — by design, paid for on real
devices:
- Re-dialling / mid-call renegotiation **crashes iOS WebKit natively** (the process dies, no JS error).
- “A WebRTC ANSWER can never add a section the offer omitted,” so every lane must be in the **first offer**.

⇒ The share lane cannot be created lazily when sharing starts. It must be **negotiated at connection setup**
(a placeholder track in the initial offer), dormant until used, then filled by a silent `replaceTrack`. **Created
at join, used on demand.**

## Design
Add a **third up-front lane: `share`**, alongside `audio` and `video(camera)`. Each side's initial local stream
carries **three** placeholder tracks (audio, camera, share) → the offer has 3 m-lines → both sides answer all
three. Sharing = `replaceTrack` on the pre-negotiated **share** sender. The camera lane is never touched, so the
face/avatar stays in the tile; the share lane feeds the stage.

## Changes by layer
1. **`media.ts`** — mint a second placeholder *video* track (share) so the up-front local stream is
   `[audio-ph, camera-ph, share-ph]`.
2. **`mesh.ts`** (the core)
   - `GateKind = 'audio' | 'video' | 'share'`; add `realTrack.share`, `gatePh.share`.
   - Build the up-front stream with **two** video tracks → two video m-lines in the offer.
   - **Address the right sender per lane.** Today `applyKind` matches `sender.track?.kind === 'video'` — that's
     ambiguous with two video senders. Identify the camera-vs-share transceiver at connect (by transceiver
     **mid**/order) and gate/swap each by transceiver, not by kind.
   - `replaceShareTrack(track)` mirroring `replaceVideoTrack` → sets `realTrack.share` + `applyKind('share')`.
   - Gate: the **`share`** lane is gated by `see-screen`; the camera `video` lane keeps its own gate. (The
     `see-screen` capability + gate already exist — just point them at the share lane.)
3. **`useCall.ts`** — a share path that publishes on the **share lane** instead of replacing the camera:
   `shareScreen`/`shareTrack` → `mesh.replaceShareTrack(track)` (camera untouched); `stopShare` → restore the
   share placeholder (camera stays live); `sharing` reflects the share lane; expose the peer's **share stream**
   separately from its camera stream.
4. **`stage.ts` / `Widget.tsx` / `CallSurface.tsx`** — the **stage** renders the peer's *share* stream; the
   **tile** renders the *camera* stream (real face, or avatar if cam off). A participant is on the stage AND in
   the filmstrip at once. This **reverts** the avatar-only workaround (`presentingElsewhere`) — the tile shows
   the actual camera again.
5. **Roster** — `presenting`/`presentAt` still drive `pickPresenter` (unchanged); surface a per-participant
   share-stream ref so the stage can pick it up.

## Build order
1. **Spike first (riskiest):** `media.ts` 2nd placeholder + `mesh.ts` up-front two-video negotiation + the
   per-transceiver addressing. PROVE the offer SDP has two video m-lines and that `applyKind('share')` swaps the
   correct sender — with a unit test (mock `RTCPeerConnection`) **and** an early 2-device sanity check incl. iOS,
   before building anything on top.
2. `mesh` `share` lane + `replaceShareTrack` + the per-lane gate.
3. `useCall` share-on-share-lane + `sharing` + the separate share stream.
4. Render: stage ← share, tile ← camera; remove the avatar-only workaround.
5. `npx tsc --noEmit` + `npx vitest run` (incl. the roster guards) + `npm run build`; then the 2-device test.

## Verification
- **Unit:** `applyKind('share')` targets the share sender (not the camera); the gate withholds the share lane
  from a peer lacking `see-screen` while the camera lane is unaffected; the up-front offer carries two video
  m-lines (mock pc/transceivers).
- **2-device, MANDATORY, incl. iOS:** A shares → B sees A's screen **on the stage** AND A's camera **in the
  tile**, simultaneously; toggling A's camera doesn't disturb the share; stop-share leaves the camera live; the
  painter presents its painting on the stage while its 🎨 tile stays. **iOS: zero connection churn** on
  share/stop/camera-toggle (the exact thing the up-front-negotiation rule protects).

## Risks
- **iOS WebKit (largest).** The whole up-front rule exists because re-dial kills iOS. A 2nd m-line *up-front*
  (never mid-call) should be safe — same pattern as the existing camera lane — but it is unproven and MUST be
  device-tested before merge.
- **PeerJS m-line behavior.** Does PeerJS reliably emit two video m-lines from a two-video-track stream and keep
  their order stable enough to address senders? The step-1 spike must confirm this on PeerJS 1.5.x.
- **Backward compatibility (must decide before rollout).** Old clients negotiate 2 lanes, new ones 3. A new↔old
  pair: the old client's answer omits the 3rd m-line, so the new client's share lane to that peer is **dead**
  (per the "answer can't add a section the offer omitted" rule). Options: (a) detect the mismatch and fall back
  to the camera-lane share for old peers; (b) flag-gated rollout that assumes all-new. Recommend (a).
- **Bandwidth/SDP:** one more video m-line per peer connection (idle placeholder when not sharing → negligible;
  full only while sharing).

## Recommendation (done — kept for the record)
The plan was to do the **step-1 spike in a throwaway branch first** (two-video up-front + iOS sanity), and only
proceed if iOS + PeerJS behaved. That spike was done, the negotiation held, and the dual-lane model **shipped**
(`mesh.ts` `GateKind 'share'` + `replaceShareTrack`; the share placeholder is the 2nd up-front video track —
`stream?.getVideoTracks()[1]`). The remaining work was mechanical, exactly as predicted once the spike proved
the negotiation. (A 4th lane, `shareAudio`, was later added the same up-front way for staged-clip sound.)
