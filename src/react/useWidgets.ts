import { useCallback, useEffect, useRef } from 'react'
import { capMap } from '../core/capMap'
import { OWN_WIDGET_CAP, SCHEMA_NAME_MAX, WIDGET_EVENTS_CAP, appPayloadTooBig, tooBigToSend } from '../core/contentLimits'
import type { ContentHandler, ContentMsg } from '../core/protocol'

export interface WidgetMessage {
  from: string
  id: string
  kind: string
  data: unknown
  replay?: readonly unknown[]
  /** The owner retracted this instance — drop it (chat + stage). kind/data are empty. */
  removed?: boolean
}

/** An interaction with a live widget instance (e.g. a viewer dropping a pin on a map), attributed by
 *  roster. `e` is opaque here — the renderer for the widget's `kind` defines the event shape. */
export interface WidgetInteraction {
  from: string
  id: string
  e: unknown
}

export interface WidgetLane {
  sendWidget: (kind: string, data: unknown, id?: string) => string
  removeWidget: (id: string) => void
  onWidget: (cb: (m: WidgetMessage) => void) => () => void
  sendWidgetEvent: (id: string, e: unknown) => void
  onWidgetEvent: (cb: (m: WidgetInteraction) => void) => () => void
  hideWidget: (id: string) => void
}

/**
 * Bounded interactive widgets (docs/map-widget.md) as a self-contained module. `sendWidget` posts an instance the
 * local app/agent OWNS; `sendWidgetEvent` broadcasts an interaction (a shared pin). The owner retains every
 * interaction and re-broadcasts the instance WITH its log on each roster change (via onRosterChange), so a late
 * joiner gets the map AND the pins already on it — order-independent, like schema discovery. Lives in the engine
 * layer (not the app) so a HEADLESS agent's widget gets the same replay with no app cooperation.
 *
 * A widget's durable, chronological home is the CHAT log, which still lives in the engine — so this module reaches
 * it through two stable callbacks (recordInChat / dropFromChat) rather than owning chat state. When chat is later
 * extracted, those callbacks become a module-to-module wire.
 */
export function useWidgets(
  broadcastContent: (m: ContentMsg) => void,
  sendAllowed: () => boolean,
  registerContentHandler: (kind: string, fn: ContentHandler) => () => void,
  onRosterChange: (fn: () => void) => () => void,
  newId: () => string,
  recordInChat: (w: { from: string; name: string; id: string; kind: string; data: unknown; ts?: number }) => void,
  dropFromChat: (id: string) => void,
  /** Live roster name of an id if PRESENT, else undefined — so a REPLAYED widget (re-broadcast by a holder that
   *  isn't the poster — see useWidgetSync) shows the original poster's current name when still here, and the carried
   *  name when they've left. Optional (falls back to the carried name / sender). */
  rosterNameOf?: (id: string) => string | undefined,
): WidgetLane {
  // `ts` is the poster's send time, retained so the owner's chat line (and its re-broadcast) is ts-ORDERED like
  // text/media; a re-post of the same id keeps the original ts (the line never jumps). `events` is unchanged.
  const ownedWidgetsRef = useRef<Map<string, { kind: string; data: unknown; events: unknown[]; ts: number }>>(new Map())
  const widgetCbsRef = useRef<Set<(m: WidgetMessage) => void>>(new Set())
  const wevtCbsRef = useRef<Set<(m: WidgetInteraction) => void>>(new Set())

  const sendWidget = useCallback(
    (kind: string, data: unknown, id?: string): string => {
      const k = (kind || '').slice(0, SCHEMA_NAME_MAX).trim()
      const wid = (id || '').slice(0, 80) || newId()
      if (!k || tooBigToSend(data) || !sendAllowed()) return wid
      const prev = ownedWidgetsRef.current.get(wid)
      const ts = prev?.ts ?? Date.now() // keep the original send time on a re-post (don't move the line)
      ownedWidgetsRef.current.set(wid, { kind: k, data, events: prev?.events ?? [], ts })
      capMap(ownedWidgetsRef.current, OWN_WIDGET_CAP)
      broadcastContent({ k: 'widget', id: wid, kind: k, data, ts } satisfies ContentMsg)
      return wid
      // eslint-disable-next-line react-hooks/exhaustive-deps -- broadcastContent is reference-stable
    },
    [sendAllowed, newId],
  )

  // Retract a widget WE posted: stop re-broadcasting it, tell peers to drop it, drop our own (broadcast never echoes).
  const removeWidget = useCallback(
    (id: string) => {
      const wid = (id || '').slice(0, 80)
      if (!wid) return
      ownedWidgetsRef.current.delete(wid)
      if (sendAllowed()) broadcastContent({ k: 'widget', id: wid, kind: '', data: null, removed: true } satisfies ContentMsg)
      for (const cb of widgetCbsRef.current) cb({ from: '', id: wid, kind: '', data: null, removed: true })
      // eslint-disable-next-line react-hooks/exhaustive-deps -- broadcastContent is reference-stable
    },
    [sendAllowed],
  )

  const onWidget = useCallback((cb: (m: WidgetMessage) => void) => {
    widgetCbsRef.current.add(cb)
    return () => {
      widgetCbsRef.current.delete(cb)
    }
  }, [])

  // Local Dismiss: drop a widget's chat record from OUR OWN log only (anti-spam / anti-phishing) — no broadcast,
  // peers keep theirs. The caller (useStageWidgets.dismiss) clears the live instance alongside it.
  const hideWidget = useCallback(
    (id: string) => {
      dropFromChat(id)
    },
    [dropFromChat],
  )

  const sendWidgetEvent = useCallback(
    (id: string, e: unknown) => {
      const wid = (id || '').slice(0, 80)
      if (!wid || tooBigToSend(e) || !sendAllowed()) return
      // A broadcast never echoes home, so if we own the instance, record our OWN interaction directly into the
      // replay log (peers' interactions arrive + are recorded in the receive handler below).
      const owned = ownedWidgetsRef.current.get(wid)
      if (owned) {
        owned.events.push(e)
        if (owned.events.length > WIDGET_EVENTS_CAP) owned.events.splice(0, owned.events.length - WIDGET_EVENTS_CAP)
      }
      broadcastContent({ k: 'wevt', id: wid, e } satisfies ContentMsg)
      // eslint-disable-next-line react-hooks/exhaustive-deps -- broadcastContent is reference-stable
    },
    [sendAllowed],
  )

  const onWidgetEvent = useCallback((cb: (m: WidgetInteraction) => void) => {
    wevtCbsRef.current.add(cb)
    return () => {
      wevtCbsRef.current.delete(cb)
    }
  }, [])

  // Receive: a posted widget (+ owner retraction) and interactions. DoS backstop on payloads; re-receiving an id
  // (owner replay) refreshes in place via recordInChat (keyed by id). Same gate the engine applies to all content.
  useEffect(() => {
    const unWidget = registerContentHandler('widget', (from, c, name) => {
      const w = c as Extract<ContentMsg, { k: 'widget' }>
      const id = typeof w.id === 'string' ? w.id.slice(0, 80) : ''
      if (!id) return
      if (w.removed) {
        for (const cb of widgetCbsRef.current) cb({ from, id, kind: '', data: null, removed: true })
        dropFromChat(id) // drop the chat record too
        return
      }
      const kind = typeof w.kind === 'string' ? w.kind.slice(0, SCHEMA_NAME_MAX).trim() : ''
      if (!kind || appPayloadTooBig(w.data)) return
      const replay = Array.isArray(w.replay) && !appPayloadTooBig(w.replay) ? w.replay.slice(0, WIDGET_EVENTS_CAP) : undefined
      // REPLAYED widget (a holder re-broadcasting one it didn't post — useWidgetSync, persistent room): when the msg
      // carries from/name, attribute it to that ORIGINAL poster for DISPLAY, preferring the live roster name if the
      // poster is still present, else the carried name. A live post / owner re-broadcast omits them → the sender.
      // UNVERIFIED + display-only — a widget's from/name never grants a verified badge (same as text/media).
      const poster = resolveWidgetAuthor(from, name, w.from, w.name, rosterNameOf)
      const ts = typeof w.ts === 'number' && Number.isFinite(w.ts) ? w.ts : undefined // the poster's send time → ts-ordered chat line
      for (const cb of widgetCbsRef.current) cb({ from: poster.from, id, kind, data: w.data, replay })
      recordInChat({ from: poster.from, name: poster.name, id, kind, data: w.data, ts }) // the chat is the widget's durable, chronological home (ordered by ts)
    })
    const unWevt = registerContentHandler('wevt', (from, c) => {
      const w = c as Extract<ContentMsg, { k: 'wevt' }>
      const id = typeof w.id === 'string' ? w.id.slice(0, 80) : ''
      if (!id || appPayloadTooBig(w.e)) return
      // If WE own that instance, fold the event into its retained log so we can replay it to late joiners.
      const owned = ownedWidgetsRef.current.get(id)
      if (owned) {
        owned.events.push(w.e)
        if (owned.events.length > WIDGET_EVENTS_CAP) owned.events.splice(0, owned.events.length - WIDGET_EVENTS_CAP)
      }
      for (const cb of wevtCbsRef.current) cb({ from, id, e: w.e })
    })
    return () => {
      unWidget()
      unWevt()
    }
  }, [registerContentHandler, recordInChat, dropFromChat, rosterNameOf])

  // Re-broadcast our owned widgets (with their interaction log) on every roster change, so a late joiner gets the
  // instance AND the shared overlay already on it. Idempotent on receive (renderer keys by id), like schemas.
  useEffect(() => {
    return onRosterChange(() => {
      if (!ownedWidgetsRef.current.size || !sendAllowed()) return
      for (const [id, w] of ownedWidgetsRef.current) {
        broadcastContent({ k: 'widget', id, kind: w.kind, data: w.data, ts: w.ts, ...(w.events.length ? { replay: w.events } : {}) } satisfies ContentMsg)
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- broadcastContent is reference-stable
  }, [onRosterChange, sendAllowed])

  return { sendWidget, removeWidget, onWidget, sendWidgetEvent, onWidgetEvent, hideWidget }
}

/** Resolve the DISPLAY poster of a received widget: the SENDER by default (secure, can't be spoofed), or the
 *  carried ORIGINAL poster (from/name) when this is a REPLAYED widget the sender didn't post (useWidgetSync) —
 *  preferring the live roster name when that poster is still present, else the carried name, else the id. Pure
 *  (rosterNameOf injected). DISPLAY-ONLY + UNVERIFIED — feeds only the plain name label (the widget bubble has no
 *  identity lookup); verified ✓ is bound to the live cert-verified connection, which this can never touch. */
export function resolveWidgetAuthor(
  sender: string,
  senderName: string,
  from: string | undefined,
  name: string | undefined,
  rosterNameOf?: (id: string) => string | undefined,
): { from: string; name: string } {
  const a = typeof from === 'string' && from.trim() ? from.trim().slice(0, 80) : ''
  if (!a) return { from: sender, name: senderName }
  const live = rosterNameOf?.(a)
  const carried = typeof name === 'string' && name.trim() ? name.trim().slice(0, 80) : ''
  return { from: a, name: live || carried || a }
}
