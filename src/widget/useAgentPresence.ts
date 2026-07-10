import { useEffect, useMemo, useRef, useState } from 'react'
import { RoomLedger } from '../core/roomLedger'
import { LedgerSync, type LedgerMsg, type LedgerWire } from '../core/roomLedgerSync'
import { LedgerStore, localStorageKV, persistLedger } from '../core/roomLedgerStore'
import type { CallController } from '../react/useCall'

// Is an AI agent currently in the call? A peer tagged read-only `role:'agent'` OR a full-capability voice-assistant.
const isAgentPeer = (p: { meta?: Record<string, unknown> }) =>
  p.meta?.role === 'agent' || p.meta?.kind === 'voice-assistant'

// "Is an agent in the call, and has one ever been?" — lifted out of Widget.tsx. `agentPresent` drives the summon
// banner (shown only when NO agent is present, so you can summon or RE-summon). `agentResumable` rides the ROOM-STATE
// LEDGER (docs/room-state-ledger.md): an "agentSeen" attestation synced P2P among participants + persisted locally —
// so someone who SWITCHED BROWSERS re-syncs it from any peer who was there (cross-person, cross-reload, no server),
// and the banner reads "bring it back" (re-summon resumes memory) rather than "add an agent". Sets up the LedgerSync
// + persistence on join, attests "agentSeen" while an agent is present, and re-pulls on roster change. Verbatim move.
export function useAgentPresence(call: CallController, preview: boolean, headless: boolean, roomKey: string) {
  const agentPresent = useMemo(() => call.participants.some((p) => !p.isSelf && isAgentPeer(p)), [call.participants])
  const ledgerRef = useRef<RoomLedger>(undefined as unknown as RoomLedger)
  if (!ledgerRef.current) ledgerRef.current = new RoomLedger()
  const ledgerSyncRef = useRef<LedgerSync | null>(null)
  const selfAuthorRef = useRef(`a-${Math.random().toString(36).slice(2)}`) // an advisory author tag for our attestations
  const [agentResumable, setAgentResumable] = useState(false)
  useEffect(() => {
    if (!call.inCall || preview || headless) return
    const ledger = ledgerRef.current
    const wire: LedgerWire = {
      broadcast: (msg) => call.broadcastLedger(msg),
      onMessage: (cb) => call.onLedger((from, m) => cb(from, m as LedgerMsg)),
    }
    const sync = new LedgerSync(ledger, wire)
    ledgerSyncRef.current = sync
    const persist = persistLedger(ledger, new LedgerStore(localStorageKV(), roomKey))
    const refresh = () => setAgentResumable(ledger.has('agentSeen', Date.now()))
    const off = ledger.on(refresh)
    void persist.ready.then(refresh) // reflect any locally-persisted state once loaded
    refresh()
    sync.requestSync() // pull current state from whoever's already here
    return () => {
      off()
      sync.close()
      ledgerSyncRef.current = null
      persist.stop()
    }
    // call.broadcastLedger/onLedger are stable ([]-dep callbacks); only re-mount on room/inCall change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [call.inCall, preview, headless, roomKey])
  // Re-pull when the roster changes (a peer just joined → its data link is opening; requestSync is idempotent).
  useEffect(() => {
    ledgerSyncRef.current?.requestSync()
  }, [call.participants])
  // While an agent is in the call, attest "agentSeen" (TTL'd) — that's what makes a later re-summon read "bring
  // it back" for everyone who was here. The ledger syncs + persists it.
  useEffect(() => {
    if (!agentPresent) return
    ledgerRef.current.attest('agentSeen', true, { author: selfAuthorRef.current, expireAt: Date.now() + 7 * 24 * 60 * 60 * 1000 })
  }, [agentPresent])
  return { agentPresent, agentResumable }
}
