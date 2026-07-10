import { useCallback, useEffect, useRef } from 'react'
import { PAY_NOTE_MAX, PAY_URL_MAX } from '../core/contentLimits'
import type { ContentHandler, ContentMsg, PayRequest } from '../core/protocol'

export interface PayLane {
  /** Share a payment request (a labelled URL). `to` makes it a direct message to one peer. */
  sendPay: (label: string, url: string, to?: string) => void
  /** Subscribe to incoming payment requests (single listener, matching the engine's prior onPay). */
  onPay: (cb: (p: PayRequest) => void) => void
}

/**
 * The pay lane (a shared payment request — a labelled URL) as a self-contained module over the content lane.
 * Broadcasts ride broadcastContent (so per-recipient perceive-withholding applies); a direct send hits the mesh.
 * Owns its single listener + registers its gated receive handler. Delete this hook + its return-spread to remove.
 */
export function usePay(
  broadcastContent: (m: ContentMsg) => void,
  meshSendTo: (to: string, msg: ContentMsg) => void,
  sendAllowed: (to?: string) => boolean,
  registerContentHandler: (kind: string, fn: ContentHandler) => () => void,
): PayLane {
  const payCbRef = useRef<((p: PayRequest) => void) | null>(null)

  const sendPay = useCallback(
    (label: string, url: string, to?: string) => {
      const u = (url || '').slice(0, PAY_URL_MAX).trim()
      if (!u || !sendAllowed(to)) return
      const msg = {
        k: 'pay',
        label: (label || '').slice(0, PAY_NOTE_MAX).trim() || undefined,
        url: u,
        ...(to ? { dm: true as const } : {}),
      } satisfies ContentMsg
      if (to) meshSendTo(to, msg)
      else broadcastContent(msg)
      // eslint-disable-next-line react-hooks/exhaustive-deps -- broadcastContent + meshSendTo are reference-stable
    },
    [sendAllowed],
  )

  const onPay = useCallback((cb: (p: PayRequest) => void) => {
    payCbRef.current = cb
  }, [])

  useEffect(() => {
    return registerContentHandler('pay', (from, c, name) => {
      const pay = c as Extract<ContentMsg, { k: 'pay' }>
      const url = (pay.url || '').slice(0, PAY_URL_MAX).trim()
      if (url) payCbRef.current?.({ from, name, label: (pay.label || '').slice(0, PAY_NOTE_MAX).trim() || undefined, url, dm: !!pay.dm })
    })
  }, [registerContentHandler])

  return { sendPay, onPay }
}
