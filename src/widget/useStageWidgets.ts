import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { applyMapEvent, clampLat, clampZoom, MAP_WIDGET_KIND, type MapData, type MapPin, normLng, sanitizeMapData } from './mapWidget'
import { getWidgetKind } from './widgets/registry'
import { nextStageWAt, pickStagedWidget } from '../react/stageWidget'
import { mapWidgetOn, type CallController } from '../react/useCall'

// Display widgets that aren't auto-staged: interactive ones (a form/app) stay in chat where you fill them in.
const NO_AUTOSTAGE = new Set(['kbz.form', 'kbz.app'])

export type MapInst = { from: string; data: MapData; pins: readonly MapPin[]; view?: { center: { lat: number; lng: number }; zoom: number } }
export type WidgetInst = { from: string; kind: string; data: unknown }

// The bounded-widget + shared-stage subsystem, lifted out of Widget.tsx (~160 lines): subscribe to posted
// map/widget instances on the `widget` channel (+ `wevt` pin events, + `ctl` lockstep map-view frames), hold them
// keyed by id, and drive the shared STAGE pointer (roster-meta, anyone-can-push). Returns the instance maps + the
// staging handlers consumed by StagedWidget (the shared stage) and the in-chat WidgetBubble (the in-log card). A pure move
// out of the component — every effect + dependency array is preserved. mapWidgetOn gates the map path entirely.
export function useStageWidgets(call: CallController, preview: boolean) {
  // Bounded interactive widgets (docs/map-widget.md). Keyed by instance id; pins fold from `wevt` events
  // (idempotent). Only MAP_WIDGET_KIND renders, behind the kbz.mapWidget flag — an unknown kind is ignored.
  const [mapInstances, setMapInstances] = useState<ReadonlyMap<string, MapInst>>(() => new Map())
  // Generic registered widget kinds (table/doc/media/chart/diagram/form — widgets/registry). The map keeps its
  // own bespoke path above (pins/lockstep); these share the same transport + stage, rendered by kind via the
  // lazy registry. Sanitized at receipt; an unknown kind is ignored.
  const [widgetInstances, setWidgetInstances] = useState<ReadonlyMap<string, WidgetInst>>(() => new Map())

  // Bounded interactive widgets (map): subscribe to posted instances + their shared interactions. A map
  // arrives on the `widget` channel (with an optional replay log for late joiners); pins arrive on `wevt`.
  // Gated by the kbz.mapWidget flag — off, we ignore them entirely (graceful: no render, transport still flows).
  useEffect(() => {
    const offWidget = call.onWidget(({ id, from, kind, data, replay, removed }) => {
      if (removed) {
        // The owner retracted it (e.g. a media that failed to render) — drop the instance; if it was staged,
        // the stage render is guarded on widgetInstances.has(id), so it clears itself.
        setWidgetInstances((prev) => {
          if (!prev.has(id)) return prev
          const next = new Map(prev)
          next.delete(id)
          return next
        })
        setMapInstances((prev) => {
          if (!prev.has(id)) return prev
          const next = new Map(prev)
          next.delete(id)
          return next
        })
        return
      }
      if (kind === MAP_WIDGET_KIND) {
        if (!mapWidgetOn()) return
        const md = sanitizeMapData(data)
        if (!md) return
        setMapInstances((prev) => {
          const next = new Map(prev)
          let pins = prev.get(id)?.pins ?? []
          for (const e of replay ?? []) pins = applyMapEvent(pins, e) // fold the owner's late-joiner replay
          next.set(id, { from, data: md, pins })
          return next
        })
        return
      }
      // Generic registered kinds (table/doc/media/…): sanitize the untrusted payload, then store for lazy render.
      const spec = getWidgetKind(kind)
      if (!spec) return
      const clean = spec.sanitize(data)
      if (clean == null) return
      setWidgetInstances((prev) => {
        const next = new Map(prev)
        next.set(id, { from, kind, data: clean })
        return next
      })
    })
    const offEvent = call.onWidgetEvent(({ id, from, e }) => {
      setMapInstances((prev) => {
        const inst = prev.get(id)
        if (!inst) return prev
        // Attribute a pin to the sender via the roster (unspoofable), not whatever name rode the wire.
        const byName = call.participants.find((p) => p.id === from)?.name
        const ev =
          e && typeof e === 'object' && (e as { t?: string }).t === 'pin'
            ? { ...(e as object), pin: { ...((e as { pin?: object }).pin ?? {}), by: byName } }
            : e
        const next = new Map(prev)
        next.set(id, { ...inst, pins: applyMapEvent(inst.pins, ev) })
        return next
      })
    })
    return () => {
      offWidget?.()
      offEvent?.()
    }
  }, [call.onWidget, call.onWidgetEvent, call.participants])

  // Drop a shared pin: broadcast it (peers fold it in) AND apply locally — a broadcast never echoes home, so
  // the dropper must add its own pin. The pin id makes both paths idempotent if the owner later replays it.
  const dropMapPin = useCallback(
    (widgetId: string, lat: number, lng: number) => {
      const selfName = call.participants.find((p) => p.isSelf)?.name || 'You'
      const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
      const pin: MapPin = { id: c?.randomUUID ? c.randomUUID() : `pin-${Date.now()}-${Math.floor(Math.random() * 1e6)}`, lat, lng, by: selfName }
      call.sendWidgetEvent(widgetId, { t: 'pin', pin })
      setMapInstances((prev) => {
        const inst = prev.get(widgetId)
        if (!inst) return prev
        const next = new Map(prev)
        next.set(widgetId, { ...inst, pins: applyMapEvent(inst.pins, { t: 'pin', pin }) })
        return next
      })
    },
    [call.participants, call.sendWidgetEvent],
  )
  // LOCKSTEP for the staged map ("follow the driver"): the shared viewport rides the EPHEMERAL ctl channel
  // (not the retained wevt log — a stream of pan frames must never evict pins from replay). Whoever pans/zooms
  // the staged map drives; everyone else snaps to it. A late joiner opens at the map's own centre and snaps on
  // the next drive (the view is live, not persisted — by design).
  useEffect(() => {
    if (!mapWidgetOn()) return
    return call.onCtl((_from, m) => {
      const d = m as { t?: string; id?: string; center?: { lat?: unknown; lng?: unknown }; zoom?: unknown } | null
      if (!d || d.t !== 'mapview' || typeof d.id !== 'string') return
      const lat = Number(d.center?.lat)
      const lng = Number(d.center?.lng)
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return
      const v = { center: { lat: clampLat(lat), lng: normLng(lng) }, zoom: clampZoom(Number(d.zoom)) }
      setMapInstances((prev) => {
        const inst = prev.get(d.id!)
        if (!inst) return prev
        const next = new Map(prev)
        next.set(d.id!, { ...inst, view: v })
        return next
      })
    })
  }, [call.onCtl])
  // Drive the staged map's shared viewport: broadcast over ctl (followers snap) AND apply locally (so our own
  // chat-card/stage stay in sync and a re-render keeps the position).
  const driveMapView = useCallback(
    (widgetId: string, center: { lat: number; lng: number }, zoom: number) => {
      call.sendCtl({ t: 'mapview', id: widgetId, center, zoom })
      setMapInstances((prev) => {
        const inst = prev.get(widgetId)
        if (!inst) return prev
        const next = new Map(prev)
        next.set(widgetId, { ...inst, view: { center, zoom } })
        return next
      })
    },
    [call.sendCtl],
  )
  // Which widget is on the STAGE — a shared, anyone-can-drive pointer carried in roster meta (stageWidget.ts),
  // exactly like the screen-share presenter convention. So ANY participant pushes a map to the big stage (not
  // just whoever posted it); the newest push wins; it rides the roster so a late joiner sees it too.
  const stagedWidget = useMemo(() => pickStagedWidget(call.participants), [call.participants])
  // Push a widget to the stage (or take it down) by advertising it in OUR OWN meta. Merge with existing meta so
  // a host-set seat/userId survives; bump stageWAt past everyone so this push wins the stage.
  const stageMapWidget = useCallback(
    (widgetId: string | null) => {
      const selfMeta = call.participants.find((p) => p.isSelf)?.meta ?? {}
      // Push: advertise the widget with a fresh seq (and drop any old self-clear). Clear: a tombstone with a
      // fresh seq so it beats the newest push — that's what lets ANYONE take a widget off the stage.
      if (widgetId) call.setMeta({ ...selfMeta, stageWidget: widgetId, stageWAt: nextStageWAt(call.participants), stageClearAt: undefined })
      else call.setMeta({ ...selfMeta, stageWidget: undefined, stageClearAt: nextStageWAt(call.participants) })
    },
    [call.participants, call.setMeta],
  )
  // Is anyone screen-sharing / presenting right now? An auto-staged widget yields to a live presentation (the
  // screen-share owns the stage) — both at promote-time (below) and at render-time (the overlay gate).
  const someonePresenting = useMemo(
    () => call.participants.some((p) => p.sharing || (p.meta as { presenting?: unknown })?.presenting),
    [call.participants],
  )
  // Auto-stage a newly-arrived DISPLAY widget so a requested chart/table/map surfaces on the shared stage at
  // once (esp. voice-first, where chat is often closed) instead of being buried in chat. Each id is handled
  // exactly once — never retroactively re-staged or fought against a manual ✕ Off stage. Skipped while anyone
  // presents; interactive kinds (form/app) stay in chat.
  const autoStagedRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!call.inCall || preview) return
    const arrivals: ReadonlyArray<readonly [string, string]> = [
      ...[...mapInstances.keys()].map((id) => [id, MAP_WIDGET_KIND] as const),
      ...[...widgetInstances].map(([id, inst]) => [id, inst.kind] as const),
    ]
    for (const [id, kind] of arrivals) {
      if (autoStagedRef.current.has(id)) continue
      autoStagedRef.current.add(id)
      if (!NO_AUTOSTAGE.has(kind) && !someonePresenting) stageMapWidget(id)
    }
  }, [mapInstances, widgetInstances, someonePresenting, stageMapWidget, call.inCall, preview])

  // Local Dismiss: remove a widget from OUR view entirely — the live instance (so any stage render clears, guarded
  // on the maps) AND its chat record (call.hideWidget). No broadcast; peers keep theirs.
  const dismiss = useCallback(
    (id: string) => {
      setMapInstances((prev) => {
        if (!prev.has(id)) return prev
        const next = new Map(prev)
        next.delete(id)
        return next
      })
      setWidgetInstances((prev) => {
        if (!prev.has(id)) return prev
        const next = new Map(prev)
        next.delete(id)
        return next
      })
      call.hideWidget(id)
    },
    [call.hideWidget],
  )

  return { mapInstances, widgetInstances, setWidgetInstances, stagedWidget, someonePresenting, dropMapPin, driveMapView, stageMapWidget, dismiss }
}
