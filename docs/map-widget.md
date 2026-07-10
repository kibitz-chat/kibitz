# Bounded interactive widgets (the map widget)

A room peer — typically an AI agent — can post a **bounded interactive widget** into the chat: a typed payload
that a **first-party renderer shipping in the Kibitz bundle** draws as a real, pressable UI. The first widget
`kind` is `kbz.map`: an interactive slippy map. This is the "generative UI" model (the same shape as the
interactive maps an assistant like ChatGPT renders inline): the agent decides _what_ to show by emitting
validated data; Kibitz owns _how_ it's drawn and what interacting with it does.

## Why "bounded" is the safe tier

The agent (even a third-party-authored one) only ever supplies **validated JSON** that conforms to the widget's
schema — it never ships code. The renderer that draws the map is **our** code, in our bundle, fully trusted. So
the worst a malicious or buggy agent can do is hand us a malformed payload, which the validator
(`sanitizeMapData`) rejects. There is no sandbox to escape because there is no third-party code running. (An
_open_ tier — a third party shipping its own widget UI in a sandboxed iframe, à la the host-menu seam — is a
separate, later, higher-cost tier. This doc is the bounded tier.)

## Wire protocol (additive)

Two generic `ContentMsg` kinds ride the existing peer-to-peer data mesh (no authority relays them), mirroring
the `ink`/doodle precedent. A peer without the `widget.v1` feature simply ignores them.

- `{ k: 'widget'; id; kind; data; replay? }` — a widget instance posted into the room. `kind` selects the
  first-party renderer; `id` is the instance; `data` is the renderer payload. `replay` is set only when the
  instance **owner** re-sends the widget to a late joiner — it carries the accumulated interaction events.
- `{ k: 'wevt'; id; e }` — an **interaction** with an instance (e.g. a viewer dropping a pin). Broadcast so the
  overlay is shared by everyone; the renderer for the widget's `kind` defines the shape of `e`.

## Shared interactions + late joiners

Pressing the map (dropping a pin) broadcasts a `wevt`; every peer folds it into the instance's pin set with an
**idempotent, id-keyed reducer** (`applyMapEvent`), so order and duplication don't matter. The peer that
**posted** the widget owns it: the engine retains every interaction against owned instances and re-broadcasts the
widget _with that log_ on each roster change (a `src/react/useWidgets.ts` effect on the `onRosterChange` seam, the
same order-independent replay as schema discovery). So someone who joins after pins were dropped still sees them. This lives in the engine — not the app
layer — so a **headless agent's** map gets the same replay with no app cooperation. (If the owner leaves, the map
freezes at its last-seen state.)

## On the stage (shared, anyone can push)

A map isn't only a chat card — it can be promoted to the **stage**, the big shared surface. Unlike a
screen-share (a presenter's video that others only watch), a staged map is rendered **locally and
interactively by every peer** from the same instance data, so everyone can pan it and drop shared pins. It's
the doodle/stage model, but the surface itself is interactive rather than a video frame.

**Who can push it: anyone.** Staging is a shared pointer carried in roster metadata (`stageWidget.ts`), the same
convention as the screen-share presenter (`stage.ts`): a participant promotes a map by setting their OWN
`meta.stageWidget = <instanceId>` with a monotonic `stageWAt`, and the **newest push wins** the stage. So the
agent that posted the map has no special ownership — any participant taps **📺 Stage** on the map card to push
it (or a different map) to the stage, and **✕ Off stage** takes it down. Because the pointer rides the roster,
a late joiner sees what's currently staged with no extra signalling, and it survives host migration. The
instance data reaches a late joiner through the same owner re-broadcast that carries the pins.

Pins are **geo-anchored**, so they're correct on every peer's view regardless of pan. On top of that the staged
map is **lockstep — "follow the driver"**: whoever pans or zooms it drives, and everyone else's staged map snaps
to that viewport. The shared viewport rides the **ephemeral `ctl` channel** (throttled, ~8/s), deliberately NOT
the retained `wevt` log — a stream of pan frames must never evict pins from replay. The active driver is never
yanked (a short interaction-grace ignores incoming views while you're moving); followers converge once they
settle. It's live, not persisted: a late joiner opens at the map's own centre and snaps on the next drive. The
chat-card copy stays independent and local — lockstep is a stage-only behaviour.

## API

Controller (`useCall` / `MountedWidget`):

- `sendWidget(kind, data, id?) → id` — post / update an instance the local end owns.
- `onWidget(cb) → unsubscribe` — instances peers post (and replays, deduped by id).
- `sendWidgetEvent(id, e)` — broadcast an interaction.
- `onWidgetEvent(cb) → unsubscribe` — peers' interactions, attributed by roster.

Agent SDK (`createAgent`): `showMap(data) → id`, `showWidget(kind, data, id?) → id`, `onWidgetTap(cb)`.

The map payload is `{ center: { lat, lng }, zoom, markers?: [{ lat, lng, label? }], title? }`.

## Renderer

`MapWidget.tsx` is a self-contained slippy map — **no Leaflet/MapLibre dependency**. Raster tiles are plain
`<img>`s whose URLs come from the public `{z}/{x}/{y}` scheme; the projection (`mapWidget.ts`) is pure
Web-Mercator math (unit-tested). The tile source is configurable via `VITE_MAP_TILES` (default: OpenStreetMap),
so a deployment can point at its own / a keyed provider. **Offline** (the LAN hub) the tiles just don't load and
the markers render on a blank surface — it degrades rather than breaking.

## Flag

The transport is always present (additive). The map **renderer** (and the kibitz agent emit) is gated by
`kbz.mapWidget` — default on, per-device opt-out via `localStorage['kbz.mapWidget']='0'` or
`window.__kbzMapWidget=false`, so a 2-device test can disable it on demand.
