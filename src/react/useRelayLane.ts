import { useCallback, useEffect, useRef } from 'react'
import type { ContentHandler } from '../core/protocol'

export interface RelayLane {
  /** Broadcast an opaque message on this lane to every connected peer. */
  send: (m: unknown) => void
  /** Send an opaque message to one peer on this lane. */
  sendTo: (to: string, m: unknown) => void
  /** Subscribe; multiple listeners coexist. Returns an unsubscribe. */
  on: (cb: (from: string, m: unknown) => void) => () => void
}

/**
 * A generic opaque-message RELAY lane over the RAW data mesh — the shape behind both `ctl` (ephemeral control
 * signals) and `ledger` (room-state sync). It's a multi-listener fan-out that deliberately BYPASSES the content
 * perceive-withholding (these are transport/control, delivered to everyone regardless of read-chat grants) —
 * which is why it takes the raw mesh send, not broadcastContent. Each lane is a self-contained module: it owns
 * its listener set and registers its receive handler. Deleting a useRelayLane() call drops that lane entirely.
 */
export function useRelayLane(
  kind: string,
  meshBroadcast: (msg: unknown) => void,
  meshSendTo: (to: string, msg: unknown) => void,
  registerContentHandler: (kind: string, fn: ContentHandler) => () => void,
): RelayLane {
  const listenersRef = useRef(new Set<(from: string, m: unknown) => void>())
  const send = useCallback((m: unknown) => meshBroadcast({ k: kind, m }), [meshBroadcast, kind])
  const sendTo = useCallback((to: string, m: unknown) => meshSendTo(to, { k: kind, m }), [meshSendTo, kind])
  const on = useCallback((cb: (from: string, m: unknown) => void) => {
    listenersRef.current.add(cb)
    return () => listenersRef.current.delete(cb)
  }, [])
  useEffect(() => {
    return registerContentHandler(kind, (from, c) => {
      const m = (c as { m?: unknown }).m
      for (const cb of listenersRef.current) cb(from, m)
    })
  }, [registerContentHandler, kind])
  return { send, sendTo, on }
}
