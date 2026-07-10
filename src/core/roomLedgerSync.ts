// Room-state ledger — the SYNC layer (docs/room-state-ledger.md, build step 2).
//
// Wires a RoomLedger to the P2P data mesh so two browsers' ledgers converge live. Three messages on a
// reserved data-channel kind (`~kbz.ledger`, so it never collides with app traffic):
//
//   • request — "send me your current state" (a fresh joiner pulls).
//   • state   — a full snapshot, sent in reply to a request.
//   • update  — a single changed key, pushed when this peer writes locally.
//
// Mesh assumption: `broadcast` reaches every peer directly (kibitz's data channel is a P2P mesh, no relay), so
// a merge is NEVER re-broadcast — everyone already received the original. That kills any echo storm; the
// request/state handshake on join heals anyone who missed a push. Pure protocol, transport-injected, so it's
// unit-tested with an in-memory bus (roomLedgerSync.test.ts); the engine adapter just maps `LedgerWire` onto
// `broadcastData` + the inbound app-message listener.

import { type LedgerState, RoomLedger } from './roomLedger'

/** The `ContentMsg` kind these messages ride (demuxed in useCall; opaque to the app — never surfaced via the
 *  public onMessage, which only delivers `k:'app'`). */
export const LEDGER_KIND = 'ledger'

export type LedgerMsg =
  | { v: 1; op: 'request' }
  | { v: 1; op: 'state'; state: LedgerState } // reply to a request — a full snapshot
  | { v: 1; op: 'update'; state: LedgerState } // a single changed key, pushed on a local write

/** The transport seam: broadcast to all peers, and subscribe to inbound ledger messages (sender id included).
 *  The engine binds `broadcast` → `broadcastData({k: LEDGER_KIND, m})` and `onMessage` → the data listener
 *  filtered to `LEDGER_KIND`. */
export interface LedgerWire {
  broadcast(msg: LedgerMsg): void
  onMessage(cb: (from: string, msg: LedgerMsg) => void): () => void
}

/** Connect a RoomLedger to a wire. Pull state on join (call `requestSync`), reply to peers' requests, and push
 *  local writes; incoming merges are applied WITHOUT re-broadcasting. Call `close()` to detach. */
export class LedgerSync {
  private offWire: () => void
  private offLedger: () => void
  private applyingRemote = false

  constructor(
    private readonly ledger: RoomLedger,
    private readonly wire: LedgerWire,
  ) {
    this.offWire = wire.onMessage((from, msg) => this.receive(from, msg))
    this.offLedger = ledger.on((key) => this.onLocalChange(key))
  }

  /** Ask peers for their current state. Call when this peer joins and whenever a new peer appears (the data
   *  link may not have been open for the first attempt; a later peer-join re-pulls). Idempotent. */
  requestSync(): void {
    this.wire.broadcast({ v: 1, op: 'request' })
  }

  close(): void {
    this.offWire()
    this.offLedger()
  }

  private receive(_from: string, msg: LedgerMsg): void {
    if (!msg || msg.v !== 1) return // ignore unknown/forward-version frames
    if (msg.op === 'request') {
      this.wire.broadcast({ v: 1, op: 'state', state: this.ledger.snapshot() })
      return
    }
    if (msg.op === 'state' || msg.op === 'update') {
      this.applyingRemote = true // suppress re-broadcasting a change that arrived from a peer
      try {
        this.ledger.merge(msg.state)
      } finally {
        this.applyingRemote = false
      }
    }
  }

  private onLocalChange(key: string): void {
    if (this.applyingRemote) return // a merged remote change — peers already have it, don't echo
    const all = this.ledger.snapshot()
    if (key in all) this.wire.broadcast({ v: 1, op: 'update', state: { [key]: all[key] } })
  }
}
