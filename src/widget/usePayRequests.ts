import { useCallback, useEffect, useRef, useState } from 'react'
import { normalizePayLink } from '../core/payLink'
import type { PayRequest } from '../core/protocol'
import type { CallController } from '../react/useCall'

export type PayItem = PayRequest & { id: number; self: boolean }

// The "pay me" link subsystem, lifted out of Widget.tsx. Incoming pay requests arrive peer-to-peer over the data
// mesh (you never receive your own back — no relay echo — so every card is someone else's; capped at 8), plus the
// small in-chat composer that sends one: a validated link (https / Stripe-PayPal / bitcoin: / lightning:) + an
// optional note, directed to the current recipient or the whole room. Returns the request list + composer state +
// the sender, consumed by the pay banners and the pay form. A pure move — effect + dependency arrays preserved.
export function usePayRequests(call: CallController, recipientId: string | null) {
  const [payRequests, setPayRequests] = useState<readonly PayItem[]>([])
  const [payDismissed, setPayDismissed] = useState<ReadonlySet<number>>(() => new Set())
  const [payOpen, setPayOpen] = useState(false)
  const [payDraft, setPayDraft] = useState('') // the payment link
  const [payNote, setPayNote] = useState('') // optional note (what / how much)
  const [payErr, setPayErr] = useState<string | null>(null)
  const paySeqRef = useRef(0)

  // Incoming "pay me" requests — peer-to-peer over the data mesh now. You never
  // receive your own back (no relay echo), so every card is someone else's. Capped.
  useEffect(() => {
    call.onPay((p) => {
      paySeqRef.current += 1
      setPayRequests((prev) => [...prev, { ...p, id: paySeqRef.current, self: false }].slice(-8))
    })
  }, [call.onPay])

  const sendPayRequest = useCallback(() => {
    const link = normalizePayLink(payDraft)
    if (!link) {
      setPayErr('Enter a valid payment link (https://…, a Stripe/PayPal link, or a bitcoin:/lightning: URI).')
      return
    }
    call.sendPay(payNote.trim(), link.display, recipientId ?? undefined)
    setPayDraft('')
    setPayNote('')
    setPayErr(null)
    setPayOpen(false)
  }, [call.sendPay, payDraft, payNote, recipientId])

  return {
    payRequests,
    payDismissed,
    setPayDismissed,
    payOpen,
    setPayOpen,
    payDraft,
    setPayDraft,
    payNote,
    setPayNote,
    payErr,
    setPayErr,
    sendPayRequest,
  }
}
