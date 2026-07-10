import { useCallback, useEffect, useRef } from 'react'
import { inkColor } from './ink'
import type { ContentHandler, ContentMsg, InkEvent } from '../core/protocol'

export interface InkLane {
  /** Broadcast a laser/pen ink event, stamped with our own name + colour (cleared peers only). */
  sendInk: (e: InkEvent) => void
  /** Subscribe to peers' ink — single listener, matching the engine's prior onInk contract. */
  onInk: (cb: (from: string, name: string, e: InkEvent, color?: string) => void) => void
}

/**
 * The ink (laser/pen) lane as a self-contained MODULE over the content channel — the first feature extracted from
 * useCall to prove the modular shape. It owns its own state (the listener ref), REGISTERS a receive handler with
 * the engine's content-handler registry, and sends via the shared broadcastContent. The engine no longer knows
 * ink exists: deleting this hook and its one return-spread would drop the feature without touching the core.
 *
 * Deps are the stable engine primitives a module is allowed to touch: the content lane (broadcast + the registry)
 * and read-only refs for our own identity. Everything passed is reference-stable, so the hooks below never churn.
 */
export function useInk(
  broadcastContent: (m: ContentMsg) => void,
  sendAllowed: () => boolean,
  registerContentHandler: (kind: string, fn: ContentHandler) => () => void,
  nameRef: { readonly current: string },
  voiceIdRef: { readonly current: string },
): InkLane {
  const inkCbRef = useRef<((from: string, name: string, e: InkEvent, color?: string) => void) | null>(null)

  const sendInk = useCallback(
    (e: InkEvent) => {
      if (!sendAllowed()) return
      // Stamp our OWN name + colour on every event so every receiver labels/colours the stroke identically,
      // regardless of how the data-peer id resolves to a roster entry. Only cleared peers' ink renders, so safe.
      broadcastContent({
        k: 'ink',
        e,
        n: nameRef.current.trim() || undefined,
        c: voiceIdRef.current ? inkColor(voiceIdRef.current) : undefined,
      } satisfies ContentMsg)
      // eslint-disable-next-line react-hooks/exhaustive-deps -- broadcastContent + the refs are reference-stable
    },
    [sendAllowed],
  )

  const onInk = useCallback((cb: (from: string, name: string, e: InkEvent, color?: string) => void) => {
    inkCbRef.current = cb
  }, [])

  // Receive side: register with the engine's registry. The engine calls this AFTER the same roster/capability
  // gate it applies to all content, so the trust boundary is unchanged. Prefer the sender's stamped name/colour;
  // fall back to the engine-resolved roster name for older senders. Unregisters on unmount.
  useEffect(() => {
    return registerContentHandler('ink', (from, c, name) => {
      const ink = c as Extract<ContentMsg, { k: 'ink' }>
      const inkName = typeof ink.n === 'string' && ink.n.trim() ? ink.n.slice(0, 40).trim() : name
      const inkCol = typeof ink.c === 'string' && ink.c ? ink.c.slice(0, 32) : undefined
      inkCbRef.current?.(from, inkName, ink.e, inkCol)
    })
  }, [registerContentHandler])

  return { sendInk, onInk }
}
