import { useCallback, useEffect, useRef } from 'react'
import { appPayloadTooBig, tooBigToSend } from '../core/contentLimits'
import type { AppMessage, ContentHandler, ContentMsg } from '../core/protocol'

export interface AppLane {
  /** Broadcast an opaque app payload (co-browse / shared game state) to every peer. */
  sendApp: (data: unknown) => void
  /** Send an opaque app payload to one peer. */
  sendAppTo: (to: string, data: unknown) => void
  /** Subscribe to peers' app payloads (single listener, matching the engine's prior onApp). */
  onApp: (cb: (m: AppMessage) => void) => void
}

/**
 * The app lane (opaque developer payloads — co-browse, shared game state) as a self-contained module over the
 * content lane. The engine only guarantees a transport + a size backstop; rate-limiting / schema / backpressure
 * stay the app's job. Owns its single listener + registers its gated receive handler (which drops oversized
 * payloads, the receive-side DoS boundary). Delete this hook + its return-spread to remove the feature.
 */
export function useApp(
  broadcastContent: (m: ContentMsg) => void,
  meshSendTo: (to: string, msg: ContentMsg) => void,
  sendAllowed: (to?: string) => boolean,
  registerContentHandler: (kind: string, fn: ContentHandler) => () => void,
): AppLane {
  const appCbRef = useRef<((m: AppMessage) => void) | null>(null)

  const sendApp = useCallback(
    (data: unknown) => {
      if (!sendAllowed() || tooBigToSend(data)) return
      broadcastContent({ k: 'app', data } satisfies ContentMsg)
      // eslint-disable-next-line react-hooks/exhaustive-deps -- broadcastContent is reference-stable
    },
    [sendAllowed],
  )

  const sendAppTo = useCallback(
    (to: string, data: unknown) => {
      if (!sendAllowed(to) || tooBigToSend(data)) return
      meshSendTo(to, { k: 'app', data } satisfies ContentMsg)
      // eslint-disable-next-line react-hooks/exhaustive-deps -- meshSendTo is reference-stable
    },
    [sendAllowed],
  )

  const onApp = useCallback((cb: (m: AppMessage) => void) => {
    appCbRef.current = cb
  }, [])

  useEffect(() => {
    return registerContentHandler('app', (from, c) => {
      const app = c as Extract<ContentMsg, { k: 'app' }>
      if (appPayloadTooBig(app.data)) return // DoS backstop: drop an oversized app payload from a peer
      appCbRef.current?.({ from, data: app.data })
    })
  }, [registerContentHandler])

  return { sendApp, sendAppTo, onApp }
}
