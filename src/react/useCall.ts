import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AUDIO,
  type CamFacing,
  closeSilentAudio,
  createPlaceholderAudioTrack,
  createPlaceholderVideoTrack,
  isIOS,
  isStandaloneApp,
  micErrorMessage,
  stopStream,
  VIDEO,
  videoConstraints,
} from '../core/media'
import type { VoiceMesh } from '../core/mesh'
import { admitMembers } from '../core/mesh' // cap HUMANS the mesh connects to (collusion-resistant half of the room cap)
import { splitRoomHash } from '../core/joinGateLink' // read the room link's cap=N (max humans) — a cooperative cap
import type { SafetyInfo } from '../core/safetyCode'
import type { ConnInfo } from '../core/connStats'
import { planRevive, trackDead } from './mediaRevive'
import { type CallMedia, peerJsMedia } from '../core/callMedia'
import { useInk } from './useInk'
import { useApp } from './useApp'
import { usePay } from './usePay'
import { useRelayLane } from './useRelayLane'
import { useSchema } from './useSchema'
import { useWidgets } from './useWidgets'
import { capMap } from '../core/capMap'
import type { SchemaInfo } from './useSchema'
import type { WidgetMessage, WidgetInteraction } from './useWidgets'
export type { SchemaInfo } from './useSchema' // re-export for consumers that import SchemaInfo from useCall
export type { WidgetMessage, WidgetInteraction } from './useWidgets' // re-export for consumers
import type { AppMessage, CallMember, ChatMessage, ContentHandler, ContentMsg, InkEvent, PayRequest } from '../core/protocol'
import type { RoomLink } from '../core/room'
import {
  type AcceptedProvider,
  type IdentityConfig,
  type IdentityProvider,
  type VerifiedIdentity,
  discoveryIssuerFor,
  issuersFor,
  verifyPeerIdentity,
  verifyPeerMulti,
} from '../core/identity'
import { emailCodeProvider } from '../core/emailProvider'
import { getGrant } from '../core/grant'
import { certFingerprint, generatePinnedCert } from '../core/identityCert'
import { nonceForFingerprint } from '../core/oidcBinding'
import { signAgentAssertion, importAgentPrivateKey } from '../core/agentKey'
import { unsealHostKey, importHostPrivateKey, signHostCommand, type HostOp } from '../core/hostKey'
import { createJwksResolver } from '../core/oidcJwks'
import { providerFor } from '../core/identityProviders'
import { evaluateRosterGate, peerCleared, type RosterGateView } from '../core/rosterGate'
import { rosterHoldOn } from '../core/rosterHold'
import { canAct, canPerceive, defaultGrant, effectiveGrant, sanitizeGrant, type Grant, type Perceive } from '../core/capabilities'
import { sanitizeImg, imgTooBig, type ImagePayload } from './imageAttach'
import { chatItemFromSeedLine } from './seedChat'
import { serializeLedger, deserializeLedger, type LedgerItem } from './ledgerSnapshot'
import { XFER, type XferKind, type XferBegin, validateBegin, Reassembler, splitChunks, chunkCount, bytesToBase64, base64ToBytes, bytesToText, isBase64, encodeChunkFrame, decodeChunkFrame, asBytes, minSendProgress, allSendsComplete } from '../core/contentXfer'
import { BlobStore, memBlobKV, blobHash } from '../core/blobStore'
import { BlobSync, type BlobWire, type BlobMsg } from '../core/blobSync'
import { RoomLedger } from '../core/roomLedger'
import { LedgerSync, type LedgerMsg, type LedgerWire } from '../core/roomLedgerSync'
import { chatToLedger, ledgerToChat } from './chatLedger'
import { DiskReassembler, fitsTransfer, sendRouteFor, SINK_MAX_BYTES, type SinkKind } from '../core/chunkSink'
import { Sha256, sha256Hex, sha256HexOfBlob } from '../core/sha256'
import { createReceiveSink, detectSinkCaps, estimateStorage, reopenOpfsSink } from './chunkSinkWeb'
import { savePartial, deletePartial, loadPartials, findSendKeyByXid, type KV } from '../core/xferPersist'
import { checkRetired, type RetirementCheck } from '../core/minVersion'
import { decideStale, PROTOCOL_VERSION } from '../core/buildGate'

/** This build's SemVer (baked by the vite configs); falls back to 0.0.0 in any unsubstituted context. */
const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0'
/** This build's exact identity ('<sha> · <UTC>', baked by vite.build-id) — advertised on the roster so a
 *  STALE peer (cached old tab) detects a strictly-newer peer and reloads to converge (core/buildGate). */
const BUILD_ID = typeof __BUILD_ID__ !== 'undefined' ? __BUILD_ID__ : 'dev'
/** The deployment's kill-switch file, at the ORIGIN this bundle was served from (so a self-hoster
 *  controls their own floor, and kibitz.chat can retire its own pinned /v<x>/widget.js builds). */
const MIN_VERSION_URL = (() => {
  try {
    return new URL('/min-version.json', import.meta.url).href
  } catch {
    return '/min-version.json'
  }
})()

// Feature negotiation (COMPATIBILITY.md): the capability tags THIS build speaks. Advertised on the
// roster so a newer peer can see what an older one supports and down-level. Versioned + additive —
// add tags, never repurpose. (Old builds simply don't list a tag they don't have.)
const ENGINE_FEATURES: readonly string[] = [
  'chat.v1',
  'app.v1',
  'ink.v1',
  'pay.v1',
  'caps.v1',
  'identity.v1',
  'schema.v1',
  'xfer.v1', // unified chunked content transfer (text/image/file). A peer without it gets legacy chat/img.
  'xfer.v2', // chunk payloads sent as RAW binary frames (no base64). A peer with only xfer.v1 gets base64 chunks.
  'xfer.dl', // can RECEIVE a >1GB pull transfer straight to a chosen disk file (the offer/xaccept handshake). Advertised only when this build can actually save to disk (File System Access). A peer without it is never offered an over-quota file.
  'xfer.resume', // can drive/answer a same-session RESUME of a stalled streamed transfer (xresume/xack). Both sides must advertise it; otherwise a dropped transfer fails as before.
  'widget.v1', // can transport BOUNDED interactive widgets (a map an agent posts) + shared interactions, with owner-driven late-joiner replay. Additive: a peer without it ignores the `widget`/`wevt` kinds.
]
// Reserved roster-meta key carrying { v: engineVersion, f: features } — rides the existing `meta`
// channel (no protocol change), and is STRIPPED from the app-facing `participant.meta` so the app's
// namespace stays clean (the engine version/features surface as `participant.engine`/`features`).
// The key is a compatibility CONTRACT (a peer that predates it just leaves it absent); see
// versionSkew.test.ts. Exported so that test can pin the strip/passthrough both ways.
export const META_ENGINE = '~kbz'
export function readEngineMeta(meta: Record<string, unknown> | undefined): {
  engine?: string
  build?: string
  protocol?: number
  features?: readonly string[]
  appMeta: Record<string, unknown>
} {
  if (!meta || typeof meta !== 'object') return { appMeta: {} }
  const { [META_ENGINE]: e, ...appMeta } = meta as Record<string, unknown>
  const em = (e && typeof e === 'object' ? e : {}) as { v?: unknown; b?: unknown; f?: unknown; p?: unknown }
  return {
    engine: typeof em.v === 'string' ? em.v : undefined,
    // The peer's exact build identity ('<sha> · <UTC>') — self-asserted, advisory; informational only now.
    build: typeof em.b === 'string' ? em.b.slice(0, 64) : undefined,
    // The peer's wire-protocol generation — drives the compatibility gate (buildGate). Missing ⇒ a pre-field client.
    protocol: typeof em.p === 'number' && Number.isFinite(em.p) ? em.p : undefined,
    // Bound the list: it's self-asserted by the peer (advisory, not trusted) and rides every roster.
    features: Array.isArray(em.f)
      ? (em.f.filter((x) => typeof x === 'string').slice(0, FEATURES_MAX) as string[])
      : undefined,
    appMeta,
  }
}

// Caps applied on RECEIVE — content now arrives directly from peers, so the trust
// boundary is here, not a central relay. (Senders also cap, belt-and-suspenders.)
const CHAT_MAX_LEN = 500
const JWT_MAX = 8192 // a Google RS256 ID token is ~1KB; this is a generous DoS guard
const FEATURES_MAX = 64 // bound a peer's advertised feature-tag list (self-asserted, untrusted)
// App-payload + pay limits/validators moved to ../core/contentLimits (shared with the feature modules — importing
// back from the engine would be a cycle). appPayloadTooBig + tooBigToSend are imported above for internal use;
// re-export the two the test/consumers still pull from here.
export { APP_MAX_BYTES, appPayloadTooBig } from '../core/contentLimits'
const IDTOKEN_CAP = 100 // bound the per-peer token/verify maps in a long-lived widget

/** Evict the oldest entry once a Map exceeds `cap` (insertion-order, so departed peers
 *  age out first). Stale entries are never READ — getIdentity is only called for current
 *  participants — so this just bounds memory. */

/** The display name for a sender id, from the roster (never the wire — unspoofable). */
export function rosterName(roster: readonly CallMember[], id: string): string {
  return roster.find((m) => m.id === id)?.name || 'Guest'
}

/** The roster name of `id` ONLY if it's currently present, else undefined (NOT the 'Guest' fallback). Lets the
 *  replayed-author resolver prefer a live name when the original author is still here, and fall back to the carried
 *  name (persistence) when they've left. Pure. */
export function presentRosterNameOf(roster: readonly CallMember[], id: string): string | undefined {
  return roster.find((m) => m.id === id)?.name || undefined
}

/** Narrow an opaque mesh message to a known content envelope, or null. */
export function asContent(msg: unknown): ContentMsg | null {
  if (!msg || typeof msg !== 'object') return null
  const k = (msg as { k?: unknown }).k
  return k === 'chat' ||
    k === 'img' ||
    k === 'xbegin' ||
    k === 'xchunk' ||
    k === 'xend' ||
    k === 'xcancel' ||
    k === 'xaccept' ||
    k === 'xdecline' ||
    k === 'xresume' ||
    k === 'xack' ||
    k === 'app' ||
    k === 'pay' ||
    k === 'ink' ||
    k === 'idtoken' ||
    k === 'caps' ||
    k === 'schema' ||
    k === 'ledger' ||
    k === 'chatledger' ||
    k === 'ctl' ||
    k === 'blob' ||
    k === 'blobdata' ||
    k === 'widget' ||
    k === 'wevt'
    ? (msg as ContentMsg)
    : null
}

/** A raw binary mesh message (an xfer.v2 chunk frame) → a synthetic `xchunk` content msg carrying the raw
 *  bytes, so it flows through the SAME roster-gate + capability checks + handler as a base64 xchunk. null
 *  when `raw` isn't a binary frame (then we fall back to JSON `asContent`). */
export function asBinaryChunk(raw: unknown): (ContentMsg & { k: 'xchunk' }) | null {
  const bytes = asBytes(raw)
  if (!bytes) return null
  const f = decodeChunkFrame(bytes)
  return f ? { k: 'xchunk', id: f.id, i: f.i, bytes: f.bytes } : null
}

/** The room seam useCall needs — satisfied by both the online Room and the
 * offline LanRoom (it only ever touches `link`). */
export interface CallRoom {
  link: RoomLink
  /** Optional: re-establish the data connection (after media permission unlocks
   *  real ICE candidates on iOS). Absent on the preview/LAN rooms. */
  reconnect?(): void
  /** Am I the room authority? Used to decide whether to BROADCAST capability grants.
   *  Absent on preview/LAN rooms → treated as not-authority (no distribution). */
  isAuthority?(): boolean
  /** The current authority's media id — used to ACCEPT a capability broadcast only from the
   *  authority (a non-authority peer can't forge grants). '' / absent → no trusted source. */
  hostId?(): string
  /** True iff a CRYPTOGRAPHIC host tier (key/OIDC) governs the room. A distributed caps map is honored
   *  ONLY then — a soft-name host is spoofable by any link-holder. Absent → treat as not-cryptographic. */
  hostTierIsCryptographic?(): boolean
  // Direct authority moderation (online Room only; absent on preview/LAN). Used by the SOFT-host tier,
  // which has no key to sign with — these no-op unless we're the coordinator, scoping it accordingly.
  setLobby?(on: boolean): void
  setLocked?(on: boolean): void
  resetRoom?(): void
  admit?(id: string): void
  deny?(id: string): void
  remove?(memberId: string): void
  /** OIDC host: mark a member the verified host once we've verified their committed email (authority only). */
  declareHost?(memberId: string): void
}

/** One rendered chat line. */
export interface ChatItem extends ChatMessage {
  id: number
  self: boolean
  /** A STABLE, sender-assigned global id (`${fromMediaId}#${senderSeq}`) used to DEDUP a line across the
   *  late-joiner public-chat reconciliation (an author re-broadcasts its own public lines on every roster
   *  change; receivers merge by `mid`). A line from an older peer carries none; the receiver assigns a
   *  fallback (`${from}#r${localSeq}`) so it still has a stable identity for that session. */
  mid?: string
  /** The sender's wall-clock ms at send — the ORDER key for the reconciled public-chat union (ascending,
   *  tie-broken by `mid`). A line from an older peer (no `ts`) is assigned the receive time as a fallback. */
  ts?: number
  /** A private (directed) message — sent to / received from one person only. */
  dm?: boolean
  /** Self lines only: the recipient's display name of a DM we sent. */
  to?: string
  /** Present when this line is a LEGACY single-message image (`k:'img'`) from an older peer; `text`
   *  is then empty. New images arrive as transfers and use `attachment` instead. */
  image?: ImagePayload
  /** Present when this line is a chunked transfer (image or file) — shown with a progress bar while
   *  in flight, then a thumbnail (image) / download chip (file) once `state:'done'`. `text` is empty. */
  attachment?: Attachment
  /** Present when this line is a bounded widget an agent posted (map/table/doc/chart/…). The chat IS the
   *  durable home: it's recorded here chronologically and stays for the session. `data` is the raw payload as
   *  received (sanitized at render by the kind's renderer); the live interactive instance (pins/lockstep) is
   *  looked up by `id` in useStageWidgets when present, else this snapshot renders statically. Saveable to disk. */
  widget?: { id: string; kind: string; data: unknown }
}

/** A chunked content transfer rendered in chat — its live state + (once complete) a renderable/saveable
 *  object URL. For an image the URL is shown inline; for a file it's a download link. */
export interface Attachment {
  /** Stable transfer id (so progress updates target the right line). */
  xid: string
  kind: 'image' | 'file'
  mime: string
  name?: string
  /** Total bytes (for the size label + progress denominator). */
  size: number
  /** Object URL of the assembled bytes — set once `state:'done'` (absent for a download-tier file, which
   *  streamed straight to the user's disk → no in-memory copy to preview). Revoked when the buffer drops it. */
  url?: string
  /** 0..1 while transferring. */
  progress: number
  /** active = transferring · done = complete · failed · cancelled = stopped by either side mid-transfer ·
   *  offered = a >1GB PULL transfer awaiting the receiver's "Accept & save" (they pick a disk location,
   *  which the browser requires a gesture for). */
  state: 'active' | 'done' | 'failed' | 'cancelled' | 'offered'
  /** This transfer streamed straight to the user's chosen disk file (the download tier) — the done chip
   *  shows "Saved", not an in-page preview/Save link. */
  saved?: boolean
  /** Why a 'failed' transfer failed (shown to the user) — e.g. "too large (80 MB) — 50 MB max". */
  reason?: string
  /** The completed bytes as base64 — RETAINED only for an in-RAM transfer at/under the ledger cap, so the
   *  durable chat ledger can persist the upload and re-render it on rehydrate (serializeLedger reads this).
   *  Absent for a disk-streamed (>50MB) or over-cap transfer → the ledger keeps metadata only. */
  data?: string
  /** The bytes' content hash (sha256) — the ref into the content-addressed blob store, so a peer can fetch
   *  these bytes by hash (unified room sync). Stamped for a public in-RAM upload when ROOM_SYNC_V2 is on. */
  hash?: string
}

// --- Chunked content transfer (send side) ---------------------------------------------------------
/** Pause feeding chunks while a peer's data channel has more than this buffered — keeps a big transfer from
 *  ballooning memory / overrunning the channel, and bounds how much a dropped link must re-send on resume.
 *  4MB (was 1MB): on a HIGH-LATENCY / relayed link a small window caps throughput to ~window/RTT (1MB at
 *  100ms RTT = only 10 MB/s, no matter the bandwidth); 4MB lifts that 4×. Kept BELOW PeerJS's 8MB
 *  MAX_BUFFERED_AMOUNT so the bytes wait in the readable SCTP send buffer, not PeerJS's unbounded internal queue. */
const XFER_HIGH_WATER = 4 << 20
/** Poll interval while paused on backpressure. */
const XFER_POLL_MS = 25
/** Max wait for a peer's BULK content channel to open before an in-memory transfer's xbegin (so its chunks can't
 *  straddle the sig→bulk handover). A peer that never opens one (old / pre-handshake) bails after this; the
 *  public-chat reconciliation re-delivers the item once that peer reloads onto the new build. */
const XFER_BULK_WAIT_MS = 4000
/** Read the source File this many bytes at a time, then emit CHUNK_BYTES wire frames from the slab. Decouples
 *  the (async, per-read) disk read from the (small, fixed) wire-chunk size: one read replaces ~32 separate 48KB
 *  `slice().arrayBuffer()` awaits, cutting the streaming path's per-chunk async overhead ~32×. The wire unit
 *  (CHUNK_BYTES, the chunk INDEX → disk offset) is unchanged, so the receiver is unaffected. MUST be a whole
 *  multiple of CHUNK_BYTES, else a slab's trailing frame would be a partial MID-file chunk and break the
 *  receiver's `index × CHUNK_BYTES` offset math (only the file's FINAL chunk may be short). ~1.5MB. */
const XFER_READ_SLAB = XFER.CHUNK_BYTES * 32
const xferDelay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
/** Unified-sync media crosses the wire ONCE per peer: a shared file is BOTH pushed directly (chunked xfer, to
 *  peers present when it's shared) AND advertised as a hash ref in the chat ledger. To avoid transferring it
 *  twice, a peer that sees the ledger ref waits this long before pulling by hash — long enough for the direct
 *  push's `xbegin` to arrive and CLAIM the line (recvMediaMids). Only a peer with no direct push coming — a late
 *  joiner — actually fetches. Best-effort: if the direct push is slower than this, it falls back to the old
 *  (now non-stuck) both-paths behaviour, so it's strictly an improvement, never a stall. */
const BLOB_FETCH_GRACE_MS = 1500

// ⚠️ LARGE-TRANSFER FLAGS — NOW DEFAULT-ON (per the product owner). The whole stack (stream-to-disk, binary
// frames, SHA-256 integrity, resume; docs/large-transfer.md) is unit-tested but INTEGRATION-untested on real
// devices. DO NOT DEPLOY this branch live until the 2-device + iPhone runbook (docs/large-transfer-test.md)
// passes — default-on means a deploy ships these paths to kibitz.chat + branded siblings for everyone at once.
// Each flag is default-ON with an explicit per-device opt-OUT: localStorage 'kbz.<flag>'='0' (or
// window.__kbz<Flag>=false) disables it (used for the regression row + to kill a misbehaving path on-device).
const xferFlagOn = (key: string, winProp: string): boolean => {
  try {
    const w = (globalThis as Record<string, unknown>)[winProp]
    if (w === false) return false
    if (w === true) return true
    return globalThis.localStorage?.getItem(key) !== '0' // default ON; '0' opts out
  } catch {
    return true
  }
}
// Share-AUDIO lane (a shared screen's / staged clip's sound on a 2nd audio m-line, parallel to the share VIDEO
// lane). HISTORY: shipping it ON added a 4th m-line to EVERY call's offer and broke media negotiation outright on
// real devices (Chrome↔iOS Safari saw `remote 0` — no audio/video at all), so it was made opt-in / default OFF.
// 2026-07-03: DEFAULT ON — and the old break is device-CONFIRMED FIXED on current WebKit: a live Samsung/Chrome↔
// iPhone/Safari call connected cleanly AND viewers heard the staged clip's audio. The 4th-m-line bug aged out of
// modern Safari, so KEEP THIS ON (don't be scared back to opt-in by the history above). ESCAPE HATCH if some NEW
// regression appears: `?shareaudio=0` (sticky, boot-persisted like ?relay) / kbz.shareAudio='0' / __kbzShareAudio=false.
const shareAudioOn = (): boolean => {
  try {
    const w = (globalThis as Record<string, unknown>)['__kbzShareAudio']
    if (w === true) return true
    if (w === false) return false
    const p = new URLSearchParams(globalThis.location?.search ?? '').get('shareaudio')
    if (p === '0' || p === '1') globalThis.localStorage?.setItem('kbz.shareAudio', p)
    return globalThis.localStorage?.getItem('kbz.shareAudio') !== '0' // DEFAULT ON; '0' opts OUT
  } catch {
    return true
  }
}
// Streamed large-file transfer: above the in-RAM cap, stream to disk (OPFS/FSA) on receive + lazy-slice on
// send, up to the per-sink tier. Self-gates on OPFS/FSA support; everything ≤cap keeps the in-RAM path.
const largeXferOn = (): boolean => xferFlagOn('kbz.largeXfer', '__kbzLargeXfer')
// Raw BINARY chunk frames instead of base64 (negotiated via xfer.v2). Device-unknown: PeerJS round-tripping a
// Uint8Array as a binary type — set 'kbz.xferV2'='0' to fall back to base64 if a transfer arrives corrupt.
const xferV2On = (): boolean => xferFlagOn('kbz.xferV2', '__kbzXferV2')
// SHA-256 integrity: the sender puts a hash in xend; the receiver verifies + FAILS on mismatch (additive —
// old peers ignore it). Pure + NIST-verified, no device unknown.
const xferHashOn = (): boolean => xferFlagOn('kbz.xferHash', '__kbzXferHash')
// Unified room sync (docs/unified-room-sync.md): route the chat union through the roomLedger CRDT + a
// content-addressed blob store (bytes by hash, fetched on demand — no replay caps). Every v2 path (stampBlob, the
// blob/chatledger lanes, the mirror, reconstruct) gates on this ONE function, so it's the master on/off switch.
//
// ⛔ TEMPORARILY DISABLED BY DEFAULT (2026-07-02): the ledger/blob path caused device trouble (Samsung renderer
// OOM from the 256MB in-RAM blob store; double-transfer + reconstruct races). Turned OFF here centrally while the
// memory + one-transfer rework lands — the whole feature (code, brand flag, main.tsx window flag, kibitz env)
// stays intact and inert. RE-ENABLE BY DEFAULT: set ROOM_SYNC_V2_DEFAULT_ON = true (restores the brand-flag
// behaviour). A developer can still opt a single device in RIGHT NOW for testing with
// localStorage['kbz.roomSyncV2']='1' (that explicit opt-in wins over the kill).
/** Shallow-equal for a roster-meta object — same keys, same (===) values. Lets setMeta skip a redundant
 *  re-broadcast + re-render when a caller hands it the same metadata again (see setMeta's loop guard). */
const metaShallowEqual = (a: Record<string, unknown> | null | undefined, b: Record<string, unknown>): boolean => {
  if (a === b) return true
  if (!a) return false
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  for (const k of ka) if (a[k] !== b[k]) return false
  return true
}
const ROOM_SYNC_V2_DEFAULT_ON = false
export const roomSyncV2On = (): boolean => {
  try {
    // An explicit per-device choice ALWAYS wins (so a dev can force it on to test, or a user off).
    const ls = globalThis.localStorage?.getItem('kbz.roomSyncV2')
    if (ls === '1') return true
    if (ls === '0') return false
    // The kill: default OFF for everyone regardless of the brand/app window flag while the feature is parked.
    if (!ROOM_SYNC_V2_DEFAULT_ON) return false
    // (Normal brand-default behaviour, restored when ROOM_SYNC_V2_DEFAULT_ON flips back to true.)
    const w = (globalThis as Record<string, unknown>)['__kbzRoomSyncV2']
    if (w === true) return true
    if (w === false) return false
    return false
  } catch {
    return false
  }
}
// Resume a STREAMED (disk-tier) transfer that stalls or whose receiver reloads: the sender retains the source
// until acked and re-streams from `have`; cross-reload restores from the persisted OPFS partial. A resumed
// leg skips the SHA-256 (the sender can't hash from a mid-offset). Default ON; 'kbz.xferResume'='0' opts out.
const xferResumeOn = (): boolean => xferFlagOn('kbz.xferResume', '__kbzXferResume')
// Bounded interactive MAP widget (docs/map-widget.md): render an agent-posted map as a pressable widget,
// shared taps replayed to late joiners. The transport (`widget`/`wevt` kinds) is always additive; THIS flag
// gates the map RENDERER (and the agent emit on the kibitz side). Default ON with a per-device opt-out so a
// device that misbehaves (or a build under a 2-device test) can kill it via 'kbz.mapWidget'='0'.
export const mapWidgetOn = (): boolean => xferFlagOn('kbz.mapWidget', '__kbzMapWidget')
// localStorage as the KV for cross-reload partial-transfer records, or null where it's unavailable (SSR /
// privacy mode) — callers no-op then. The bytes live in OPFS; only tiny JSON metadata goes here.
const persistKV = (): KV | null => {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}
// Feature tags we ADVERTISE — conditional on flags + real capability, so peers only negotiate what BOTH
// sides actually support:
//  - `xfer.v2` (binary frames) only when its flag is on.
//  - `xfer.dl` (receive a >1GB pull download) only when the large-xfer flag is on AND this build can save to
//    disk (File System Access) — i.e. we could honour an offer by streaming to a chosen file.
const advertisedFeatures = (): readonly string[] => {
  const drop = new Set<string>()
  if (!xferV2On()) drop.add('xfer.v2')
  if (!(largeXferOn() && detectSinkCaps().fsa)) drop.add('xfer.dl')
  if (!(largeXferOn() && xferResumeOn())) drop.add('xfer.resume')
  return drop.size ? ENGINE_FEATURES.filter((f) => !drop.has(f)) : ENGINE_FEATURES
}
/** Which perceive cap gates a transfer of this kind (text=chat, image=media, file=files). */
const capForKind = (k: XferKind): Perceive => (k === 'text' ? 'read-chat' : k === 'image' ? 'read-media' : 'read-files')
/** A unique transfer id (crypto when available; a cheap fallback otherwise). */
const newXid = (): string => {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  return c?.randomUUID ? c.randomUUID() : `x${Date.now().toString(36)}${Math.floor(Math.random() * 1e9).toString(36)}`
}

/** An image another peer shared, attributed by the roster (unspoofable). Delivered to `onImage`
 *  subscribers — the perception surface a vision-capable agent (granted `read-media`) reads. */
export interface ImageMessage extends ImagePayload {
  /** Sender's media peer id (matches the roster). */
  from: string
  /** Sender's display name (from the roster). */
  name: string
  /** Sent privately to just us (directed) rather than broadcast. */
  dm?: boolean
}

/** A non-image file another peer shared (e.g. a PDF), attributed by the roster (unspoofable). Delivered to
 *  `onFile` subscribers — the perception surface a file-reading agent (granted `read-files`) reads, e.g. to
 *  extract a shared PDF's text. The file twin of ImageMessage; carries the file's OWN name so a tool can
 *  label or type-sniff it. */
export interface FileMessage {
  /** Sender's media peer id (matches the roster). */
  from: string
  /** Sender's display name (from the roster). */
  name: string
  /** The shared file's own name (e.g. 'report.pdf'). */
  fileName?: string
  /** MIME type, e.g. 'application/pdf'. */
  mime: string
  /** The file content, base64-encoded. */
  data: string
  /** Sent privately to just us (directed) rather than broadcast. */
  dm?: boolean
}

// SchemaInfo + WidgetMessage/WidgetInteraction now live in ./useSchema and ./useWidgets and are re-exported above.

// Larger than the old 50 because the public chat is now the ORDERED UNION of every participant's public lines
// (reconciled on each roster change). A late joiner absorbs the whole prior union, and each author re-broadcasts
// up to this many of its own public lines — so the cap is the per-author re-broadcast budget AND the on-screen
// session history. Bounded to keep memory + the re-broadcast burst sane.
const CHAT_KEEP = 500

// A completed PUBLIC upload at/under this RAW-byte size keeps its bytes (base64) on the attachment so the durable
// chat ledger can persist + re-render it on rehydrate; over it (or a >50MB disk-streamed transfer), only metadata
// persists. Matches ledgerSnapshot's cap. Modest on purpose — large bytes belong in the Layer-3 blob store.
const LEDGER_ATTACH_MAX = 8 * 1024 * 1024

/** Append a line to the capped chat buffer (pure — oldest lines fall off). */
export function appendChat(list: readonly ChatItem[], item: ChatItem, keep = CHAT_KEEP): ChatItem[] {
  const next = [...list, item]
  return next.length > keep ? next.slice(next.length - keep) : next
}

/**
 * Merge one line into the chat as the ORDERED UNION — the operation the late-joiner public-chat reconciliation
 * relies on (pure, so it's unit-testable):
 *   • DEDUP — if a line with the same `mid` is already present, return the list UNCHANGED (idempotent: a
 *     re-broadcast of an already-known message never duplicates it).
 *   • ORDER — otherwise INSERT keyed by `ts` ascending, tie-broken by `mid` string compare, so the union is
 *     deterministic on every peer regardless of arrival order.
 *   • CAP — then trim to the most-recent `keep` lines (oldest fall off), like appendChat.
 * A line without a `mid` can't be deduped and is treated as always-new (the caller assigns a fallback mid before
 * merging, so this is only a safety net); a line without a `ts` sorts as 0 (oldest).
 */
export function mergeChat(list: readonly ChatItem[], item: ChatItem, keep = CHAT_KEEP): ChatItem[] {
  if (item.mid && list.some((it) => it.mid === item.mid)) return [...list]
  return insertByTs(list, item, keep)
}

/** Insert `item` into the chat keyed by `ts` ascending (tie-broken by `mid` string compare), then cap to `keep`
 *  (pure). The ordered-insert core shared by mergeChat (text/media) and recordWidget (widgets) — so EVERY public
 *  item lands at its ts position, and a re-synced old-ts item restores to its original spot instead of the arrival
 *  end. A live item (ts≈now) sorts to the end → unchanged live behaviour. No dedup here (the caller dedups). */
export function insertByTs(list: readonly ChatItem[], item: ChatItem, keep = CHAT_KEEP): ChatItem[] {
  const ts = item.ts ?? 0
  const mid = item.mid ?? ''
  // Find the first existing line that should sort AFTER the new one; insert there (stable for equal keys).
  let i = list.length
  for (let j = 0; j < list.length; j++) {
    const jt = list[j].ts ?? 0
    if (jt > ts || (jt === ts && (list[j].mid ?? '') > mid)) {
      i = j
      break
    }
  }
  const next = [...list.slice(0, i), item, ...list.slice(i)]
  return next.length > keep ? next.slice(next.length - keep) : next
}

/** Resolve the stable id + order key for a RECEIVED public line. A modern sender supplies both (`mid`/`ts`);
 *  an old peer supplies neither, so we synthesize a per-session fallback: a stable mid scoped to the sender
 *  (`${from}#r${seq}`, the caller passes a monotonic `recvSeq`) and the receive time as the order key. Pure. */
export function resolveChatId(
  from: string,
  mid: string | undefined,
  ts: number | undefined,
  recvSeq: number,
  now: number,
  allowForeignMid = false,
): { mid: string; ts: number } {
  const supplied = typeof mid === 'string' && mid ? mid.slice(0, 80) : ''
  // A LIVE line's mid MUST be scoped to the SENDER (`${from}#…`, the send-side format at stampOwnChat). A wire
  // mid that doesn't start with `${from}#` is discarded + replaced with a sender-scoped fallback — otherwise a
  // peer could send `{mid:'<victimId>#7'}` to pre-claim a mid the victim will use, so the victim's real line is
  // silently dropped as a dedup collision (mergeChat keys on mid). A REPLAYED line (allowForeignMid) legitimately
  // carries the ORIGINAL author's mid, so it's allowed through (its attribution is display-only anyway).
  const m = supplied && (allowForeignMid || supplied.startsWith(`${from}#`)) ? supplied : `${from}#r${recvSeq}`
  const t = typeof ts === 'number' && Number.isFinite(ts) ? ts : now
  return { mid: m, ts: t }
}

/** Resolve the DISPLAY author of a received public line. By default it's the SENDER (the data-connection peer id
 *  + its roster name) — the secure attribution that can't be spoofed, since delivery already came from that peer.
 *  But a REPLAYED line carries an explicit original `author`/`authorName` (a peer re-broadcasting the union it
 *  holds on behalf of whoever really said it — a persistent room carries a line past its author leaving); when
 *  present + non-empty we surface THAT instead, so a backfilled line shows its true author. `rosterNameOf` lets the
 *  caller prefer the LIVE roster name when the original author is STILL present (so a returning author's own line
 *  shows their current roster name, not a stale/echo label like "You" that rode the re-broadcast); it falls back to
 *  the carried name when the author is absent (the persistence case). Pure (rosterNameOf is injected). SECURITY:
 *  this override is DISPLAY-ONLY and UNVERIFIED — it feeds only the plain-text name label (ChatMessage renders
 *  `m.name` as text, with no identity lookup). It can NEVER produce a verified ✓: verified status is computed in
 *  VerifyPanel from the LIVE per-peer cert-binding map keyed by the live roster id, which a chat message's fields
 *  never touch. The author id is bounded; the name is trimmed + length-capped like any other received string. */
export function resolveReplayAuthor(
  sender: string,
  senderName: string,
  author: string | undefined,
  authorName: string | undefined,
  rosterNameOf?: (id: string) => string | undefined,
): { from: string; name: string } {
  const a = typeof author === 'string' && author.trim() ? author.trim().slice(0, 80) : ''
  if (!a) return { from: sender, name: senderName }
  // Prefer the live roster name when the original author is present (fixes a stale carried label); else the
  // carried name (author is absent — persistence); else the id.
  const live = rosterNameOf?.(a)
  const carried = typeof authorName === 'string' && authorName.trim() ? authorName.trim().slice(0, 80) : ''
  return { from: a, name: live || carried || a }
}

/** Record a posted widget in the chat log (pure): REFRESH the existing line for this widget id in place (an
 *  owner's / holder's re-broadcast updates the data, never duplicates the line — keyed by widget id) or INSERT a
 *  new one ORDERED BY `ts` (so a re-synced widget lands at its original position, consistent with text/media —
 *  not appended at the arrival end). `w.ts` is the poster's send time (stamped like text/media); a widget with no
 *  ts sorts as oldest. Keeps a widget's chat line single. */
export function recordWidget(list: readonly ChatItem[], w: { from: string; name: string; id: string; kind: string; data: unknown; ts?: number }, nid: number, keep = CHAT_KEEP): ChatItem[] {
  if (list.some((it) => it.widget?.id === w.id)) return list.map((it) => (it.widget?.id === w.id ? { ...it, widget: { id: w.id, kind: w.kind, data: w.data } } : it))
  return insertByTs(list, { from: w.from, name: w.name, text: '', widget: { id: w.id, kind: w.kind, data: w.data }, id: nid, self: false, ts: w.ts }, keep)
}

/** The `blob:` object URLs on `prev`'s attachments that are GONE from `next` (an item fell off the capped
 *  buffer, or its url was replaced). A blob URL pins its Blob in memory until URL.revokeObjectURL — dropping
 *  the chat item doesn't free it — so the caller revokes these, capping session memory at "what's on screen"
 *  instead of "every image/file ever transferred". Pure (no DOM) → unit-testable; the effect does the revoke. */
export function evictedBlobUrls(prev: readonly ChatItem[], next: readonly ChatItem[]): string[] {
  const live = new Set<string>()
  for (const it of next) {
    const u = it.attachment?.url
    if (u && u.startsWith('blob:')) live.add(u)
  }
  const gone: string[] = []
  for (const it of prev) {
    const u = it.attachment?.url
    if (u && u.startsWith('blob:') && !live.has(u)) gone.push(u)
  }
  return gone
}

/** New, incoming (not our own) chat lines present in `next` but not in `prev`, matched by id.
 *  Pure — lets a headless controller fire a 'chat' event for only freshly-received messages
 *  (robust to the capped buffer dropping old lines). */
export function newChatLines(prev: readonly ChatItem[], next: readonly ChatItem[]): ChatItem[] {
  const seen = new Set(prev.map((c) => c.id))
  return next.filter((c) => !c.self && !seen.has(c.id))
}

/** One person in the call, ready to render. */
export interface CallParticipant {
  id: string
  name: string
  /** Camera on — THE flag that decides video-vs-avatar (the video lane always exists). */
  cam: boolean
  /** Emoji avatar shown (voice-reactive) when the camera is off; '' = initials. */
  avatar: string
  stream: MediaStream | null
  /** The participant's SCREEN-SHARE video (the dedicated 2nd video lane), separate from `stream` (their
   *  camera). null when they're not sharing. The stage renders this; the tile renders `stream`. */
  shareStream: MediaStream | null
  /** The participant's staged-video SOUND (the dedicated 2nd audio lane, opt-in) — played via a hidden <audio>
   *  alongside their share video. null when absent / the lane wasn't negotiated. */
  shareAudioStream: MediaStream | null
  isSelf: boolean
  /** Self only: mirror the video (true for the front camera; rear shows as-is —
   *  never for a screen/tab share, which would flip the text). */
  mirror?: boolean
  /** Self only: this video lane is a screen/tab SHARE, not the camera. */
  sharing?: boolean
  /** Opaque host-app metadata from the roster (seat, userId…); {} if none. */
  meta: Record<string, unknown>
  /** The engine SemVer this peer is running, advertised on the roster (undefined for an older
   *  build that predates feature advertising). SELF-ASSERTED (a peer sets its own roster meta) —
   *  advisory for observability + down-level negotiation, never a security/authorization signal. */
  engine?: string
  /** The capability tags this peer's build claims (e.g. 'caps.v1','schema.v1'). Self-asserted, like
   *  `engine` — use to down-level a feature, not to gate trust. See COMPATIBILITY.md. */
  features?: readonly string[]
}

/** One local capability-audit event (host-visible; nothing stored or sent). `blocked` = a peer's
 *  act was dropped because its grant forbade it; `granted` = its grant was changed. */
export interface AuditEntry {
  ts: number
  id: string
  kind: 'blocked' | 'granted'
  detail: string
}

export interface CallController {
  ready: boolean
  inCall: boolean
  participants: readonly CallParticipant[]
  rosterCount: number
  micOn: boolean
  camOn: boolean
  /** iOS released the mic/camera while the app was backgrounded and bringing them back needs a fresh user
   *  gesture — true until a tap resumes them. Drive a one-tap "resume mic/camera" affordance off this; it's
   *  always false off iOS (capture survives backgrounding there). */
  needsMediaGesture: boolean
  avatar: string
  /** A FATAL/persistent problem the user must act on (build retired, couldn't connect) — shown as the
   *  red banner. Transient mic/camera/share hiccups go to `notice`, not here. */
  error: string | null
  /** A transient, non-alarming heads-up (e.g. "mic access was blocked") — shown as a brief, neutral
   *  toast that auto-dismisses. The mic/camera button on/off state already conveys the result, so these
   *  never linger as a red banner. Null when nothing's showing. */
  notice: string | null
  /** Set when this build has been retired by the deployment's min-version floor (the kill-switch):
   *  the engine refuses to connect. Carries the operator's `message`. Null = build is current. */
  retired: RetirementCheck | null
  join: () => Promise<boolean>
  leave: () => void
  /** Turn the mic on/off. An explicit deviceId (e.g. the pre-join's chosen mic, desktop) selects that input. */
  toggleMic: (deviceId?: string) => void
  /** Free a captured-but-muted mic on iOS (stop the hardware → no recording indicator / app-switch
   *  click). No-op unless iOS + muted + a real mic is captured. Call from a user gesture. */
  releaseMutedMic: () => void
  /** iOS: capture the mic while staying muted, so a live call's voice routes to a Bluetooth/car device
   *  right away (it only routes while the mic is engaged). Pair with setKeepMicCaptured(true). */
  engageMic: () => void
  /** Hold the mic captured even while muted (don't let releaseMutedMic free it) — for Car mode, so the
   *  call audio stays on the car. */
  setKeepMicCaptured: (on: boolean) => void
  /** Turn the camera on/off. When turning ON, defaults to the front cam unless an explicit facing is
   *  given; an explicit deviceId (the pre-join's chosen camera, desktop) wins over facing. */
  toggleCam: (facing?: CamFacing, deviceId?: string) => Promise<void>
  /** Switch front/rear camera (mobile); true when more than one camera exists. */
  flipCam: () => Promise<void>
  /** The mic / camera INPUT device currently in use ('' = system default / none yet) — drives the in-call
   *  device menus' active check. */
  micDeviceId: string
  camDeviceId: string
  /** Switch the mic / camera INPUT device mid-call (desktop). Swaps the live track via replaceTrack — no rejoin;
   *  remembers the pick across a mute/unmute or camera off/on. A no-op switch (device gone) keeps the current input. */
  switchMic: (deviceId: string) => void
  switchCam: (deviceId: string) => void
  /** Bring the mic/camera back after iOS released them on a background (call from a user gesture / a tap on
   *  the "resume" affordance — see needsMediaGesture). Re-acquires only the lanes the user still wants. */
  resumeMedia: () => void
  canFlip: boolean
  /** Audio OUTPUT device id ('' = system default) — which speaker plays remote audio. */
  speakerId: string
  /** Choose the audio output device (HTMLMediaElement.setSinkId; desktop Chromium, no-op elsewhere). */
  setSpeaker: (deviceId: string) => void
  /** You are publishing a screen/tab share (rather than the camera). */
  sharing: boolean
  /** Share your screen/tab via the browser picker (getDisplayMedia). Returns false
   *  if blocked/cancelled. Replaces the camera on the video lane while active. */
  shareScreen: () => Promise<boolean>
  /** Publish an externally-captured video track (e.g. an extension's chrome.tabCapture
   *  stream) on the video lane — the same swap path as the camera, no re-dial. */
  shareTrack: (track: MediaStreamTrack) => Promise<boolean>
  /** Stop sharing and return the video lane to off. */
  stopShare: () => void
  /** Publish a custom outgoing audio track (song / TTS); null restores the silent placeholder. */
  publishAudioTrack: (track: MediaStreamTrack | null) => void
  /** Publish a staged video's SOUND on the dedicated 2nd audio lane (mic untouched); null → silent placeholder.
   *  No-op unless the opt-in share-audio lane was negotiated. */
  publishShareAudio: (track: MediaStreamTrack | null) => void
  /** Publish a custom outgoing VIDEO track (e.g. an agent's generated image rendered to a canvas) onto the
   *  CAMERA lane → it shows in OUR tile (NOT a stage screen-share; a human can pin the tile to the stage).
   *  null restores the placeholder (the tile falls back to the avatar). The video twin of publishAudioTrack. */
  publishVideoTrack: (track: MediaStreamTrack | null) => void
  setAvatar: (avatar: string) => void
  /** Attach opaque metadata to yourself (seat, userId…) — rides the roster so every
   *  peer can map you to its own domain. Kibitz never reads it. Keep it small. */
  setMeta: (meta: Record<string, unknown>) => void
  /** Ephemeral room chat (call members; capped buffer, nothing stored anywhere).
   *  Carried peer-to-peer over the data mesh — no authority relays it. */
  chat: readonly ChatItem[]
  /** Send a chat line. With `to` (a participant id) it's a PRIVATE message to just
   *  that person (point-to-point); without, it's broadcast to the room. */
  sendChat: (text: string, to?: string) => void
  /** Seed the PRIOR PUBLIC transcript (cross-call persistence): a headless controller (the agent that persisted
   *  the room's history) injects lines authored by VARIOUS participants — each with its ORIGINAL author (`from`
   *  media-id + `name`) — into our local chat AND into a VOUCHED re-broadcast set, so on every roster change we
   *  backfill late joiners with the prior conversation, each line attributed to who really said it. Deduped by
   *  `mid` (a re-injection never duplicates; if the original author is still present and re-broadcasts the same
   *  mid, it merges, not doubles). Bounded (~500). PUBLIC ONLY — a DM is never seeded/replayed. The carried
   *  attribution is DISPLAY-ONLY + UNVERIFIED: a seeded line never gets a verified ✓ (verified status is bound to
   *  a live cert-verified connection, not to anything this carries). No-op without send permission. */
  seedChatHistory: (lines: readonly { text?: string; image?: ImagePayload; mid: string; ts: number; from: string; name: string }[]) => void
  /** The held public chat as a durable, serializable snapshot (docs/chat-ledger.md) — the persisting agent seals +
   *  stores this on change/leave. */
  exportLedger: () => LedgerItem[]
  /** A cheap monotonic version of the chat buffer — poll this and only call exportLedger() when it changed. */
  ledgerVersion: () => number
  /** Merge a restored ledger snapshot back into the buffer + reconcile it to present peers (the rejoin path). */
  importLedger: (snapshot: unknown) => void
  /** Broadcast an opaque app message to every other call member (co-browse / shared
   *  state), peer-to-peer. You never receive your own back. */
  sendApp: (data: unknown) => void
  /** Send an opaque app message to ONE participant by id, peer-to-peer (directed). */
  sendAppTo: (to: string, data: unknown) => void
  /** Subscribe to app messages from other peers. */
  onApp: (cb: (m: AppMessage) => void) => void
  /** Share an image (camera photo / picked image), peer-to-peer. Pass an already-compressed payload
   *  (see encodeImageToBudget). With `to` it goes privately to that one participant; without, it's
   *  broadcast — and withheld from any peer not granted `read-media` (so an agent gets it only when
   *  vision is turned on). It renders as a chat thumbnail and reaches `onImage` subscribers. */
  sendImage: (img: ImagePayload, to?: string) => void
  /** Subscribe to images shared by other peers (attributed by roster) — a vision-capable agent's
   *  perception input. Only fires for images you're allowed to perceive. */
  onImage: (cb: (m: ImageMessage) => void) => void
  /** Subscribe to non-image files shared by other peers (attributed by roster) — a file-reading agent's
   *  perception input (e.g. a PDF for read_pdf). Fires when a `kind:'file'` transfer completes. */
  onFile: (cb: (m: FileMessage) => void) => void
  /** Send any content (text / image / file) as a chunked, backpressured peer-to-peer transfer — the
   *  unified path that lifts the single-message size limit. Withheld from peers lacking the kind's
   *  perceive cap (text=read-chat, image=read-media, file=read-files); a peer on an older build gets
   *  a legacy fallback (text→chat, small image→img; a file can't reach it). With `to` it's private. */
  sendContent: (kind: XferKind, bytes: Uint8Array, opts?: { mime?: string; name?: string }, to?: string) => void
  /** Convenience over sendContent: read a File/Blob and send it (image kind if its mime is an image). */
  sendFile: (file: File | Blob, to?: string) => void
  /** Cancel an in-flight OUTGOING transfer by its id (the paced send loop stops + tells the peer). */
  cancelTransfer: (xid: string) => void
  /** Room-state ledger transport (docs/room-state-ledger.md): broadcast an opaque LedgerMsg to all peers, and
   *  subscribe to inbound ones. The consumer binds a RoomLedger/LedgerSync onto this; ledger frames never
   *  surface via `onMessage` (apps only see `k:'app'`). */
  broadcastLedger: (m: unknown) => void
  onLedger: (cb: (from: string, m: unknown) => void) => () => void
  /** Fetch content-addressed bytes by hash (unified room sync) — local store, else a holding peer over
   *  ~kbz.blob. Resolves null if unavailable. Inert (falls back to the local store) unless ROOM_SYNC_V2 is on. */
  fetchBlob: (hash: string) => Promise<Uint8Array | null>
  /** Broadcast a tiny ephemeral CONTROL signal to all peers (e.g. presenter → all: stage allow/playing state). */
  sendCtl: (m: unknown) => void
  /** Send a control signal to ONE peer (e.g. a viewer → the presenter: play/pause the staged clip). */
  sendCtlTo: (to: string, m: unknown) => void
  /** Subscribe to inbound control signals (attributed by `from`). Multiple listeners; opaque to apps. */
  onCtl: (cb: (from: string, m: unknown) => void) => () => void
  /** Accept an incoming >1GB pull-download offer (state `offered`). MUST be called from a user gesture —
   *  it opens the OS save dialog; once a location is chosen the file streams straight to disk. */
  acceptTransfer: (xid: string) => Promise<void>
  /** Decline an incoming pull-download offer (tells the sender; the placeholder is dropped). */
  declineTransfer: (xid: string) => void
  /** Send a "pay me" link (provider's rail; Kibitz never touches funds). With `to`
   *  it goes privately to that one participant; without, to the whole room. */
  sendPay: (label: string, url: string, to?: string) => void
  /** Subscribe to incoming pay requests (attributed by roster). */
  onPay: (cb: (p: PayRequest) => void) => void
  /** Broadcast a shared pointer / annotation event (you render your own locally). */
  sendInk: (e: InkEvent) => void
  /** Subscribe to others' pointer / annotation events. `color` is the mover's OWN stamped colour
   *  (same for every receiver); fall back to inkColor(from) if an older sender didn't stamp it. */
  onInk: (cb: (from: string, name: string, e: InkEvent, color?: string) => void) => void
  /** Publish a schema describing your `app` messages / shared view so other peers — especially
   *  agents — can self-discover how to read them (COMPATIBILITY.md / agent protocol). Broadcast
   *  over the data mesh and re-sent to anyone who joins later, so discovery is order-independent.
   *  Re-publishing the same `name` replaces the prior one. Keep it small (it rides the data mesh). */
  registerSchema: (name: string, version: string, schema: unknown) => void
  /** Every schema currently known — yours and every peer's, each attributed by `from`. */
  getSchemas: () => readonly SchemaInfo[]
  /** Subscribe to schemas as peers publish them (fires once per publish, attributed by roster).
   *  Returns an unsubscribe function. Unlike `onApp`/`onInk`, multiple listeners can coexist. */
  onSchema: (cb: (s: SchemaInfo) => void) => () => void
  /** Post a BOUNDED interactive widget into the room (e.g. a map). `kind` selects a first-party renderer
   *  shipping in the bundle; `data` is its validated payload. Returns the instance id (pass it back to
   *  `sendWidgetEvent`). The local end OWNS the instance: its accumulated interactions are replayed to anyone
   *  who joins later, so shared state survives late joins. Re-using an `id` updates that instance in place. */
  sendWidget: (kind: string, data: unknown, id?: string) => string
  /** Retract a widget instance WE posted (e.g. an image that failed to render) — peers drop it from chat + stage. */
  removeWidget: (id: string) => void
  /** Subscribe to widgets posted by peers (and the owner's late-joiner replays, deduped by `id`). Multiple
   *  listeners may coexist; returns an unsubscribe fn. */
  onWidget: (cb: (m: WidgetMessage) => void) => () => void
  /** Broadcast an INTERACTION with a widget instance (e.g. dropping a pin) — shared with every peer and
   *  retained by the instance owner for late-joiner replay. `e` is the renderer-defined event shape. */
  sendWidgetEvent: (id: string, e: unknown) => void
  /** Subscribe to widget interactions from peers (attributed by roster). Returns an unsubscribe fn. */
  onWidgetEvent: (cb: (m: WidgetInteraction) => void) => () => void
  /** Remove a posted widget's chat record from THIS client only (local Dismiss — anti-spam). No broadcast. */
  hideWidget: (id: string) => void
  /**
   * The per-peer safety code (SAS) for a participant — the emoji both of you compare
   * aloud to rule out a man-in-the-middle, plus the remote DTLS fingerprint it came
   * from. Null for yourself, the preview/LAN-without-cert case, or a peer that hasn't
   * finished connecting. Pairwise and honest (derived from real certs, never faked).
   */
  getSafetyCode: (participantId: string) => Promise<SafetyInfo | null>
  /** Connection diagnostic for a participant — direct/relay + RTT + packet loss, or
   *  null if not yet connected. Read from getStats(). */
  getConnectionInfo: (participantId: string) => Promise<ConnInfo | null>
  /** Opt-in identity verification (L3) is configured (a provider + client_id). When
   *  false everything below is inert and the call stays fully account-free. */
  identityEnabled: boolean
  /** Your own verified identity once you've signed in (null until then). */
  selfIdentity: VerifiedIdentity | null
  /** Render the provider's sign-in button into `container` and, on success, broadcast
   *  your cert-bound ID token to peers. Resolves true if you signed in. */
  signInIdentity: (container: HTMLElement, method?: 'google' | 'email') => Promise<boolean>
  /** The cert-bound nonce an EXTERNAL sign-in surface must echo (passed to GIS/email) so the
   *  token it mints binds to THIS connection. Null until the cert is ready. For embedders that
   *  run sign-in on another origin (e.g. the extension's kibitz.chat popup) — pair with
   *  `provideIdentityToken`. */
  identityNonce: () => Promise<string | null>
  /** Adopt a cert-bound token obtained out-of-page (signed against `identityNonce()`), exactly
   *  as an in-page sign-in would: verify, hand to the gate, broadcast. Resolves true if adopted. */
  provideIdentityToken: (jwt: string) => Promise<boolean>
  /** Mount AS an AI agent: adopt the agent's own private signing key (a JWK the operator holds)
   *  so we present a cert-bound key assertion the authority checks against the room's allow-list
   *  — an agent enters by its OWN key, no human. Kept fresh for reconnects. True if adopted. */
  provideAgentKey: (privateKeyJwk: JsonWebKey) => Promise<boolean>
  /** Mount AS a paid agent: forward a short-lived network-access credit credential (fetched from a
   *  trusted issuer) so it rides our announce — a credit-gated authority verifies it and keeps
   *  admitting us. Call ~every minute with a freshly-renewed credential. No-op until the link exists. */
  provideAgentCredit: (credential: string) => void
  /** Claim the verified-HOST role: unseal the link's sealed host private key (`sealedBlob`) with
   *  `password`, then sign + send a cert-bound `claim`. Returns false on a wrong password / not-ready
   *  cert. Once claimed, `hostModerate` drives the room's moderation. See core/hostKey.ts. */
  claimHost: (password: string, sealedBlob: string) => Promise<boolean>
  /** Claim the SOFT host role (the name tier): adopt the committed host name + re-announce, so the
   *  authority recognizes us as the host by name. No crypto — any link-holder can do this. */
  claimHostByName: (hostName: string) => void
  /** OIDC host (authority only): mark a member the verified host once their cert-bound identity proved
   *  the room's committed host email. The Widget drives this from getIdentity/selfIdentity. */
  declareHost: (memberId: string) => void
  /** Drive host moderation. Password tier → a signed command (any seat). Soft (name) tier → the
   *  authority methods directly (effective only while we're the coordinator). */
  hostModerate: (op: HostOp, target?: string) => Promise<boolean>
  /** True when WE are the room's verified host (we proved the host key and the roster names us). The
   *  moderation UI is gated on this. */
  isVerifiedHost: boolean
  /**
   * A participant's cert-bound, verified identity, or null if they haven't proven one
   * (no token yet, not connected, or verification failed). Fully peer-to-peer: the
   * token's signature is checked against the provider's public keys and its nonce
   * against the cert THIS side actually handshook with — no server vouches.
   */
  getIdentity: (participantId: string) => Promise<VerifiedIdentity | null>
  /**
   * Verified-roster (docs/verification.md §7) — the live mutual, pre-share gate. Inert
   * (`active:false`, `canShare:true`) unless the room was created with a committed roster.
   * When active, content is HELD until I and every present peer have proven a listed
   * identity; `compromised` flags a present peer who proved an OFF-roster identity (an
   * intruder past admission). Drives the "verifying the room…" hold + the alarm in the UI.
   */
  rosterGate: RosterGateView
  /** A participant's effective capability Grant right now — an authority override (expiry-applied)
   *  else the default for its kind (human full, agent read-only). Drives the consent UI. */
  getCapabilityGrant: (id: string) => Grant
  /** Set (null clears) a participant's capability override; the engine enforces it per-peer.
   *  Authority action — distributing it to other peers is the consent layer's job. */
  setCapabilityGrant: (id: string, grant: Grant | null) => void
  /** Recent local capability-audit events for a participant (host-visible; nothing stored/sent) —
   *  acts blocked by its grant + grant changes. Newest first. */
  getAgentAudit: (id: string) => readonly AuditEntry[]
}

const AVATAR_KEY = 'kibitz.avatar'
const loadAvatar = () => {
  try {
    return localStorage.getItem(AVATAR_KEY) ?? ''
  } catch {
    return ''
  }
}

/**
 * Drives a call in a room: mic/camera capture, the media mesh, and the roster.
 * Media runs on a DEDICATED PeerJS peer per participant — never the room's data
 * peer (media churn on a shared peer destabilises it). Calls join MUTED and
 * camera-off; both are opt-in. Camera toggles are replaceTrack swaps on the live
 * connections (never re-dials — that crashes iOS WebKit natively, see core/mesh).
 */
export function useCall(
  room: CallRoom | null,
  name: string,
  makeMedia: () => CallMedia = peerJsMedia,
  /** Demo preview: no peers, so join without grabbing the mic (skip that prompt). */
  preview = false,
  /** OPT-IN identity verification (L3). Absent → fully account-free (default). */
  idConfig?: IdentityConfig,
  /** Room id — salts the cert→nonce binding so a token can't be replayed into another
   *  room. Both peers pass the same room, so it matches; omit and binding is cert-only. */
  roomSalt?: string,
  /** A cert the Widget pre-generated and pinned on the PRESENCE peer too (authority
   *  gate). When given, the media mesh reuses it, so ONE token verifies for both the
   *  authority (over presence) and peers (over media). Absent → useCall generates its
   *  own media cert (peer-to-peer badge only). */
  sharedCert?: RTCCertificate | null,
  /** Verified-roster (docs/verification.md §7): the committed member identities (emails,
   *  for the cert-bound `google` mode). When non-empty the mutual, pre-share gate turns ON
   *  — content is held until I and every present peer have proven a listed identity, and a
   *  present peer who proves an off-roster identity raises `compromised`. Absent/empty →
   *  the gate is inert and nothing about a normal room changes. */
  rosterMembers?: readonly string[] | null,
  /** Verified-roster allowed DOMAINS (the OIDC slots): a verified address at one of these is a
   *  member too. Combined with `rosterMembers` as the admission set. */
  rosterDomains?: readonly string[] | null,
  /** Accepted verification providers — peers' tokens are routed by issuer and verified against
   *  this list (Google, email-code, …). When set, peer-verify uses `verifyPeerMulti`; absent →
   *  the single-provider Google path from `idConfig` (back-compat for existing callers). */
  acceptProviders?: readonly AcceptedProvider[],
  /** Inject a sign-in provider (tests); otherwise built from idConfig.provider (google / microsoft /
   *  generic oidc — see providerFor). */
  makeProvider: (cfg: IdentityConfig) => IdentityProvider = providerFor,
  /** Privacy (Layer 3): force media/data through TURN so peers never see your IP (only the
   *  relay's). Fail-closed — no reachable TURN ⇒ the call can't connect rather than leak. */
  relayOnly = false,
  /** Offline (LAN) call: the media mesh runs `iceServers:[]` (no TURN), so on iOS the connectable
   *  (non-mDNS) host candidates only appear once a REAL getUserMedia capture happens. So on the LAN
   *  path we grab the mic at join (muted) instead of the synthetic placeholder — matching kibitz,
   *  which is why its offline voice connects and ours didn't. Online keeps the placeholder (TURN gives
   *  relay candidates that don't need the unlock, and it avoids the iOS A2DP→HFP Bluetooth glitch). */
  offline = false,
): CallController {
  const [inCall, setInCall] = useState(false)
  const [micOn, setMicOn] = useState(false) // join MUTED by default
  const [camOn, setCamOn] = useState(false)
  // The mic / camera INPUT device currently in use ('' until a real track is captured). Set from the live track's
  // own settings after each capture (so it reflects reality even when the system default was used), and eagerly by
  // switchMic/switchCam. Drives the in-call device menus' "which one is active" check. camChoice/micChoice remember an
  // explicit pick so it survives a mute/unmute or camera off/on (toggleMic/toggleCam fall back to it).
  const [micDeviceId, setMicDeviceIdState] = useState('')
  const micChoiceRef = useRef('')
  const [camDeviceId, setCamDeviceIdState] = useState('')
  const camChoiceRef = useRef('')
  // iOS released the mic/camera when the app was backgrounded and a silent re-grab on return needs a user
  // gesture → show a one-tap "resume" affordance. True only on iOS, only when a wanted lane couldn't recover.
  const [needsMediaGesture, setNeedsMediaGesture] = useState(false)
  const [avatar, setAvatarState] = useState<string>(loadAvatar)
  const [meta, setMetaState] = useState<Record<string, unknown>>({})
  const [error, setError] = useState<string | null>(null)
  // A transient heads-up (mic/camera/share hiccup) — shown as a brief neutral toast, NOT the red error
  // banner, since the mic/camera button already conveys on/off. Auto-dismisses; the latest one wins.
  const [notice, setNotice] = useState<string | null>(null)
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flashNotice = useCallback((msg: string) => {
    setNotice(msg)
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current)
    noticeTimerRef.current = setTimeout(() => setNotice(null), 4500)
  }, [])
  useEffect(() => () => { if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current) }, [])
  // Min-version kill-switch (core/minVersion): if the deployment's floor retires THIS build,
  // we refuse to connect (a pinned/cached build can otherwise live forever in a P2P mesh).
  const [retired, setRetired] = useState<RetirementCheck | null>(null)
  const retiredRef = useRef<RetirementCheck | null>(null)
  const [roster, setRoster] = useState<CallMember[]>([])
  // Self preview/meter stream: the (shared) mic track — so your own emoji reacts to
  // your voice and the mic-wave works — plus the live camera track when it's on.
  const [selfStream, setSelfStream] = useState<MediaStream | null>(null)
  const [remote, setRemote] = useState<ReadonlyMap<string, MediaStream>>(new Map())
  const [selfVoiceId, setSelfVoiceId] = useState<string | null>(null)
  const [camFacing, setCamFacing] = useState<CamFacing>('user')
  const [canFlip, setCanFlip] = useState(false)
  // Audio OUTPUT device (which speaker to play remote audio through). '' = system default. Applied to
  // every playback element via useStream (HTMLMediaElement.setSinkId — desktop Chromium; a no-op where
  // unsupported). Kept in a ref so elements attached after a change still pick it up.
  const [speakerId, setSpeakerIdState] = useState('')
  const speakerIdRef = useRef('')
  const setSpeaker = useCallback((id: string) => {
    speakerIdRef.current = id || ''
    setSpeakerIdState(id || '')
  }, [])
  const [sharing, setSharing] = useState(false)
  const sharingRef = useRef(false)
  // The local screen-share track while we're sharing (published on the SHARE lane, not the camera lane) — used
  // to build our own shareStream so we see our share on our own stage. null when not sharing.
  const shareSelfRef = useRef<MediaStreamTrack | null>(null)
  const shareAudioSelfRef = useRef<MediaStreamTrack | null>(null) // the screen-share's own audio (tab/system), on the share-audio lane
  // Cache: a stable MediaStream per participant wrapping their share track, rebuilt only when the track itself
  // changes (the share track is stable across replaceTrack swaps) — so the stage's <video> srcObject never thrashes.
  const shareStreamCacheRef = useRef(new Map<string, { track: MediaStreamTrack; stream: MediaStream }>())
  // Cache: a stable CAMERA stream per participant (their raw stream minus the share lane track[s]), keyed by the
  // kept track-id set so the tile's <video> srcObject only re-binds when the tracks actually change.
  const cameraStreamCacheRef = useRef(new Map<string, { key: string; stream: MediaStream }>())
  const facingRef = useRef<CamFacing>('user')
  const [chat, setChat] = useState<readonly ChatItem[]>([])
  // The latest committed chat buffer, mirrored in a ref so live dedup + ordering (formerly also the late-joiner reconciliation) can read
  // the WHOLE held public text union at re-broadcast time without re-subscribing — so a DEPARTED author's lines are
  // carried by whoever still holds them (the persistent-room fix), not just lines we authored.
  const chatRef = useRef<readonly ChatItem[]>([])
  const chatSeqRef = useRef(0)
  // Monotonic per-tab counter for the STABLE global chat id (`${voiceId}#${seq}`) we stamp on every PUBLIC line
  // we author — the dedup key the late-joiner reconciliation merges on. Separate from chatSeqRef (the local
  // render id): mid must be stable + author-scoped (so every peer agrees on it), chatSeqRef is local + per-line.
  const chatMidSeqRef = useRef(0)
  // Fallback-mid counter for a received line from an OLD peer that carried no `mid` — gives it a stable
  // session identity (`${from}#r${seq}`) so it still dedups against itself across reconciliation re-broadcasts.
  const chatRecvSeqRef = useRef(0)
  // (The reconciliation re-broadcast source is the whole chat BUFFER — see chatRef — so a departed
  //  author's lines are carried by whoever still holds them. Authored + seeded lines live in that buffer like any
  //  other; there's no separate own/seeded re-broadcast map.)
  // PUBLIC media mids we've accepted (a placeholder opened) — the SYNCHRONOUS dedup gate for the media
  // reconciliation: chatRef only refreshes after a re-render, so two replays of the same image arriving in one tick
  // could both pass a buffer scan; this set rejects the second immediately. A mid stays here for the session (a
  // completed media line is permanent in the buffer up to the cap; re-accepting it would just re-download bytes).
  const recvMediaMidsRef = useRef<Set<string>>(new Set())
  // Disk-temp cleanups for COMPLETED streamed (OPFS) transfers, keyed by the attachment's object URL — run
  // when the chat buffer evicts that line (right after its URL is revoked), so OPFS temps don't pile up in
  // origin storage across reloads. Empty on the in-RAM path.
  const xferCleanupRef = useRef<Map<string, () => void | Promise<void>>>(new Map())
  // Free a completed transfer's blob URL once its chat line leaves the capped buffer (or its url is
  // replaced) — a blob URL pins its Blob in memory until revoked, so without this every image/file ever
  // transferred leaks for the whole session (this is Attachment.url's documented contract). prevChatRef
  // lets the effect diff prev→next; a final sweep on unmount frees whatever the last buffer still holds.
  const prevChatRef = useRef<readonly ChatItem[]>([])
  useEffect(() => {
    chatRef.current = chat // keep the reconciliation's re-broadcast source current
    for (const url of evictedBlobUrls(prevChatRef.current, chat)) {
      URL.revokeObjectURL(url)
      const clean = xferCleanupRef.current.get(url)
      if (clean) {
        xferCleanupRef.current.delete(url)
        void clean() // remove the OPFS temp now that nothing references it
      }
    }
    prevChatRef.current = chat
  }, [chat])
  useEffect(
    () => () => {
      for (const it of prevChatRef.current) {
        const u = it.attachment?.url
        if (u && u.startsWith('blob:')) URL.revokeObjectURL(u)
      }
      for (const clean of xferCleanupRef.current.values()) void clean() // free any remaining OPFS temps
      xferCleanupRef.current.clear()
    },
    [],
  )
  // Image/file (chat-transfer) subscribers — registered by consumers, fired from the mesh. app/pay/ink now own
  // their own subscriber state inside their modules.
  const imgCbRef = useRef<((m: ImageMessage) => void) | null>(null)
  const fileCbRef = useRef<((m: FileMessage) => void) | null>(null)
  // In-flight INCOMING content transfers, keyed `${fromPeerId}/${transferId}`. Each holds the
  // reassembler + the chat line it drives (0 for a text transfer, which has no placeholder).
  const incomingRef = useRef<Map<string, { r: Reassembler | DiskReassembler; chatId: number; kind: XferKind; mime?: string; name?: string; fromName: string; dm: boolean; hasher?: Sha256; resumeTries?: number; mid?: string; ts?: number; author?: string; authorName?: string }>>(new Map())
  // PULL download (the >1GB tier): an OFFER we received but haven't accepted yet — the placeholder chat line +
  // the begin header, held until the user clicks "Accept & save" (acceptTransfer opens the disk picker then).
  // Keyed `${from}/${id}`. Sender side: an offer WE sent, held until the peer's xaccept, then we stream.
  const offerInRef = useRef<Map<string, { begin: XferBegin; from: string; fromName: string; chatId: number; dm: boolean }>>(new Map())
  const offerOutRef = useRef<Map<string, { peerId: string; file: File | Blob; kind: XferKind; mime: string; name?: string; dm: boolean; binary: boolean }>>(new Map())
  // RESUME (disk-tier): a streamed send WE'RE driving, RETAINED (source File + meta) so an `xresume {have}`
  // can re-stream from `have`. Keyed `${peerId}/${xid}`; dropped on the receiver's `xack`, on cancel, or when
  // the peer leaves. Only populated when the resume flag is on. Holds a File ref (disk-backed — no RAM copy).
  const activeSendRef = useRef<Map<string, { peerId: string; file: File | Blob; kind: XferKind; mime: string; name?: string; dm: boolean; binary: boolean }>>(new Map())
  // Outgoing transfer ids the user cancelled — the paced send loop checks this and stops.
  const sendCancelRef = useRef<Set<string>>(new Set())
  // SENDER-side live progress for a streamed send: per xid, each receiving peer's fraction (0..1). The
  // attachment's bar shows the MIN (slowest peer); when every tracked peer hits 1 the send flips to `done`.
  // Lets a large send show real progress (not an instant fake `done`) and gives the cancel button a home.
  const sendProgRef = useRef<Map<string, Map<string, number>>>(new Map())
  // Content-handler registry (the modularization seam): a feature MODULE registers a handler for its content
  // kind, and dispatchContent routes that kind to it — after the same roster/capability gate — instead of an
  // inline branch. Lets features (the first is useInk) live outside the engine. Ref-backed so dispatch stays
  // []-dep stable; the returned unregister removes only the exact fn, so a remount can't clobber a live one.
  const contentHandlersRef = useRef<Map<string, ContentHandler>>(new Map())
  const registerContentHandler = useCallback((kind: string, fn: ContentHandler) => {
    contentHandlersRef.current.set(kind, fn)
    return () => {
      if (contentHandlersRef.current.get(kind) === fn) contentHandlersRef.current.delete(kind)
    }
  }, [])
  // Roster-change seam (the second modularization primitive): a MODULE that must replay owned state to late
  // joiners (schema discovery, owned widgets) registers here; the onRoster effect fires every handler whenever the
  // roster updates. Lets order-independent re-broadcast live in the module, not as a bespoke hook in the engine.
  // Unified room sync (flag-gated, docs/unified-room-sync.md): a content-addressed store of upload bytes so a
  // peer can fetch them by hash. stampBlob stores the bytes + returns their hash to reference on the attachment;
  // a no-op returning undefined when ROOM_SYNC_V2 is off, so nothing changes on the live path.
  const blobStoreRef = useRef<BlobStore | null>(null)
  const stampBlob = useCallback((bytes: Uint8Array): string | undefined => {
    if (!roomSyncV2On()) return undefined
    if (!blobStoreRef.current) blobStoreRef.current = new BlobStore(memBlobKV())
    void blobStoreRef.current.put(bytes)
    return blobHash(bytes)
  }, [])

  const rosterChangeHandlersRef = useRef<Set<() => void>>(new Set())
  const onRosterChange = useCallback((fn: () => void) => {
    rosterChangeHandlersRef.current.add(fn)
    return () => rosterChangeHandlersRef.current.delete(fn)
  }, [])
  // Schema discovery (the room capability directory) + bounded interactive widgets now live in the useSchema and
  // useWidgets modules — each owns its own maps/listeners.

  // --- Opt-in identity (L3) — all inert unless idConfig is set ---------------------
  const [selfIdentity, setSelfIdentity] = useState<VerifiedIdentity | null>(null)
  const pinnedCertRef = useRef<RTCCertificate | null>(null) // ONE cert, pinned across the mesh
  const pinnedCertPromiseRef = useRef<Promise<RTCCertificate | null> | null>(null) // de-dupe concurrent gen
  const selfFpRef = useRef<string>('') // our pinned cert's fingerprint
  const selfJwtRef = useRef<string>('') // our signed, cert-bound ID token
  // AI-agent key (when we mount AS an agent): our own private signing key + the periodic
  // re-sign timer that keeps a fresh cert-bound assertion riding our announce (so a reconnect,
  // which the authority re-verifies, always has a non-stale assertion).
  const agentSignKeyRef = useRef<CryptoKey | null>(null)
  const agentRefreshRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const idTokensRef = useRef<Map<string, string>>(new Map()) // peerId → raw received jwt
  // Memoised verification per peer, invalidated when the jwt or the remote cert changes.
  const idCacheRef = useRef<Map<string, { jwt: string; fp: string; id: VerifiedIdentity | null }>>(new Map())
  const sentTokenToRef = useRef<Set<string>>(new Set()) // peers we've handed our token to
  const idConfigRef = useRef<IdentityConfig | undefined>(idConfig)
  idConfigRef.current = idConfig
  const acceptProvidersRef = useRef<readonly AcceptedProvider[] | undefined>(acceptProviders)
  acceptProvidersRef.current = acceptProviders
  const relayOnlyRef = useRef(relayOnly)
  relayOnlyRef.current = relayOnly
  const offlineRef = useRef(offline)
  offlineRef.current = offline
  const roomSaltRef = useRef<string | undefined>(roomSalt)
  roomSaltRef.current = roomSalt
  const sharedCertRef = useRef<RTCCertificate | null | undefined>(sharedCert)
  sharedCertRef.current = sharedCert
  // Verified-roster (docs §7). The live view is recomputed by a poll while in a call; a ref
  // mirrors it so the []-dep content senders/receiver can gate synchronously. A stable key
  // (the joined roster) drives the poll's effect dep without re-firing on array identity.
  const rosterKey = useMemo(
    () => `${(rosterMembers ?? []).join('\n')}|${(rosterDomains ?? []).join('\n')}`,
    [rosterMembers, rosterDomains],
  )
  const rosterMembersRef = useRef<readonly string[] | null | undefined>(rosterMembers)
  rosterMembersRef.current = rosterMembers
  const rosterDomainsRef = useRef<readonly string[] | null | undefined>(rosterDomains)
  rosterDomainsRef.current = rosterDomains
  const [rosterGate, setRosterGate] = useState<RosterGateView>(() =>
    evaluateRosterGate({ members: rosterMembers, domains: rosterDomains }),
  )
  const rosterGateRef = useRef(rosterGate)
  rosterGateRef.current = rosterGate
  // ── Participant capabilities (docs/agent-platform.md) ──────────────────────────────────────
  // A per-peer Grant of what it may perceive/emit. Authority overrides live in grantsRef
  // (set + distributed in the consent layer); absent an override a peer's grant is the default
  // for its KIND (humans full, agents read-only) — kind from the agent SDK's `meta.role`='agent'.
  // The engine ENFORCES it: receive-side drops a sender's data acts when it lacks `send-chat`;
  // send-side withholds from a recipient lacking `read-chat` / `receive-directed`. Inert for an
  // all-human room with no overrides (everyone is full), so non-agent rooms are unaffected.
  const grantsRef = useRef<Map<string, Grant>>(new Map())
  const nowSec = () => Math.floor(Date.now() / 1000)
  // The grant in force for a peer right now: an authority override (expiry-applied) else the kind
  // default (humans full, agents read-only). Kind from the agent SDK's `meta.role='agent'`. Self is
  // always full (we never gate our own perception/action locally). For an agent with no override we
  // also surface its self-disclosed `meta.backend`/`meta.egress` — a DISCLOSURE of where what-it-sees
  // goes (shown in the consent sheet), NOT a privilege it grants itself; a backend implies egress.
  const grantOf = useCallback((id: string): Grant => {
    if (id === voiceIdRef.current) return defaultGrant('human')
    const o = grantsRef.current.get(id)
    if (o) return effectiveGrant(o, nowSec())
    const meta = rosterRef.current.find((x) => x.id === id)?.meta
    if (meta?.role !== 'agent') return defaultGrant('human')
    const backend = typeof meta.backend === 'string' && meta.backend ? meta.backend.slice(0, 80) : undefined
    const egress = meta.egress === true || !!backend
    return { ...defaultGrant('agent'), ...(backend ? { backend } : {}), ...(egress ? { egress: true } : {}) }
  }, [])
  const grantOfRef = useRef(grantOf) // stable handle for the []-dep content callbacks
  grantOfRef.current = grantOf
  // Per-peer MEDIA perception gate (Phase 4): the mesh asks this, per peer + lane, whether the
  // peer may receive the real track — else it substitutes a flowing placeholder on just that
  // connection. AUDIO is gated by `hear-audio`. The dedicated SCREEN-SHARE lane is gated by `see-screen`.
  // The camera lane is NOT capability-gated (there's no see-camera perceive) so every peer gets the camera —
  // a presenter's face stays visible to all while only the share is withheld. Ref-stable: reads grantOfRef live.
  const mediaGate = useRef((peerId: string, kind: 'audio' | 'video' | 'share' | 'shareAudio'): boolean => {
    const g = grantOfRef.current(peerId)
    if (kind === 'audio') return canPerceive(g, 'hear-audio')
    if (kind === 'share' || kind === 'shareAudio') return canPerceive(g, 'see-screen') // the staged clip's video+audio gate together
    return true // camera lane — ungated
  })
  // Capability audit (LOCAL-ONLY, host-visible): a small ring of high-signal events — an agent's
  // act BLOCKED by its grant (it tried to do what it isn't allowed) and grant CHANGES. No content is
  // stored, just capability-level facts. Drives the consent feed; nothing leaves the browser.
  const auditRef = useRef<AuditEntry[]>([])
  const logAudit = (id: string, kind: AuditEntry['kind'], detail: string) => {
    auditRef.current.push({ ts: Date.now(), id, kind, detail })
    if (auditRef.current.length > 80) auditRef.current.splice(0, auditRef.current.length - 80)
  }
  const logAuditRef = useRef(logAudit)
  logAuditRef.current = logAudit
  const getCapabilityGrant = useCallback((id: string): Grant => grantOf(id), [grantOf])
  // Distribution (b): the AUTHORITY broadcasts the full grant map to EVERYONE, so every peer
  // enforces the same grants (multi-human correctness), not just the host. A control message —
  // it bypasses the content gates. A non-authority's call is a no-op (only the host distributes).
  const broadcastCaps = useCallback(() => {
    if (!roomRef.current?.isAuthority?.()) return
    const grants: Record<string, Grant> = {}
    for (const [id, g] of grantsRef.current) grants[id] = g
    meshRef.current?.broadcastData({ k: 'caps', grants } satisfies ContentMsg)
  }, [])
  const broadcastCapsRef = useRef(broadcastCaps)
  broadcastCapsRef.current = broadcastCaps
  const setCapabilityGrant = useCallback(
    (id: string, grant: Grant | null) => {
      if (grant) grantsRef.current.set(id, sanitizeGrant(grant))
      else grantsRef.current.delete(id)
      logAudit(id, 'granted', grant ? `${[...grant.perceive, ...grant.act].join(', ') || 'nothing'}` : 'cleared')
      broadcastCaps() // push the change to every peer (host-distributed enforcement)
      meshRef.current?.applyMediaGate?.() // re-gate media (screen share / audio) to the new grant
    },
    [broadcastCaps],
  )
  const getAgentAudit = useCallback(
    (id: string): readonly AuditEntry[] => auditRef.current.filter((e) => e.id === id).slice(-6).reverse(),
    [],
  )
  const providerRef = useRef<IdentityProvider | null>(null)
  const jwksRef = useRef<ReturnType<typeof createJwksResolver> | null>(null)
  if (idConfig && !jwksRef.current) jwksRef.current = createJwksResolver()
  if (idConfig && !providerRef.current) providerRef.current = makeProvider(idConfig)

  const meshRef = useRef<VoiceMesh | null>(null)
  const mediaRef = useRef<CallMedia | null>(null)
  const voiceIdRef = useRef<string>('')
  const localRef = useRef<MediaStream | null>(null)
  const selfStreamRef = useRef<MediaStream | null>(null)
  const placeholderRef = useRef<MediaStreamTrack | null>(null)
  // The SECOND video lane (screen-share), negotiated up-front like the camera lane (no mid-call m-line add →
  // no iOS re-dial crash). Dormant black placeholder until a share swaps the real screen in, so a presenter
  // can keep their camera on lane 1 (their tile) while the share rides lane 2 (the stage).
  const sharePlaceholderRef = useRef<MediaStreamTrack | null>(null)
  const shareAudioPlaceholderRef = useRef<MediaStreamTrack | null>(null) // dormant silent track on the 2nd audio lane (opt-in)
  const shareAudioStreamCacheRef = useRef(new Map<string, { track: MediaStreamTrack; stream: MediaStream }>())
  // The silent audio lane held until the real mic is granted on first unmute, and
  // a flag for whether we've swapped the real mic in yet (lazy-mic, no join prompt).
  const placeholderAudioRef = useRef<MediaStreamTrack | null>(null)
  const realMicRef = useRef(false)
  // reviveMedia is reached from a track's `ended` listener (outside React) → call it through a ref. A guard
  // so an overlapping foreground + ended event don't run two getUserMedia re-grabs at once.
  const reviveRef = useRef<((includeMuted?: boolean) => void) | null>(null)
  const revivingRef = useRef(false)
  // DEDICATED, call-lifetime gating placeholders (Phase 4 media gate): substituted on a
  // per-peer basis to WITHHOLD a screen share / audio from a peer lacking `see-screen` /
  // `hear-audio`. Kept distinct from the lazy-mic/camera placeholders above (those get
  // stopped/removed during toggles) so the gate always has a live track to swap in.
  const gateVideoPhRef = useRef<MediaStreamTrack | null>(null)
  const gateAudioPhRef = useRef<MediaStreamTrack | null>(null)
  // Quick post-join re-announces, in case the first raced the data channel.
  const reannounceRef = useRef<ReturnType<typeof setTimeout>[]>([])
  const rosterRef = useRef<CallMember[]>([])
  // rosterHold: last-known member metadata per peer id, so a peer dropped by a broker flap can be re-added to the
  // displayed roster (with its name/meta) while its P2P mesh link is still alive. Default-off (see rosterHold.ts).
  const lastMemberRef = useRef<Map<string, CallMember>>(new Map())
  const admittedRef = useRef<Set<string>>(new Set()) // peers admitted under the room human-cap (no eviction); gates the mesh
  const micRef = useRef(false)
  // Car mode keeps the mic CAPTURED (iOS): a live call's voice audio only routes to a Bluetooth/car
  // device while the mic is engaged, so we hold it (muted via enabled=false) instead of freeing it.
  const keepMicCapturedRef = useRef(false)
  const camRef = useRef(false)
  const avatarRef = useRef(avatar)
  const metaRef = useRef<Record<string, unknown>>(meta)
  const togglingCamRef = useRef(false)
  const nameRef = useRef(name)
  nameRef.current = name
  const roomRef = useRef<CallRoom | null>(room)
  roomRef.current = room
  const makeMediaRef = useRef(makeMedia)
  makeMediaRef.current = makeMedia
  const previewRef = useRef(preview)
  previewRef.current = preview

  const announceSelf = useCallback((on: boolean) => {
    // Ride engine version + build id + features on the roster under the reserved key (stripped on read).
    const meta = { ...metaRef.current, [META_ENGINE]: { v: APP_VERSION, b: BUILD_ID, p: PROTOCOL_VERSION, f: advertisedFeatures() } }
    roomRef.current?.link.setSelf(on, camRef.current, nameRef.current, avatarRef.current, voiceIdRef.current, meta)
  }, [])

  const onRemote = useCallback((id: string, stream: MediaStream | null) => {
    setRemote((prev) => {
      const next = new Map(prev)
      if (stream) next.set(id, stream)
      else next.delete(id)
      return next
    })
  }, [])

  // Build (and cache) the MediaStream the STAGE renders for a participant's screen-share — their share track
  // wrapped in its own stream, separate from their camera (`stream`). Stable across renders so the <video>
  // doesn't flicker; null releases the cache entry (not sharing).
  const shareStreamFor = useCallback((id: string, track: MediaStreamTrack | null): MediaStream | null => {
    const cache = shareStreamCacheRef.current
    if (!track) {
      cache.delete(id)
      return null
    }
    const cached = cache.get(id)
    if (cached && cached.track === track) return cached.stream
    const stream = new MediaStream([track])
    cache.set(id, { track, stream })
    return stream
  }, [])
  // Same, for a participant's staged-video SOUND (the 2nd audio lane). Wrapped in its own stream so the Widget
  // can play it via a hidden <audio> alongside their share video. Stable across renders; null when not present.
  const shareAudioStreamFor = useCallback((id: string, track: MediaStreamTrack | null): MediaStream | null => {
    const cache = shareAudioStreamCacheRef.current
    if (!track) {
      cache.delete(id)
      return null
    }
    const cached = cache.get(id)
    if (cached && cached.track === track) return cached.stream
    const stream = new MediaStream([track])
    cache.set(id, { track, stream })
    return stream
  }, [])
  // Build (and cache) the CAMERA stream the tile's <video> renders: the peer's raw PeerConnection stream MINUS the
  // screen-share lane track(s). The raw stream carries BOTH video lanes (camera + the dormant share placeholder),
  // and a <video> plays only its FIRST selected video track — Safari/iOS selects the FRAMELESS share placeholder,
  // so the element sits at readyState 0 (HAVE_NOTHING) and plays NEITHER the camera video NOR the audio (the exact
  // "black AND silent after the other side's camera came on" bug; Chrome happens to pick the camera, which is why
  // it worked there). Excluding the share lane(s) — which the mesh already identifies, and which ride their OWN
  // streams for the stage — leaves a single-video-lane stream the <video> can't get wrong. Cached by the kept
  // track-id set so the reference stays stable across renders (no srcObject thrash) until the tracks change.
  const cameraStreamFor = useCallback(
    (id: string, raw: MediaStream | null, shareVideo: MediaStreamTrack | null, shareAudio: MediaStreamTrack | null): MediaStream | null => {
      if (!raw) {
        cameraStreamCacheRef.current.delete(id)
        return null
      }
      const exclude = new Set([shareVideo, shareAudio].filter((t): t is MediaStreamTrack => !!t))
      const wanted = raw.getTracks().filter((t) => !exclude.has(t))
      const key = wanted.map((t) => t.id).join(',')
      const cached = cameraStreamCacheRef.current.get(id)
      if (cached && cached.key === key) return cached.stream
      const stream = new MediaStream(wanted)
      cameraStreamCacheRef.current.set(id, { key, stream })
      return stream
    },
    [],
  )

  // Raw-mesh send primitives the relay-lane MODULES (ctl, ledger) use. They deliberately bypass broadcastContent's
  // per-recipient perceive-withholding — ctl/ledger are transport/control, delivered to everyone regardless of
  // read-chat grants. The lanes themselves (useRelayLane) are instantiated lower down with the other modules.
  const meshBroadcast = useCallback((msg: unknown) => meshRef.current?.broadcastData(msg), [])
  const meshSendTo = useCallback((to: string, msg: unknown) => meshRef.current?.sendData(to, msg), [])

  // Content arrives PEER-TO-PEER over the data mesh (no authority relays it). The
  // sender is the data connection's peer id; we attribute the name from the roster
  // (never the wire — unspoofable) and demux by kind. Receive-side caps are the trust
  // boundary now that messages come straight from peers.
  // INVARIANT: this is a stable ([]-dep) callback wired once to mesh.onData, so every
  // piece of state it reads MUST go through a ref (rosterRef, the cb refs, …) — reading
  // a state value directly would capture a stale closure.
  const dispatchContent = useCallback((from: string, raw: unknown) => {
    // An xfer.v2 chunk arrives as a RAW binary message; normalize it to a synthetic xchunk so it runs the
    // exact same gate/capability/handler path below as a base64 xchunk (no separate, ungated fast-path).
    const c = asBinaryChunk(raw) ?? asContent(raw)
    if (!c) return
    // Authority-distributed capability grants (Phase b): the room authority broadcasts the
    // whole per-peer grant map so EVERY peer enforces the same policy (not just host-local).
    // Accept it only from the current host id — a non-authority peer can't rewrite the policy.
    // It's control, not content, so it's handled before the roster/act gates (like idtoken).
    if (c.k === 'caps') {
      const host = roomRef.current?.hostId?.()
      // Honor a distributed grant map ONLY from a CRYPTOGRAPHICALLY-proven host (committed key/OIDC email). A
      // soft-name host id is spoofable by any link-holder, so trusting its caps map would let a stranger rewrite
      // every peer's capabilities (mute a human, upgrade an agent). Name/nameless-open rooms enforce grants
      // host-locally instead (each browser applies only what it set) — for those, hostId() is '' so this is inert
      // anyway; the tier check makes the invariant explicit + fail-closed if a future room commits a bare name.
      const cryptoHost = roomRef.current?.hostTierIsCryptographic?.() === true
      if (cryptoHost && host && from === host && !roomRef.current?.isAuthority?.()) {
        const next = new Map<string, Grant>()
        for (const [id, g] of Object.entries(c.grants ?? {})) next.set(id, sanitizeGrant(g as Partial<Grant>))
        grantsRef.current = next
        meshRef.current?.applyMediaGate?.() // enforce the distributed media grants locally too
      }
      return
    }
    // Verified-roster receive-side filter (docs §7): when the gate is active, drop any
    // content from a peer we haven't verified onto the committed roster — an intruder's
    // chat/app/pay/ink never renders. The ID token is the ONE exception (it's how a peer
    // BECOMES verified), so let it through to verification below.
    if (c.k !== 'idtoken' && !peerCleared(rosterGateRef.current, from)) return
    // Capability enforcement (receive-side / ACT): a peer may only EMIT data content if its grant
    // includes `send-chat`. A read-only agent's chat/app/pay/ink is dropped by every honest peer,
    // so it can't post even with a modified client. The ID token is control, not content — exempt.
    if (c.k !== 'idtoken' && !canAct(grantOfRef.current(from), 'send-chat')) {
      if (rosterRef.current.find((x) => x.id === from)?.meta?.role === 'agent') logAuditRef.current(from, 'blocked', c.k)
      return
    }
    const name = rosterName(rosterRef.current, from)
    // Presence-aware name lookup for a REPLAYED line's original author: the live roster name if they're still
    // here, else undefined (→ the carried name wins — the persistence case). Reads the live roster ref.
    const presentRosterName = (id: string) => presentRosterNameOf(rosterRef.current, id)
    // Modular features first: if a module registered a handler for this kind, it owns it (runs with the same
    // gate already applied above). Falls through to the inline branches for kinds not yet extracted.
    const handler = contentHandlersRef.current.get(c.k)
    if (handler) {
      handler(from, c, name)
      return
    }
    if (c.k === 'chat') {
      const text = (c.text || '').slice(0, CHAT_MAX_LEN).trim()
      if (!text) return
      chatSeqRef.current += 1
      const dm = !!c.dm
      // A DM is private + never reconciled → keep it chronological (appendChat). A PUBLIC line is part of the
      // ordered union: stamp it with the sender's stable mid+ts (fallback for an old peer) and MERGE it, so a
      // re-broadcast on a later roster change dedups by mid instead of duplicating the line.
      if (dm) {
        setChat((prev) => appendChat(prev, { from, name, text, id: chatSeqRef.current, self: false, dm: true }))
      } else {
        chatRecvSeqRef.current += 1
        const { mid, ts } = resolveChatId(from, c.mid, c.ts, chatRecvSeqRef.current, Date.now(), !!c.from) // live line → sender-scoped mid
        // REPLAYED line: when the msg carries from/name, the sender is re-broadcasting SOMEONE ELSE'S line (the
        // union it holds — a persistent room carries a line past its author leaving), so attribute it to that
        // ORIGINAL author for DISPLAY. Prefer the live roster name when the author is still present (so a returning
        // author's own line shows their roster name, not a stale carried label), else the carried name (absent
        // author). UNVERIFIED by construction — a chat line's from/name never grants a verified badge (verified
        // status is bound to the live cert-verified connection, keyed by the live peer id, not to a message field).
        const { from: author, name: authorName } = resolveReplayAuthor(from, name, c.from, c.name, presentRosterName)
        setChat((prev) => mergeChat(prev, { from: author, name: authorName, text, id: chatSeqRef.current, self: false, mid, ts }))
      }
    } else if (c.k === 'img') {
      // A shared image (LEGACY inline). Validate + clamp it (mime allowlist, base64 sanity, bounded size) — the
      // receive-side trust boundary — then render it as a chat thumbnail AND surface it to onImage subscribers (a
      // vision-capable agent's perception input). A PUBLIC inline image carries a stable mid (+ ts) so the media
      // reconciliation dedups/orders it; a REPLAY also carries the original author (from/name2). Dedup by mid.
      const img = sanitizeImg(c)
      if (!img) return
      const pub = !c.dm
      // Resolve the SENDER-SCOPED mid FIRST (a live img's mid must start with `${from}#`, like chat), then dedup
      // on THAT — so a forged foreign mid can neither dedup-drop nor pre-claim another peer's media line.
      const rid = pub ? resolveChatId(from, c.mid, c.ts, (chatRecvSeqRef.current += 1), Date.now(), !!c.from) : undefined
      const emid = rid?.mid
      if (pub && emid && (recvMediaMidsRef.current.has(emid) || chatRef.current.some((it) => it.mid === emid && (!!it.image || !!it.attachment)))) return // already have it
      if (pub && emid) recvMediaMidsRef.current.add(emid)
      chatSeqRef.current += 1
      const author = pub ? resolveReplayAuthor(from, name, c.from, c.name2, presentRosterName) : { from, name }
      const mid = rid?.mid
      const ts = rid?.ts
      const imgItem = { from: author.from, name: author.name, text: '', image: img, id: chatSeqRef.current, self: false, dm: !!c.dm, mid, ts }
      // PUBLIC → MERGE by ts (so a re-synced image lands at its ORIGINAL position, not the arrival end); DM stays
      // chronological (private, never re-synced).
      setChat((prev) => (pub ? mergeChat(prev, imgItem) : appendChat(prev, imgItem)))
      imgCbRef.current?.({ from, name, dm: !!c.dm, ...img })
    } else if (c.k === 'xbegin' && c.offer === true) {
      // A PULL download OFFER (>1GB, the desktop-unbounded tier): the sender is holding the bytes until we
      // pick a disk location. We CAN'T open the save picker here (no user gesture), so we render an "Accept &
      // save" placeholder and stash the offer; acceptTransfer() (a click) opens the picker + sends xaccept.
      const canSave = largeXferOn() && detectSinkCaps().fsa
      const begin = validateBegin(c, SINK_MAX_BYTES.fsa)
      if (!begin || begin.kind === 'text') return
      const key = `${from}/${begin.id}`
      if (offerInRef.current.has(key) || incomingRef.current.has(key)) return // dup
      if (!canSave) {
        meshRef.current?.sendData(from, { k: 'xdecline', id: begin.id, ...(c.dm ? { dm: true as const } : {}) }) // can't save → tell the sender, don't strand it
        return
      }
      chatSeqRef.current += 1
      const chatId = chatSeqRef.current
      const att: Attachment = { xid: begin.id, kind: begin.kind, mime: begin.mime || 'application/octet-stream', name: begin.name, size: begin.size, progress: 0, state: 'offered' }
      setChat((prev) => appendChat(prev, { from, name, text: '', attachment: att, id: chatId, self: false, dm: !!c.dm }))
      offerInRef.current.set(key, { begin, from, fromName: name, chatId, dm: !!c.dm })
    } else if (c.k === 'xbegin') {
      // Begin a chunked content transfer. Validate the header (kind allowlist, size cap, n-vs-size), bound
      // concurrency per peer, and (for image/file) open a placeholder chat line with a progress bar. Text
      // transfers materialize into a chat line on completion instead.
      // The size cap is the RECEIVER'S: today's 50MB in-RAM ceiling, OR — when the large-transfer flag is on
      // AND this browser can stream to OPFS — the OPFS tier (1GB). FSA stays dormant in Phase 1 (it'd pop a
      // save dialog mid-chat); receive prefers OPFS, which renders inline / downloads from an object URL.
      const canDisk = largeXferOn() && detectSinkCaps().opfs
      const recvKind: SinkKind = canDisk ? 'opfs' : 'mem'
      const begin = validateBegin(c, SINK_MAX_BYTES[recvKind])
      if (!begin) return
      // Sender-scope a LIVE media mid (like chat/img) BEFORE it's used as the dedup key — otherwise a forged
      // `{mid:'<victimId>#7'}` xbegin poisons the shared media-dedup set (recvMediaMidsRef) so the victim's real
      // media line is dropped. A REPLAYED item (carries an original author) keeps that author's mid.
      if (begin.mid && !begin.author && !begin.mid.startsWith(`${from}#`)) begin.mid = `${from}#x${(chatRecvSeqRef.current += 1)}`
      // MEDIA REPLAY DEDUP: a PUBLIC media item carries a stable `mid`. If we've already accepted that mid — a
      // COMPLETED line we got before (live or an earlier replay), an in-flight placeholder, or our OWN sent item —
      // SKIP the whole re-transfer: don't open a placeholder, don't accept chunks. This is the dedup point for the
      // media reconciliation (a text line dedups in mergeChat on completion; media must dedup at xbegin, BEFORE
      // re-downloading the bytes). recvMediaMidsRef is the synchronous gate (chatRef refreshes only on re-render, so
      // two replays in one tick could both pass a buffer scan); the buffer scan is the durable backstop.
      const isPublicMedia = begin.kind !== 'text' && !c.dm
      // Already DONE in the buffer, or being received right now (the synchronous set) → skip. A FAILED/CANCELLED
      // line does NOT block — a later replay may complete it (the set is released on terminal failure below).
      const haveMid = !!begin.mid && (recvMediaMidsRef.current.has(begin.mid) || chatRef.current.some((it) => it.mid === begin.mid && it.attachment?.state === 'done'))
      if (isPublicMedia && haveMid) return
      const key = `${from}/${begin.id}`
      if (incomingRef.current.has(key)) return // duplicate begin
      let mine = 0
      for (const k of incomingRef.current.keys()) if (k.startsWith(`${from}/`)) mine++
      if (mine >= XFER.MAX_CONCURRENT_IN) return
      // For a REPLAYED public media item, attribute the placeholder to the ORIGINAL author (author/authorName off
      // the xbegin), preferring the live roster name if present — DISPLAY-ONLY + UNVERIFIED (never a verified
      // badge), the same rule as a replayed text line. A live transfer carries no author → attributed to the sender.
      const mediaAuthor = begin.kind !== 'text' && !c.dm ? resolveReplayAuthor(from, name, begin.author, begin.authorName, presentRosterName) : { from, name }
      let chatId = 0
      if (begin.kind !== 'text') {
        if (isPublicMedia && begin.mid) recvMediaMidsRef.current.add(begin.mid) // claim the mid synchronously (dedup gate)
        chatSeqRef.current += 1
        chatId = chatSeqRef.current
        const att: Attachment = { xid: begin.id, kind: begin.kind, mime: begin.mime || 'application/octet-stream', name: begin.name, size: begin.size, progress: 0, state: 'active' }
        const mediaItem = { from: mediaAuthor.from, name: mediaAuthor.name, text: '', attachment: att, id: chatId, self: false, dm: !!c.dm, mid: begin.mid, ts: begin.ts }
        // PUBLIC media → INSERT BY TS (so a re-transferred item lands at its ORIGINAL position, not the arrival end);
        // the per-chunk + xend in-place updates target this line by its chat id (it.id === e.chatId), so its position
        // is fixed at insert. DM media stays chronological (private, never re-synced).
        setChat((prev) => (isPublicMedia ? mergeChat(prev, mediaItem) : appendChat(prev, mediaItem)))
      }
      // Stream big image/file transfers to disk (OPFS); keep small ones and all text on the proven in-RAM
      // path. The sink is created async (storage probe → up-front fit check → OPFS file) and passed as a
      // promise, so early chunks queue behind it instead of racing it.
      const useDisk = canDisk && begin.kind !== 'text' && begin.size > XFER.MAX_BYTES
      let r: Reassembler | DiskReassembler
      if (useDisk) {
        const sinkP = (async () => {
          const est = await estimateStorage()
          if (!fitsTransfer(begin.size, 'opfs', est)) throw new Error('insufficient storage for this transfer')
          return createReceiveSink({ mime: begin.mime || 'application/octet-stream', name: begin.name, prefer: 'opfs' })
        })()
        // Cross-reload resume: once the OPFS file exists, persist the small metadata to find + continue it if
        // this tab reloads mid-transfer. Only for SALTED rooms (a stable per-room scope) + an OPFS sink (the
        // FSA download tier can't be reopened to append). Best-effort; deleted on complete/fail.
        const kv = persistKV()
        if (xferResumeOn() && roomSaltRef.current && kv) {
          const room = roomSaltRef.current
          void sinkP
            .then((sink) => {
              if (sink.kind === 'opfs' && sink.fileName)
                savePartial(kv, { xid: begin.id, room, from, fromName: name, sinkName: sink.fileName, kind: begin.kind as 'image' | 'file', mime: begin.mime, name: begin.name, size: begin.size, n: begin.n, dm: !!c.dm })
            })
            .catch(() => {})
        }
        r = new DiskReassembler(begin, sinkP, Date.now())
      } else {
        r = new Reassembler(begin, Date.now())
      }
      incomingRef.current.set(key, { r, chatId, kind: begin.kind, mime: begin.mime, name: begin.name, fromName: name, dm: !!c.dm, hasher: xferHashOn() ? new Sha256() : undefined, mid: begin.mid, ts: begin.ts, author: begin.author, authorName: begin.authorName })
    } else if (c.k === 'xchunk') {
      const e = incomingRef.current.get(`${from}/${c.id}`)
      if (!e || typeof c.i !== 'number') return
      // v2 carries raw bytes; v1 carries a base64 string. (A peer only sends binary to us after we advertised
      // xfer.v2, and only sends base64 to a v1 peer — so both forms are valid here.)
      const bytes = c.bytes instanceof Uint8Array ? c.bytes : typeof c.data === 'string' && isBase64(c.data) ? base64ToBytes(c.data) : null
      if (!bytes || !e.r.add(c.i, bytes, Date.now())) return
      e.hasher?.update(bytes) // integrity: hash accepted chunks in order; verified against xend.hash
      if (e.chatId) {
        const p = e.r.progress
        setChat((prev) => prev.map((it) => (it.id === e.chatId && it.attachment ? { ...it, attachment: { ...it.attachment, progress: p } } : it)))
      }
    } else if (c.k === 'xend') {
      const key = `${from}/${c.id}`
      const e = incomingRef.current.get(key)
      if (!e) return
      incomingRef.current.delete(key)
      const markFailed = () => {
        forgetPartial(c.id)
        if (e.mid) recvMediaMidsRef.current.delete(e.mid) // a failed media may be re-replayed → unclaim its mid
        if (e.chatId) setChat((prev) => prev.map((it) => (it.id === e.chatId && it.attachment ? { ...it, attachment: { ...it.attachment, state: 'failed' } } : it)))
      }
      // Integrity (both flags on): the sender's SHA-256 vs ours over the received bytes. Mismatch = corrupt
      // → fail BEFORE delivering (and free a disk temp), never hand over silently-bad bytes.
      if (e.hasher && typeof c.hash === 'string' && e.hasher.hex() !== c.hash) {
        markFailed()
        if (e.r instanceof DiskReassembler) void e.r.abort()
        return
      }
      if (e.r instanceof DiskReassembler) {
        // Streamed-to-disk image/file (never text): finalize async — await the queued writes, then take the
        // disk-backed File. Register its OPFS-temp cleanup against the object URL so eviction frees it.
        const dr = e.r
        if (!dr.complete) {
          markFailed()
          void dr.abort()
          return
        }
        void (async () => {
          try {
            const blob = await dr.assembleBlob()
            // Defence-in-depth integrity (both flags on, OPFS path): re-hash the bytes ACTUALLY ON DISK
            // against the sender's SHA-256, not just the in-flight view hash checked above. A storage sink
            // that silently transforms bytes (e.g. an iOS OPFS write() that ignored a view's byteOffset and
            // persisted a leaked frame header) passes the in-flight check but writes a corrupt file — this
            // catches it before delivery. FSA is exempt: its finish() returns an empty Blob (bytes live at
            // the user's chosen location, unreadable back); resume omits the hash, so c.hash is absent there.
            if (e.hasher && typeof c.hash === 'string' && dr.sink?.kind === 'opfs' && (await sha256HexOfBlob(blob)) !== c.hash) {
              markFailed()
              void dr.abort()
              return
            }
            // A download-tier (FSA) sink already wrote the bytes to the user's chosen file → finish() returns
            // an EMPTY blob; show "Saved", no preview/object URL. An OPFS sink returns a disk-backed File we
            // render/download from an object URL (freed + cleaned up on eviction).
            if (dr.sink?.kind === 'fsa') {
              setChat((prev) => prev.map((it) => (it.id === e.chatId && it.attachment ? { ...it, attachment: { ...it.attachment, progress: 1, state: 'done', saved: true } } : it)))
            } else {
              const url = URL.createObjectURL(blob)
              if (dr.sink?.cleanup) xferCleanupRef.current.set(url, () => dr.sink!.cleanup!())
              setChat((prev) => prev.map((it) => (it.id === e.chatId && it.attachment ? { ...it, attachment: { ...it.attachment, url, progress: 1, state: 'done' } } : it)))
            }
            // (No agent-perception base64 on the disk path — re-reading a GB-scale image into RAM would
            //  defeat the streaming; vision agents read small inline images on the in-RAM path.)
            // Resume: tell the sender we got it all so it can release the retained source.
            if (xferResumeOn()) meshRef.current?.sendData(from, { k: 'xack', id: c.id, ...(e.dm ? { dm: true as const } : {}) })
            forgetPartial(c.id) // done → drop the cross-reload record
          } catch {
            markFailed() // also forgets the partial
            void dr.abort()
          }
        })()
        return
      }
      if (!e.r.complete) {
        markFailed()
        return
      }
      const bytes = e.r.assemble()
      if (e.kind === 'text') {
        const text = bytesToText(bytes).slice(0, CHAT_MAX_LEN).trim()
        if (!text) return
        chatSeqRef.current += 1
        // Same split as the legacy `k:'chat'` path: a DM stays chronological; a PUBLIC text transfer carries the
        // sender's mid+ts (off the xbegin) and merges into the ordered union (dedup by mid on re-broadcast).
        if (e.dm) {
          setChat((prev) => appendChat(prev, { from, name: e.fromName, text, id: chatSeqRef.current, self: false, dm: true }))
        } else {
          chatRecvSeqRef.current += 1
          const { mid, ts } = resolveChatId(from, e.mid, e.ts, chatRecvSeqRef.current, Date.now())
          // REPLAYED line over xfer: honor the original author (author/authorName off the xbegin) for display,
          // preferring the live roster name if present — UNVERIFIED, same as the legacy k:'chat' path.
          const { from: author, name: authorName } = resolveReplayAuthor(from, e.fromName, e.author, e.authorName, (id) => presentRosterNameOf(rosterRef.current, id))
          setChat((prev) => mergeChat(prev, { from: author, name: authorName, text, id: chatSeqRef.current, self: false, mid, ts }))
        }
      } else {
        const mime = e.mime || 'application/octet-stream'
        const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }))
        // Retain base64 for the durable ledger — PUBLIC, in-RAM, at/under the cap (a DM never persists; an
        // over-cap or disk-streamed upload keeps metadata only). Reused for agent perception below, so ≤cap
        // media is base64-encoded once.
        const ledgerB64 = !e.dm && bytes.length <= LEDGER_ATTACH_MAX ? bytesToBase64(bytes) : undefined
        const blobRef = !e.dm ? stampBlob(bytes) : undefined // unified sync (flag-gated): store by hash → a fetchable ref
        setChat((prev) => prev.map((it) => (it.id === e.chatId && it.attachment ? { ...it, attachment: { ...it.attachment, url, progress: 1, state: 'done', ...(ledgerB64 ? { data: ledgerB64 } : {}), ...(blobRef ? { hash: blobRef } : {}) } } : it)))
        // Agent perception (parity with the legacy onImage): surface a received IMAGE as bytes-as-base64.
        if (e.kind === 'image' && imgCbRef.current) imgCbRef.current({ from, name: e.fromName, dm: e.dm, mime, data: ledgerB64 ?? bytesToBase64(bytes) })
        // The file twin: surface a completed FILE transfer (e.g. a shared PDF) to onFile, carrying the file's
        // own name so a file-reading agent (read_pdf) can label/type it. Same bytes-as-base64 shape as images.
        else if (e.kind === 'file' && fileCbRef.current) fileCbRef.current({ from, name: e.fromName, dm: e.dm, mime, fileName: e.name, data: ledgerB64 ?? bytesToBase64(bytes) })
      }
    } else if (c.k === 'xcancel') {
      // RECEIVE side — the SENDER cancelled a transfer we were receiving (or an offer we hadn't accepted):
      // free the partial OPFS temp + drop the placeholder, marked `cancelled` (a stop, not an error).
      const e = incomingRef.current.get(`${from}/${c.id}`)
      if (e) {
        incomingRef.current.delete(`${from}/${c.id}`)
        if (e.mid) recvMediaMidsRef.current.delete(e.mid) // cancelled media may be re-replayed → unclaim its mid
        if (e.r instanceof DiskReassembler) void e.r.abort() // free the partial OPFS temp
        forgetPartial(c.id)
        if (e.chatId) setChat((prev) => prev.map((it) => (it.id === e.chatId && it.attachment ? { ...it, attachment: { ...it.attachment, state: 'cancelled' } } : it)))
      }
      const off = offerInRef.current.get(`${from}/${c.id}`)
      if (off) {
        offerInRef.current.delete(`${from}/${c.id}`)
        setChat((prev) => prev.map((it) => (it.id === off.chatId && it.attachment ? { ...it, attachment: { ...it.attachment, state: 'cancelled' } } : it)))
      }
      // SEND side — the RECEIVER `from` cancelled a transfer WE were sending to them. Stop ONLY their stream
      // (the per-peer cancel key; a broadcast keeps streaming to everyone else), release their retained
      // source/offer, and drop them from the progress tracker. If they were the LAST recipient, the whole
      // send is cancelled → paint it `cancelled`; otherwise it stays `active` and finishes for the rest.
      const inbound = !!e || !!off // we were the receiver for this (from,xid) — not the sender; skip send cleanup
      if (!inbound) {
        sendCancelRef.current.add(`${from}/${c.id}`)
        activeSendRef.current.delete(`${from}/${c.id}`)
        offerOutRef.current.delete(`${from}/${c.id}`)
        const m = sendProgRef.current.get(c.id)
        if (m && m.delete(from)) {
          if (m.size === 0) {
            sendProgRef.current.delete(c.id)
            setChat((prev) => prev.map((it) => (it.attachment?.xid === c.id && it.attachment.state === 'active' ? { ...it, attachment: { ...it.attachment, state: 'cancelled' } } : it)))
          } else {
            const done = allSendsComplete([...m.values()])
            if (done) sendProgRef.current.delete(c.id)
            const p = done ? 1 : minSendProgress(m.values())
            setChat((prev) => prev.map((it) => (it.attachment?.xid === c.id && it.attachment.state === 'active' ? { ...it, attachment: { ...it.attachment, progress: p, ...(done ? { state: 'done' as const } : {}) } } : it)))
          }
        }
      }
    } else if (c.k === 'xaccept') {
      // The receiver accepted a pull-download OFFER we sent (they chose a disk location) → stream it now.
      const o = offerOutRef.current.get(`${from}/${c.id}`)
      if (o) {
        offerOutRef.current.delete(`${from}/${c.id}`)
        // Retain for resume if both sides support it (so an xresume can re-drive the stream).
        const hasResume = !!readEngineMeta(rosterRef.current.find((x) => x.id === from)?.meta).features?.includes('xfer.resume')
        if (xferResumeOn() && hasResume) activeSendRef.current.set(`${from}/${c.id}`, o)
        void sendFileStreamingToRef.current?.(o.peerId, c.id, o.kind, o.file, o.mime, o.name, o.dm, o.binary)
      }
    } else if (c.k === 'xdecline') {
      // The receiver declined / cancelled the save dialog (or can't save) → drop the pending offer.
      offerOutRef.current.delete(`${from}/${c.id}`)
    } else if (c.k === 'xresume') {
      // The receiver's transfer stalled (or its tab RELOADED) and it's asking us to re-stream from chunk
      // `have`. Match the retained source by XID across any peer key — a reloaded receiver returns with a NEW
      // peer id — then re-key it to the current `from` and re-drive. Idempotent: the receiver drops chunks <
      // its position. `have` is bounded to the file.
      const srcKey = findSendKeyByXid(activeSendRef.current.keys(), c.id)
      const a = srcKey ? activeSendRef.current.get(srcKey) : undefined
      const have = typeof c.have === 'number' && Number.isInteger(c.have) && c.have >= 0 ? c.have : 0
      if (a && srcKey) {
        if (a.peerId !== from) {
          activeSendRef.current.delete(srcKey)
          activeSendRef.current.set(`${from}/${c.id}`, { ...a, peerId: from }) // re-key to the reconnected receiver
          // Re-key the progress entry too (a reloaded receiver = NEW peer id), preserving its fraction, so a
          // stale old-id entry can't keep the bar from ever reaching `done`.
          const mm = sendProgRef.current.get(c.id)
          if (mm && mm.has(a.peerId)) {
            mm.set(from, mm.get(a.peerId) ?? 0)
            mm.delete(a.peerId)
          }
          sendCancelRef.current.delete(`${a.peerId}/${c.id}`)
        }
        sendCancelRef.current.delete(c.id) // a prior stall may have flagged cancel; clear it for the resume
        sendCancelRef.current.delete(`${from}/${c.id}`)
        void sendFileStreamingToRef.current?.(from, c.id, a.kind, a.file, a.mime, a.name, a.dm, a.binary, have)
      }
    } else if (c.k === 'xack') {
      // The receiver got the whole transfer → release the retained source.
      activeSendRef.current.delete(`${from}/${c.id}`)
    } else if (c.k === 'idtoken') {
      // Stash the peer's signed token; verification (signature + cert binding) happens
      // lazily in getIdentity, since the connection's cert may not be readable yet.
      // Cap the length (a Google RS256 token is ~1KB) so a peer can't DoS us with a
      // multi-megabyte "jwt" that we'd then base64-decode and run through WebCrypto.
      if (typeof c.jwt === 'string' && c.jwt && c.jwt.length <= JWT_MAX) {
        idTokensRef.current.set(from, c.jwt)
        idCacheRef.current.delete(from) // a new token invalidates any cached result
        capMap(idTokensRef.current, IDTOKEN_CAP)
      }
    }
  }, [])

  // Verified-roster send gate (docs §7): a broadcast needs `canShare` (I and EVERY present
  // peer have proven a listed identity); a directed message needs only that ONE peer cleared
  // (others can't see it anyway). Inert — always true — when the gate isn't active.
  const sendAllowed = useCallback((to?: string): boolean => {
    const g = rosterGateRef.current
    if (g.active && (to ? !peerCleared(g, to) : !g.canShare)) return false
    // Capability (PERCEIVE): a DIRECTED message needs the recipient to allow directed data. A
    // broadcast's per-recipient withholding is done in broadcastContent, so it isn't blocked here.
    if (to && !canPerceive(grantOf(to), 'receive-directed')) return false
    return true
  }, [grantOf])

  // Send-side / PERCEIVE enforcement for broadcasts: deliver only to recipients whose grant allows the
  // relevant perceive cap (`read-chat` for text, `read-media` for images). A peer without it never
  // receives the bytes (real sender-side withholding, not a receiver drop). When everyone can perceive
  // — the common case — it's the single fast broadcast.
  const broadcastContent = useCallback(
    (msg: ContentMsg, cap: Perceive = 'read-chat') => {
      const mesh = meshRef.current
      if (!mesh) return
      const others = rosterRef.current.filter((m) => m.id !== voiceIdRef.current)
      if (others.every((m) => canPerceive(grantOf(m.id), cap))) {
        mesh.broadcastData(msg)
        return
      }
      for (const m of others) if (canPerceive(grantOf(m.id), cap)) mesh.sendData(m.id, msg)
    },
    [grantOf],
  )

  // Mint the stable global id (`${voiceId}#${seq}`) + send time for a line WE author — the dedup key (mid) +
  // order key (ts) carried on the wire + the local echo. The line itself lands in the chat buffer (echo/merge),
  // which IS the reconciliation re-broadcast source, so there's nothing to retain separately here.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- refs are stable
  const stampOwnChat = useCallback((): { mid: string; ts: number } => {
    chatMidSeqRef.current += 1
    return { mid: `${voiceIdRef.current}#${chatMidSeqRef.current}`, ts: Date.now() }
  }, [])

  // Seed the prior PUBLIC transcript (cross-call persistence): a headless controller (the persisting agent) calls
  // this on rejoin with the lines it saved — each carrying its ORIGINAL author. We MERGE each into our chat buffer
  // (dedup by mid — a re-seed, or a live line that already arrived, never doubles). Because the buffer IS the
  // reconciliation re-broadcast source, the seeded lines are then vouched to the room on the next roster change WITH
  // their original from/name — no separate seeded map needed. Each field is validated + bounded (untrusted input).
  // PUBLIC only; the carried attribution is DISPLAY-ONLY + UNVERIFIED (a seeded line never gets a verified badge).
  // No-op without send permission.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- setChat is stable
  const seedChatHistory = useCallback((lines: readonly { text?: string; image?: ImagePayload; mid: string; ts: number; from: string; name: string }[]) => {
    if (!Array.isArray(lines) || !lines.length || !sendAllowed()) return
    // Build off the buffer ref (chatRef) and sync it back SYNCHRONOUSLY (a setChat state update is NOT visible to a
    // same-tick handler). chatItemFromSeedLine is pure (tested in seedChat.test.ts). NOTE (2026-07-02): the
    // late-joiner replay family was removed, so a seed now only FILLS this peer's own buffer — it is not re-broadcast.
    let next = chatRef.current
    let seeded = 0
    for (const raw of lines) {
      const item = chatItemFromSeedLine(raw, chatSeqRef.current + 1, CHAT_MAX_LEN)
      if (!item) continue
      chatSeqRef.current += 1
      next = mergeChat(next, item) // dedup by mid; a live line with this mid already present is kept
      seeded += 1
    }
    if (!seeded) return
    chatRef.current = next // sync the reconcile source NOW so the handlers below see the seed
    setChat(next)
    // Fire the roster-change handlers so any that DO still ride the seam (schema discovery, the owner's own widget
    // replay) see the freshly-seeded buffer. NOTE (2026-07-02): the text/media/widget late-joiner replay that used to
    // re-emit the seed to peers was removed, so a seed no longer re-broadcasts content — it only restores this peer's view.
    // eslint-disable-next-line no-console
    console.log(`[kibitz] seedChatHistory: seeded ${seeded}/${lines.length} line(s); reconciling to ${rosterChangeHandlersRef.current.size} handler(s)`)
    for (const fn of rosterChangeHandlersRef.current) fn()
  }, [sendAllowed])

  // ── Chat LEDGER (docs/chat-ledger.md) — the durable snapshot of the held public chat, as a first-class object.
  // A "durable member" (the persisting agent, Layer 2) EXPORTS this to seal + store when the room changes/empties,
  // and IMPORTS it on rejoin — contributed back through the SAME union path everyone uses. This supersedes rebuilding
  // chat from a private event log (text + image + widget, keyed by mid / content id / widget id; DMs excluded).

  /** The held public chat as a durable, serializable snapshot (ordered, deduped, capped). */
  // eslint-disable-next-line react-hooks/exhaustive-deps -- chatRef is reference-stable
  const exportLedger = useCallback((): LedgerItem[] => serializeLedger(chatRef.current, CHAT_KEEP), [])
  // A CHEAP content signature of the held public ledger (a persisting agent polls this and only runs the heavy
  // exportLedger when it moves). Hashes the ledger items' IDENTITY (text mid / widget id / image size+prefix) + ts —
  // NO byte-hashing — so transient churn (attachment progress, re-renders) that doesn't change the ledger set leaves
  // it unmoved. A same-length image swap could alias, but its ts differs; worst case is one deferred persist.
  const ledgerVersion = useCallback((): number => {
    let h = 0
    for (const it of chatRef.current) {
      if (it.dm) continue
      // Attachments count too — and the marker flips when the bytes LAND (`:b`) vs the in-flight placeholder
      // (`:0`), so a completed upload bumps the version and the agent re-persists it WITH the bytes.
      const id =
        it.widget?.id ||
        (it.attachment ? `${it.mid || it.attachment.xid}:${it.attachment.data ? 'b' : '0'}` : '') ||
        (it.image ? `i${it.image.data.length}:${it.image.data.slice(0, 24)}` : it.text && it.mid ? it.mid : '')
      if (!id) continue
      for (const ch of `${id}~${it.ts || 0}|`) h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0
    }
    return h >>> 0
  }, [])

  /** Merge a restored ledger snapshot into the buffer, then reconcile it to present peers (mirrors seedChatHistory:
   *  sync chatRef synchronously, then fire the roster-change handlers so the sync family delivers it). */
  const importLedger = useCallback((snapshot: unknown) => {
    const items = deserializeLedger(snapshot)
    if (!items.length || !sendAllowed()) return
    let next = chatRef.current
    let n = 0
    for (const li of items) {
      if (li.kind === 'widget' && li.widget) {
        next = recordWidget(next, { from: li.from, name: li.name, id: li.widget.id, kind: li.widget.kind, data: li.widget.data, ts: li.ts }, chatSeqRef.current + 1)
        chatSeqRef.current += 1
        n += 1
        continue
      }
      if (li.kind === 'attachment' && li.attachment) {
        // Rebuild an uploaded image/file as a completed attachment: bytes present ⇒ a fresh object URL so it
        // renders + re-downloads; bytes absent ⇒ a
        // metadata-only "shared earlier" chip. Keyed by li.id (the public mid) so it dedups vs the live line.
        const a = li.attachment
        let url: string | undefined
        if (a.data) {
          try {
            url = URL.createObjectURL(new Blob([base64ToBytes(a.data) as BlobPart], { type: a.mime }))
          } catch {
            url = undefined
          }
        }
        chatSeqRef.current += 1
        const att: Attachment = { xid: li.id, kind: a.kind, mime: a.mime, name: a.name, size: a.size, progress: 1, state: 'done', ...(url ? { url } : {}), ...(a.data ? { data: a.data } : {}) }
        next = mergeChat(next, { from: li.from, name: li.name, text: '', attachment: att, id: chatSeqRef.current, self: false, mid: li.id, ts: li.ts })
        n += 1
        continue
      }
      const item = chatItemFromSeedLine({ text: li.text, image: li.image, mid: li.id, ts: li.ts, from: li.from, name: li.name }, chatSeqRef.current + 1, CHAT_MAX_LEN)
      if (!item) continue
      chatSeqRef.current += 1
      next = mergeChat(next, item)
      n += 1
    }
    if (!n) return
    chatRef.current = next // sync the reconcile source before firing handlers (same tick)
    setChat(next)
    // eslint-disable-next-line no-console
    console.log(`[kibitz] importLedger: ${n}/${items.length} item(s); reconciling to ${rosterChangeHandlersRef.current.size} handler(s)`)
    for (const fn of rosterChangeHandlersRef.current) fn()
  }, [sendAllowed])

  // Send to ONE peer (private, point-to-point) when `to` is given, else broadcast.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- broadcastContent is stable
  const sendChat = useCallback((text: string, to?: string) => {
    const t = (text || '').slice(0, CHAT_MAX_LEN).trim()
    if (!t || !meshRef.current || !sendAllowed(to)) return
    const { mid, ts } = stampOwnChat()
    const msg = { k: 'chat', text: t, mid, ts, ...(to ? { dm: true as const } : {}) } satisfies ContentMsg
    if (to) meshRef.current.sendData(to, msg)
    else broadcastContent(msg)
    // Local echo — no relay returns our own line to us anymore. Carries mid+ts so a peer's re-broadcast of the
    // SAME line (it arrives back via reconciliation? no — broadcasts never echo home) and our own re-broadcast
    // both dedup against this echo by mid.
    chatSeqRef.current += 1
    const echo = {
      from: voiceIdRef.current,
      name: nameRef.current.trim() || 'You',
      text: t,
      id: chatSeqRef.current,
      self: true,
      mid,
      ts,
      ...(to ? { dm: true as const, to: rosterName(rosterRef.current, to) } : {}),
    }
    setChat((prev) => (to ? appendChat(prev, echo) : mergeChat(prev, echo)))
  }, [sendAllowed, stampOwnChat])

  // Send an (already-compressed) image payload. With `to` it's private to that one peer; without, it's
  // broadcast — withheld from any peer (e.g. an agent) not granted `read-media`. Local echo mirrors chat.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- broadcastContent is stable
  const sendImage = useCallback((img: ImagePayload, to?: string) => {
    if (!meshRef.current || !sendAllowed(to)) return
    const clean = sanitizeImg(img)
    if (!clean) return
    // A directed image still requires the recipient to be granted media perception (the broadcast path
    // withholds via read-media; the directed path must check it explicitly).
    if (to && !canPerceive(grantOf(to), 'read-media')) return
    const msg = {
      k: 'img',
      mime: clean.mime,
      data: clean.data,
      ...(clean.name ? { name: clean.name } : {}),
      ...(clean.w ? { w: clean.w } : {}),
      ...(clean.h ? { h: clean.h } : {}),
      ...(to ? { dm: true as const } : {}),
    } satisfies ContentMsg
    if (imgTooBig(msg)) {
      // eslint-disable-next-line no-console
      console.warn(`[kibitz] image exceeds ${Math.round((256 * 1024) / 1024)}KB after compression — not sent`)
      return
    }
    if (to) meshRef.current.sendData(to, msg)
    else broadcastContent(msg, 'read-media')
    chatSeqRef.current += 1
    setChat((prev) =>
      appendChat(prev, {
        from: voiceIdRef.current,
        name: nameRef.current.trim() || 'You',
        text: '',
        image: clean,
        id: chatSeqRef.current,
        self: true,
        dm: !!to,
        to: to ? rosterName(rosterRef.current, to) : undefined,
      }),
    )
  }, [sendAllowed, grantOf])

  const onImage = useCallback((cb: (m: ImageMessage) => void) => {
    imgCbRef.current = cb
  }, [])

  const onFile = useCallback((cb: (m: FileMessage) => void) => {
    fileCbRef.current = cb
  }, [])

  // Does a peer run a build that understands the chunked transfer? (Else we fall back to legacy chat/img.)
  const peerSupportsXfer = useCallback((id: string): boolean => {
    const m = rosterRef.current.find((x) => x.id === id)
    return !!readEngineMeta(m?.meta).features?.includes('xfer.v1')
  }, [])
  // Does this peer speak xfer.v2 (raw binary chunks)? If so we send binary; else base64 xfer.v1.
  const peerSupportsXferV2 = useCallback((id: string): boolean => {
    const m = rosterRef.current.find((x) => x.id === id)
    return !!readEngineMeta(m?.meta).features?.includes('xfer.v2')
  }, [])
  // Can this peer RECEIVE a >1GB pull download (offer/xaccept → stream to a chosen disk file)?
  const peerSupportsXferDl = useCallback((id: string): boolean => {
    const m = rosterRef.current.find((x) => x.id === id)
    return !!readEngineMeta(m?.meta).features?.includes('xfer.dl')
  }, [])
  // Can this peer drive/answer a same-session resume (xresume/xack)?
  const peerSupportsXferResume = useCallback((id: string): boolean => {
    const m = rosterRef.current.find((x) => x.id === id)
    return !!readEngineMeta(m?.meta).features?.includes('xfer.resume')
  }, [])

  // Send one transfer to ONE peer, paced against its data-channel buffer (backpressure) so a big file
  // doesn't overrun the channel. Returns false if cancelled mid-flight.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- reads meshRef/sendCancelRef (stable)
  const sendXferTo = useCallback(
    async (peerId: string, xid: string, kind: XferKind, chunks: readonly Uint8Array[], size: number, mime: string | undefined, fname: string | undefined, dm: boolean, binary: boolean, hash?: string, chat?: { mid: string; ts: number; from?: string; name?: string }): Promise<boolean> => {
      const mesh = meshRef.current
      if (!mesh) return false
      const tail = dm ? { dm: true as const } : {}
      // A PUBLIC transfer (text OR media) carries the stable chat id + send time on its xbegin, so the receiver can
      // merge + dedup it in the reconciled public union (parity with the legacy k:'chat' line). On a REPLAY (a held
      // item re-transferred on a roster change) it ALSO carries the ORIGINAL author (author/authorName) so a
      // backfilled image/file shows who really shared it, not the peer that re-sent it. DISPLAY-ONLY + UNVERIFIED.
      const chatTail = chat && !dm ? { mid: chat.mid, ts: chat.ts, ...(chat.from ? { author: chat.from } : {}), ...(chat.name ? { authorName: chat.name } : {}) } : {}
      // Transfers ride the BULK content channel. Wait (briefly) for it to open before xbegin so the chunks never
      // straddle the sig→bulk handover. A peer that never opens a bulk link (old / pre-handshake) times out and we
      // bail; the public-chat reconciliation re-delivers the item once that peer reloads onto the new build.
      for (let waited = 0; !mesh.dataLinkOpen(peerId) && waited < XFER_BULK_WAIT_MS; waited += XFER_POLL_MS) await xferDelay(XFER_POLL_MS)
      if (!mesh.dataLinkOpen(peerId)) return false
      mesh.sendData(peerId, { k: 'xbegin', id: xid, kind, size, n: chunks.length, ...(mime ? { mime } : {}), ...(fname ? { name: fname } : {}), ...chatTail, ...tail })
      for (let i = 0; i < chunks.length; i++) {
        if (sendCancelRef.current.has(xid) || sendCancelRef.current.has(`${peerId}/${xid}`)) {
          mesh.sendData(peerId, { k: 'xcancel', id: xid, ...tail })
          return false
        }
        let guard = 0
        while (mesh.dataBufferedAmount(peerId) > XFER_HIGH_WATER && guard++ < 2000) await xferDelay(XFER_POLL_MS)
        if (!mesh.dataLinkOpen(peerId)) return false // bulk dropped mid-transfer → bail (no straddle); reconciliation recovers
        // xfer.v2: a raw binary frame (no base64). xfer.v1: a base64 `xchunk`. The xbegin (above) already
        // carried `dm`, so the binary chunk needs no envelope — the receiver routes by the open transfer.
        if (binary) mesh.sendData(peerId, encodeChunkFrame(xid, i, chunks[i]))
        else mesh.sendData(peerId, { k: 'xchunk', id: xid, i, data: bytesToBase64(chunks[i]), ...tail })
      }
      mesh.sendData(peerId, { k: 'xend', id: xid, ...(hash ? { hash } : {}), ...tail })
      return true
    },
    [],
  )

  // Send arbitrary content (text / image / file) as a chunked transfer. Withheld from any peer lacking
  // the kind's perceive cap (read-chat / read-media / read-files). A peer on an older build (no
  // 'xfer.v1') gets a LEGACY fallback so cross-version chat never breaks: text → k:'chat'; a small
  // image → k:'img'; a file can't be delivered to it (skipped). Echoes locally right away.
  // `replay` re-transfers a PUBLIC media/text item WE ALREADY HOLD (a held-item re-share): it
  // reuses the item's ORIGINAL stable id (mid/ts) + author (from/name) so the receiver dedups it (mergeChat / the
  // xbegin mid-skip) and shows the original author — and it SKIPS the local echo (we already have the line). A
  // normal (non-replay) send mints a fresh stamp and echoes locally as today.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- broadcastContent/sendXferTo are stable
  const sendContent = useCallback((kind: XferKind, bytes: Uint8Array, opts: { mime?: string; name?: string } = {}, to?: string, replay?: { mid: string; ts: number; from: string; name: string }) => {
    const mesh = meshRef.current
    if (!mesh || !sendAllowed(to)) return
    if (bytes.length > XFER.MAX_BYTES) {
      // eslint-disable-next-line no-console
      console.warn(`[kibitz] content exceeds the ${Math.round(XFER.MAX_BYTES / (1024 * 1024))}MB transfer cap — not sent`)
      return
    }
    const cap = capForKind(kind)
    if (to && !canPerceive(grantOf(to), cap)) return
    const xid = newXid()
    const others = rosterRef.current.filter((m) => m.id !== voiceIdRef.current)
    const targets = (to ? others.filter((m) => m.id === to) : others).filter((m) => canPerceive(grantOf(m.id), cap))
    const chunks = splitChunks(bytes) // raw chunks; base64 is applied per-peer only for v1 (inside sendXferTo)
    const hash = xferHashOn() ? sha256Hex(bytes) : undefined // one-shot over the whole payload, shared by all peers
    // Stamp the item with a stable id + send time, carried on the xbegin/legacy so the receiver dedups + orders it
    // in the public union (text AND media now). REPLAY reuses the original stamp + carries the original author;
    // a fresh PUBLIC send mints one (DMs aren't reconciled, so they don't need a stamp, but stamping is harmless).
    const stamp = replay ? { mid: replay.mid, ts: replay.ts, from: replay.from, name: replay.name } : !to ? { ...stampOwnChat() } : undefined
    for (const m of targets) {
      if (peerSupportsXfer(m.id)) {
        void sendXferTo(m.id, xid, kind, chunks, bytes.length, opts.mime, opts.name, !!to, xferV2On() && peerSupportsXferV2(m.id), hash, stamp)
      } else if (kind === 'text') {
        mesh.sendData(m.id, { k: 'chat', text: bytesToText(bytes).slice(0, CHAT_MAX_LEN), ...(stamp ? { mid: stamp.mid, ts: stamp.ts } : {}), ...(replay ? { from: replay.from, name: replay.name } : {}), ...(to ? { dm: true as const } : {}) } satisfies ContentMsg)
      } else if (kind === 'image' && opts.mime) {
        const data = bytesToBase64(bytes)
        // `name` stays the image's FILE name; the replayed AUTHOR rides from/name2 (not name) so it isn't clobbered.
        const legacy = { k: 'img' as const, mime: opts.mime, data, ...(opts.name ? { name: opts.name } : {}), ...(stamp ? { mid: stamp.mid, ts: stamp.ts } : {}), ...(replay ? { from: replay.from, name2: replay.name } : {}), ...(to ? { dm: true as const } : {}) } satisfies ContentMsg
        if (!imgTooBig(legacy)) mesh.sendData(m.id, legacy) // an old peer can't take a big image; skip if it won't fit
      }
      // (a FILE to a pre-xfer peer has no legacy carrier — skipped.)
    }
    // Local echo. A REPLAY already holds the line locally → no echo (it would just dedup, but skip the churn).
    if (replay) return
    chatSeqRef.current += 1
    const id = chatSeqRef.current
    const selfName = nameRef.current.trim() || 'You'
    if (kind === 'text') {
      const text = bytesToText(bytes).slice(0, CHAT_MAX_LEN).trim()
      if (text) {
        const echo = { from: voiceIdRef.current, name: selfName, text, id, self: true, mid: stamp?.mid, ts: stamp?.ts, ...(to ? { dm: true as const, to: rosterName(rosterRef.current, to) } : {}) }
        setChat((prev) => (to ? appendChat(prev, echo) : mergeChat(prev, echo)))
      }
    } else {
      // The sender already has the bytes — show it immediately (done), no sender-side progress bar. Media now also
      // carries the stable mid/ts so a held-item re-share can dedup it (receivers dedup by mid at xbegin).
      const mime = opts.mime || 'application/octet-stream'
      // Retain base64 for the ledger on our OWN public upload too (so the sender contributes the bytes to the
      // durable union) — public + at/under the cap only.
      const blobRef = !to ? stampBlob(bytes) : undefined // unified sync (flag-gated): our own upload, stored by hash
      const att: Attachment = { xid, kind, mime, name: opts.name, size: bytes.length, url: URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime })), progress: 1, state: 'done', ...(!to && bytes.length <= LEDGER_ATTACH_MAX ? { data: bytesToBase64(bytes) } : {}), ...(blobRef ? { hash: blobRef } : {}) }
      const echo = { from: voiceIdRef.current, name: selfName, text: '', attachment: att, id, self: true, mid: stamp?.mid, ts: stamp?.ts, ...(to ? { dm: true as const, to: rosterName(rosterRef.current, to) } : {}) }
      setChat((prev) => (to ? appendChat(prev, echo) : mergeChat(prev, echo)))
    }
  }, [sendAllowed, grantOf, peerSupportsXfer, stampOwnChat])

  // Advance the SENDER's progress bar for a streamed send: record this peer's fraction, repaint the bar at
  // the MIN across peers, and flip the attachment to `done` once EVERY tracked peer has the whole file. Reads
  // only refs + the stable setChat, so it's safe to call from the []-dep streaming loop (and from a resume).
  // eslint-disable-next-line react-hooks/exhaustive-deps -- refs + setChat are stable
  const reportSendProgress = useCallback((xid: string, peerId: string, frac: number) => {
    let m = sendProgRef.current.get(xid)
    if (!m) {
      m = new Map<string, number>()
      sendProgRef.current.set(xid, m)
    }
    m.set(peerId, Math.max(0, Math.min(1, frac)))
    const done = allSendsComplete([...m.values()])
    if (done) sendProgRef.current.delete(xid)
    const p = done ? 1 : minSendProgress(m.values())
    setChat((prev) =>
      prev.map((it) =>
        it.attachment?.xid === xid && it.attachment.state === 'active'
          ? { ...it, attachment: { ...it.attachment, progress: p, ...(done ? { state: 'done' as const } : {}) } }
          : it,
      ),
    )
  }, [])

  // Convenience: read a File/Blob and send it as a transfer (image kind if it's an image mime, else file).
  // Stream a File to ONE peer by slicing it lazily — read each chunk from disk on demand (~one chunk in
  // heap) instead of buffering the whole file + pre-base64ing it. Same xbegin/xchunk/xend wire as sendXferTo
  // (base64 in Phase 1), same XFER_HIGH_WATER backpressure. For the large path only.
  const sendFileStreamingTo = useCallback(
    async (peerId: string, xid: string, kind: XferKind, file: File | Blob, mime: string, fname: string | undefined, dm: boolean, binary: boolean, startChunk = 0): Promise<boolean> => {
      const mesh = meshRef.current
      if (!mesh) return false
      const tail = dm ? { dm: true as const } : {}
      // A RESUME (startChunk>0): the receiver already has the placeholder + sink, so don't re-send xbegin, and
      // don't hash (the sender can't cheaply hash from a mid-offset → the resumed xend carries no hash, and
      // the receiver simply skips the integrity check when no hash is present). A fresh send hashes in one pass.
      const hasher = startChunk === 0 && xferHashOn() ? new Sha256() : null
      if (startChunk === 0) mesh.sendData(peerId, { k: 'xbegin', id: xid, kind, size: file.size, n: chunkCount(file.size), ...(mime ? { mime } : {}), ...(fname ? { name: fname } : {}), ...tail })
      // Read the file in big SLABS, emit CHUNK_BYTES wire frames from each — one disk read per slab instead of
      // one per 48KB frame (the wire unit / chunk index is unchanged, so the receiver is unaffected).
      for (let i = startChunk, slabOff = startChunk * XFER.CHUNK_BYTES; slabOff < file.size; slabOff += XFER_READ_SLAB) {
        if (sendCancelRef.current.has(xid) || sendCancelRef.current.has(`${peerId}/${xid}`)) {
          mesh.sendData(peerId, { k: 'xcancel', id: xid, ...tail })
          return false
        }
        if (!mesh.dataLinkOpen(peerId)) return false // link dropped — bail before the disk read (see below)
        const slab = new Uint8Array(await file.slice(slabOff, Math.min(slabOff + XFER_READ_SLAB, file.size)).arrayBuffer())
        for (let p = 0; p < slab.length; p += XFER.CHUNK_BYTES, i++) {
          if (sendCancelRef.current.has(xid) || sendCancelRef.current.has(`${peerId}/${xid}`)) {
            mesh.sendData(peerId, { k: 'xcancel', id: xid, ...tail })
            return false
          }
          let guard = 0
          while (mesh.dataBufferedAmount(peerId) > XFER_HIGH_WATER && guard++ < 2000) await xferDelay(XFER_POLL_MS)
          // ABORT IF THE LINK DROPPED. PeerJS closes the whole DataConnection when a send throws (a congested /
          // relayed link) or an ICE blip hits. If we kept looping we'd silently drop the rest into the void and —
          // once the mesh re-dials mid-loop — push the file's TAIL plus a bogus `xend` over the fresh link, which
          // the receiver sees as a gap and FAILS. Instead bail without an xend: the receiver stays resumable and
          // recovers from its position via `xresume`. (A fresh send re-checks here every chunk; a resume re-enters
          // with startChunk>0 over the re-established link.)
          if (!mesh.dataLinkOpen(peerId)) return false
          const chunk = slab.subarray(p, Math.min(p + XFER.CHUNK_BYTES, slab.length))
          hasher?.update(chunk)
          if (binary) mesh.sendData(peerId, encodeChunkFrame(xid, i, chunk))
          else mesh.sendData(peerId, { k: 'xchunk', id: xid, i, data: bytesToBase64(chunk), ...tail })
        }
        // SENDER progress: a slab's worth landed in the send buffer → advance this peer's fraction and
        // repaint the bar at the MIN across peers (so a broadcast bar tracks the slowest receiver).
        reportSendProgress(xid, peerId, file.size ? Math.min(slabOff + XFER_READ_SLAB, file.size) / file.size : 1)
      }
      if (!mesh.dataLinkOpen(peerId)) return false // link died as we finished — don't send a misleading xend
      mesh.sendData(peerId, { k: 'xend', id: xid, ...(hasher ? { hash: hasher.hex() } : {}), ...tail })
      reportSendProgress(xid, peerId, 1) // this peer has it all; flips the attachment to `done` once every peer does
      return true
    },
    [],
  )
  // dispatchContent (stable []-dep) starts a stream when a download OFFER is accepted, so it reads the
  // streamer through a ref (not the closure).
  const sendFileStreamingToRef = useRef(sendFileStreamingTo)
  sendFileStreamingToRef.current = sendFileStreamingTo

  const sendFile = useCallback(
    (file: File | Blob, to?: string) => {
      const name = (file as File).name || undefined
      const mime = file.type || 'application/octet-stream'
      const kind: XferKind = /^image\//i.test(mime) ? 'image' : 'file'
      // Over the in-RAM cap and the large-transfer tier is OFF → don't drop it silently (the old behaviour was
      // a bare console.warn): show a FAILED attachment that says WHY, so the user understands the 50 MB limit.
      if (!largeXferOn() && file.size > XFER.MAX_BYTES) {
        const mb = Math.max(1, Math.round(file.size / (1024 * 1024)))
        const capMb = Math.round(XFER.MAX_BYTES / (1024 * 1024))
        chatSeqRef.current += 1
        const att: Attachment = { xid: newXid(), kind, mime, name, size: file.size, progress: 0, state: 'failed', reason: `too large (${mb} MB) — ${capMb} MB max` }
        setChat((prev) => appendChat(prev, { from: voiceIdRef.current, name: nameRef.current.trim() || 'You', text: '', attachment: att, id: chatSeqRef.current, self: true, dm: !!to, to: to ? rosterName(rosterRef.current, to) : undefined }))
        return
      }
      // Small files (or the flag off): today's path — read whole + sendContent (≤50MB, base64). Unchanged.
      if (!(largeXferOn() && file.size > XFER.MAX_BYTES)) {
        file
          .arrayBuffer()
          .then((buf) => sendContent(kind, new Uint8Array(buf), { mime, name }, to))
          .catch(() => {
            /* couldn't read the file — ignore; the user can retry */
          })
        return
      }
      // Large path: route PER PEER by size + capability (sendRouteFor). ≤1GB → stream now (lazy slice → the
      // peer's OPFS/in-RAM sink). >1GB → only a download-capable peer (xfer.dl): send a PULL OFFER and hold
      // the bytes until its xaccept (it picks a disk location first). A peer that can't take this size is
      // skipped (warned). One xid is shared across peers.
      const mesh = meshRef.current
      if (!mesh || !sendAllowed(to)) return
      if (file.size > SINK_MAX_BYTES.fsa) {
        // eslint-disable-next-line no-console
        console.warn(`[kibitz] file exceeds the ${Math.round(SINK_MAX_BYTES.fsa / (1024 * 1024 * 1024))}GB transfer cap — not sent`)
        return
      }
      const cap = capForKind(kind)
      if (to && !canPerceive(grantOf(to), cap)) return
      const xid = newXid()
      const others = rosterRef.current.filter((m) => m.id !== voiceIdRef.current)
      const targets = (to ? others.filter((m) => m.id === to) : others).filter((m) => peerSupportsXfer(m.id) && canPerceive(grantOf(m.id), cap))
      let offered = false
      let streamed = false
      let skipped = false
      const progPeers = new Map<string, number>() // pre-register streaming peers at 0 so `done` waits for ALL
      for (const m of targets) {
        const route = sendRouteFor(file.size, { xfer: true, download: peerSupportsXferDl(m.id) })
        const binary = xferV2On() && peerSupportsXferV2(m.id)
        if (route === 'download') {
          // Announce the offer; stream only after the peer accepts (handled in dispatchContent → xaccept).
          offerOutRef.current.set(`${m.id}/${xid}`, { peerId: m.id, file, kind, mime, name, dm: !!to, binary })
          mesh.sendData(m.id, { k: 'xbegin', id: xid, kind, size: file.size, n: chunkCount(file.size), ...(mime ? { mime } : {}), ...(name ? { name } : {}), offer: true as const, ...(to ? { dm: true as const } : {}) })
          offered = true
        } else if (route === 'stream') {
          if (xferResumeOn() && peerSupportsXferResume(m.id)) activeSendRef.current.set(`${m.id}/${xid}`, { peerId: m.id, file, kind, mime, name, dm: !!to, binary })
          progPeers.set(m.id, 0)
          streamed = true
          void sendFileStreamingTo(m.id, xid, kind, file, mime, name, !!to, binary)
        } else {
          skipped = true // >1GB to a peer that can't pull-download → no path
        }
      }
      if (skipped && !offered) {
        // eslint-disable-next-line no-console
        console.warn('[kibitz] file is too large for the recipient(s) to receive (no save-to-disk support) — not sent')
      }
      if (progPeers.size) sendProgRef.current.set(xid, progPeers)
      // Local echo — reference the File directly (disk-backed; no in-RAM copy of a big file). A streamed or
      // offered file shows a LIVE 'active' bar (the sender now tracks real send progress + can cancel); a send
      // with no viable recipient shows 'failed'. The bar fills as chunks land and flips to 'done' when every
      // recipient has the whole file (offered: once accepted + streamed). The sender holds the source File, so
      // it stays viewable via its own object URL throughout.
      chatSeqRef.current += 1
      const id = chatSeqRef.current
      const live = offered || streamed
      const att: Attachment = { xid, kind, mime, name, size: file.size, ...(offered ? {} : { url: URL.createObjectURL(file) }), progress: 0, state: live ? 'active' : 'failed', ...(live ? {} : { reason: 'no one here can receive a file this large' }) }
      setChat((prev) => appendChat(prev, { from: voiceIdRef.current, name: nameRef.current.trim() || 'You', text: '', attachment: att, id, self: true, dm: !!to, to: to ? rosterName(rosterRef.current, to) : undefined }))
    },
    [sendContent, sendAllowed, grantOf, peerSupportsXfer, peerSupportsXferV2, peerSupportsXferDl, sendFileStreamingTo],
  )

  // Cancel a transfer from EITHER side, by xid. Sender: stop the paced send loop(s) + retract any pending
  // offer (each emits/sends an `xcancel`). Receiver: tell the sender to stop, free the partial OPFS temp, drop
  // it. Both sides then paint the local attachment `cancelled`. Idempotent + direction-agnostic, so the one ✕
  // button works whether this peer is sending or receiving. A broadcast send fans out to every peer key.
  const cancelTransfer = useCallback((xid: string) => {
    const mesh = meshRef.current
    const suffix = `/${xid}`
    // (1) Stop any OUTGOING send loop for this xid — the paced loops poll this set and bail with an xcancel.
    sendCancelRef.current.add(xid)
    // (2) Retract not-yet-streamed outgoing PULL OFFER(s) (a broadcast may have offered to several peers).
    for (const k of [...offerOutRef.current.keys()]) {
      if (!k.endsWith(suffix)) continue
      const o = offerOutRef.current.get(k)
      offerOutRef.current.delete(k)
      if (o) mesh?.sendData(o.peerId, { k: 'xcancel', id: xid, ...(o.dm ? { dm: true as const } : {}) })
    }
    // (3) Forget retained resume sources + the send-progress tracker for this xid (no more re-streaming).
    for (const k of [...activeSendRef.current.keys()]) if (k.endsWith(suffix)) activeSendRef.current.delete(k)
    sendProgRef.current.delete(xid)
    // (4) Cancel an INCOMING transfer we're receiving: tell the sender, free the partial OPFS temp, drop it.
    for (const k of [...incomingRef.current.keys()]) {
      if (!k.endsWith(suffix)) continue
      const e = incomingRef.current.get(k)
      incomingRef.current.delete(k)
      mesh?.sendData(k.slice(0, k.lastIndexOf('/')), { k: 'xcancel', id: xid, ...(e?.dm ? { dm: true as const } : {}) })
      if (e?.r instanceof DiskReassembler) void e.r.abort()
    }
    // (5) Decline a pending INCOMING pull-offer (not yet accepted) — a decline IS the receiver's cancel.
    for (const k of [...offerInRef.current.keys()]) {
      if (!k.endsWith(suffix)) continue
      const v = offerInRef.current.get(k)
      offerInRef.current.delete(k)
      if (v) mesh?.sendData(v.from, { k: 'xdecline', id: xid, ...(v.dm ? { dm: true as const } : {}) })
    }
    // (6) Drop any cross-reload partial record + paint the local attachment `cancelled` (sender or receiver).
    const kv = persistKV()
    if (kv && roomSaltRef.current) deletePartial(kv, roomSaltRef.current, xid)
    setChat((prev) =>
      prev.map((it) =>
        it.attachment?.xid === xid && (it.attachment.state === 'active' || it.attachment.state === 'offered')
          ? { ...it, attachment: { ...it.attachment, state: 'cancelled' as const } }
          : it,
      ),
    )
  }, [])

  // Drop a cross-reload partial-transfer record (on complete / fail / cancel) for the current room.
  const forgetPartial = useCallback((xid: string) => {
    const kv = persistKV()
    if (kv && roomSaltRef.current) deletePartial(kv, roomSaltRef.current, xid)
  }, [])

  // Accept an incoming >1GB PULL OFFER: MUST be called from a user gesture (a button click) so the browser
  // lets us open the save picker. We open it (createReceiveSink prefer:'fsa'), and only if the user actually
  // picks a file do we wire the streamed sink + send `xaccept` (which starts the sender). A cancelled picker
  // → `xdecline` (the sender drops it), so no transfer streams to nowhere.
  const acceptTransfer = useCallback(async (xid: string): Promise<void> => {
    const mesh = meshRef.current
    let key: string | undefined
    let entry: { begin: XferBegin; from: string; fromName: string; chatId: number; dm: boolean } | undefined
    for (const [k, v] of offerInRef.current) if (v.begin.id === xid) ((key = k), (entry = v))
    if (!mesh || !key || !entry) return
    const { begin, from, fromName, chatId, dm } = entry
    const tail = dm ? { dm: true as const } : {}
    const sink = await createReceiveSink({ mime: begin.mime || 'application/octet-stream', name: begin.name, prefer: 'fsa' })
    if (sink.kind !== 'fsa') {
      // No real save location (picker cancelled / no FSA) — a >1GB file can't fall back to OPFS, so decline.
      await sink.abort()
      offerInRef.current.delete(key)
      mesh.sendData(from, { k: 'xdecline', id: xid, ...tail })
      setChat((prev) => prev.map((it) => (it.id === chatId && it.attachment ? { ...it, attachment: { ...it.attachment, state: 'failed' } } : it)))
      return
    }
    offerInRef.current.delete(key)
    const dr = new DiskReassembler(begin, Promise.resolve(sink), Date.now())
    incomingRef.current.set(key, { r: dr, chatId, kind: begin.kind, mime: begin.mime, name: begin.name, fromName, dm, hasher: xferHashOn() ? new Sha256() : undefined })
    setChat((prev) => prev.map((it) => (it.id === chatId && it.attachment ? { ...it, attachment: { ...it.attachment, state: 'active' } } : it)))
    mesh.sendData(from, { k: 'xaccept', id: xid, ...tail }) // sender begins streaming now
  }, [])

  const declineTransfer = useCallback((xid: string): void => {
    const mesh = meshRef.current
    for (const [k, v] of offerInRef.current) {
      if (v.begin.id !== xid) continue
      offerInRef.current.delete(k)
      mesh?.sendData(v.from, { k: 'xdecline', id: xid, ...(v.dm ? { dm: true as const } : {}) })
      setChat((prev) => prev.map((it) => (it.id === v.chatId && it.attachment ? { ...it, attachment: { ...it.attachment, state: 'failed' } } : it)))
      return
    }
  }, [])

  // The small content/relay lanes now live in their own modules over the seam (the content-handler registry +
  // the send primitives). The engine just instantiates them and spreads their APIs below; the engine keeps no
  // per-lane state or dispatch branch. Deleting any one line drops that feature from the core.
  const ledger = useRelayLane('ledger', meshBroadcast, meshSendTo, registerContentHandler) // room-state sync transport
  const ctl = useRelayLane('ctl', meshBroadcast, meshSendTo, registerContentHandler) // ephemeral control signals
  // Unified room sync (flag-gated, docs/unified-room-sync.md): fetch content-addressed bytes by hash. Two
  // reserved lanes — 'blob' control (want/have/get) + 'blobdata' chunked bytes — bound to a BlobSync over the
  // blob store. The lanes always exist (cheap, reserved) but nothing sends unless ROOM_SYNC_V2 is on.
  const blobCtl = useRelayLane('blob', meshBroadcast, meshSendTo, registerContentHandler)
  const blobData = useRelayLane('blobdata', meshBroadcast, meshSendTo, registerContentHandler)
  // Destructure the STABLE lane callbacks — useRelayLane returns a fresh object each render, so depending on the
  // lane objects would thrash the bind effect (unbinding BlobSync mid-fetch); the send/sendTo/on funcs are stable.
  const { send: blobCtlSend, sendTo: blobCtlSendTo, on: blobCtlOn } = blobCtl
  const { sendTo: blobDataSendTo, on: blobDataOn } = blobData
  const blobSyncRef = useRef<BlobSync | null>(null)
  useEffect(() => {
    if (!roomSyncV2On() || !inCall) return
    if (!blobStoreRef.current) blobStoreRef.current = new BlobStore(memBlobKV())
    const parts = new Map<string, { got: Map<number, Uint8Array>; n: number; pct?: number }>() // hash → received chunks (+ last-reported %)
    const wire: BlobWire = {
      broadcast: (m) => blobCtlSend(m),
      send: (to, m) => blobCtlSendTo(to, m),
      sendBytes: (to, hash, bytes) => {
        const chunks = splitChunks(bytes)
        void (async () => {
          try {
            for (let i = 0; i < chunks.length; i++) {
              // BACKPRESSURE: wait for the send buffer to drain below the high-water mark before queuing the next
              // chunk. Without it a slow (TURN/relay) link overflows the data channel — send() throws / PeerJS
              // queues unboundedly and chunks are dropped → the receiver stalls at a gap, its want() times out, and
              // the media never gets an object URL (the "video downloaded 100% but stuck" bug). Loopback drains
              // instantly, so headless never hit it. Same throttle the legacy chunked xfer uses (dataBufferedAmount).
              let guard = 0
              while ((meshRef.current?.dataBufferedAmount(to) ?? 0) > XFER_HIGH_WATER && guard++ < 2000) await xferDelay(XFER_POLL_MS)
              blobDataSendTo(to, { hash, i, n: chunks.length, b64: bytesToBase64(chunks[i]) })
            }
          } catch {
            /* peer vanished mid-stream → the requester's want() times out and re-wants (content-addressed, idempotent) */
          }
        })()
      },
      onMessage: (cb) => blobCtlOn((from, m) => cb(from, m as BlobMsg)),
      onBytes: (cb) =>
        blobDataOn((from, m) => {
          const d = m as { hash?: unknown; i?: unknown; n?: unknown; b64?: unknown }
          if (typeof d?.hash !== 'string' || typeof d.i !== 'number' || typeof d.n !== 'number' || typeof d.b64 !== 'string') return
          let e = parts.get(d.hash)
          if (!e) {
            e = { got: new Map(), n: d.n }
            parts.set(d.hash, e)
          }
          try {
            e.got.set(d.i, base64ToBytes(d.b64))
          } catch {
            return
          }
          blobSyncRef.current?.noteProgress(d.hash) // keep the fetch's stall clock fresh (a chunk landed) so a
          // slow-but-alive transfer isn't re-driven; only a genuine stall (channel blip, no resume) re-wants.
          // Surface REAL fetch progress on the waiting media bubble so its bar fills 0→100% as the bytes arrive,
          // instead of sitting at a placeholder 100% (looks "stuck") until the whole blob lands. Throttled to
          // whole-percent steps (one setChat per 1%, not per chunk), and only touches the not-yet-fetched item(s).
          if (e.got.size < e.n) {
            const pct = Math.floor((e.got.size / e.n) * 100)
            if (pct !== e.pct) {
              e.pct = pct
              const h = d.hash
              const frac = e.got.size / e.n
              setChat((prev) => prev.map((x) => (x.attachment && x.attachment.hash === h && !x.attachment.url ? { ...x, attachment: { ...x.attachment, progress: frac } } : x)))
            }
            return
          }
          parts.delete(d.hash)
          const ordered: Uint8Array[] = []
          for (let i = 0; i < e.n; i++) {
            const c = e.got.get(i)
            if (!c) return // a gap — drop (the requester times out and can re-want)
            ordered.push(c)
          }
          const out = new Uint8Array(ordered.reduce((s, c) => s + c.length, 0))
          let off = 0
          for (const c of ordered) {
            out.set(c, off)
            off += c.length
          }
          cb(from, d.hash, out)
        }),
    }
    const sync = new BlobSync(blobStoreRef.current, wire)
    blobSyncRef.current = sync
    return () => {
      sync.close()
      blobSyncRef.current = null
    }
  }, [inCall, blobCtlSend, blobCtlSendTo, blobCtlOn, blobDataSendTo, blobDataOn])
  /** Fetch content-addressed bytes by hash — from the local store, else from a holding peer (unified sync). */
  const fetchBlob = useCallback((hash: string): Promise<Uint8Array | null> => {
    // Generous timeout: a large video over a real relay takes far longer than 15s even once backpressure keeps
    // the transfer intact — too short a cap gives up mid-stream and the media stays stuck with no object URL. The
    // want() re-broadcast (1.5s) still heals a not-yet-open channel; once a holder is picked we wait for the bytes.
    if (blobSyncRef.current) return blobSyncRef.current.want(hash, { timeoutMs: 120000, stallMs: 10000 })
    return blobStoreRef.current ? blobStoreRef.current.get(hash) : Promise.resolve(null)
  }, [])

  // ── Unified room sync (flag-gated, docs/unified-room-sync.md, phase 3.3/3.4): the chat union as a roomLedger,
  // converged over its OWN channel ('chatledger', separate from the resumable-hint 'ledger' so they never mix).
  // Coexists with the legacy re-broadcast paths (dedup by mid → no visible dup); nothing removed until a
  // 2-device gate. Inert unless ROOM_SYNC_V2 is on.
  const chatLedgerLane = useRelayLane('chatledger', meshBroadcast, meshSendTo, registerContentHandler)
  const { send: clSend, on: clOn } = chatLedgerLane
  const chatLedgerRef = useRef<RoomLedger | null>(null)
  const fetchedBlobsRef = useRef(new Set<string>())
  // Ledger → buffer: add each ledger line not already held (dedup by key=mid); media fetches its bytes by hash
  // and patches the object URL in when they land. Idempotent (existing keys skipped), so it can't loop with the
  // mirror below.
  const reconstructChatFromLedger = useCallback(() => {
    const led = chatLedgerRef.current
    if (!led) return
    const lines = ledgerToChat(led.snapshot(), Date.now())
    // Pull bytes for a media ref we don't hold — but ONE transfer per peer: DEFER so the DIRECT chunked push (to
    // peers present at share time) can claim the line first. At fire time skip if the direct xfer owns this mid
    // (recvMediaMids) or we already have the bytes (our own upload, or a path that just finished) — so a present
    // peer rides the direct push and only a LATE JOINER actually fetches by hash. The url is patched via a
    // FUNCTIONAL setChat, so it lands on whatever item currently carries the hash — including one the legacy path
    // finalized (never reverting it).
    for (const { key, value } of lines) {
      if (value.t !== 'media' || !value.hash || fetchedBlobsRef.current.has(value.hash)) continue
      fetchedBlobsRef.current.add(value.hash)
      const h = value.hash
      const mime = value.mime
      const mid = key
      setTimeout(() => {
        if (recvMediaMidsRef.current.has(mid)) return // the direct xfer owns/owned this mid → don't also fetch it
        if (chatRef.current.some((x) => x.mid === mid && x.attachment?.url)) return // already have the bytes
        void fetchBlob(h).then((bytes) => {
          if (!bytes) {
            fetchedBlobsRef.current.delete(h) // no holder answered → let a later attempt retry
            return
          }
          const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }))
          setChat((prev) => prev.map((x) => (x.attachment && x.attachment.hash === h && !x.attachment.url ? { ...x, attachment: { ...x.attachment, url, progress: 1 } } : x)))
        })
      }, BLOB_FETCH_GRACE_MS)
    }
    // Merge the union into the LATEST chat state via a FUNCTIONAL updater (prev) — NOT the lagging chatRef.current
    // + a value setChat. That combination REVERTED a line the legacy path had just finalized: a peer receives the
    // same media BOTH ways (direct chunked xfer + the ledger/blob), and if a ledger update fires reconstruct in the
    // window after the legacy `xend` set {url,done} but before chatRef synced, rebuilding from the stale ref snapped
    // the item back to active/no-url → the "stuck at 100% with an ✕, no player" bug. Deduping on `prev` also means a
    // line the legacy path already delivered (now done) is skipped here, never re-added.
    setChat((prev) => {
      const held = new Set(prev.map((x) => x.mid || x.widget?.id || x.attachment?.xid).filter(Boolean) as string[])
      let next = prev
      for (const { key, value } of lines) {
        if (held.has(key)) continue
        chatSeqRef.current += 1
        if (value.t === 'widget') {
          next = recordWidget(next, { from: value.from, name: value.name, id: value.wid, kind: value.kind, data: value.data, ts: value.ts }, chatSeqRef.current)
        } else if (value.t === 'text') {
          next = mergeChat(next, { from: value.from, name: value.name, text: value.text, id: chatSeqRef.current, self: false, mid: key, ts: value.ts })
        } else {
          // progress starts at 0 when bytes are still to FETCH (the bar fills as they arrive), 1 when self-contained
          // (no hash → nothing to pull). state stays 'done'; the media renders once its object URL lands.
          const att: Attachment = { xid: key, kind: value.media, mime: value.mime, name: value.fileName, size: value.size, progress: value.hash ? 0 : 1, state: 'done', ...(value.hash ? { hash: value.hash } : {}) }
          next = mergeChat(next, { from: value.from, name: value.name, text: '', attachment: att, id: chatSeqRef.current, self: false, mid: key, ts: value.ts })
        }
      }
      if (next !== prev) chatRef.current = next
      return next
    })
  }, [fetchBlob])
  // Bind the chat ledger + its sync when in a call: seed with what we hold, pull the union, reconstruct on change.
  useEffect(() => {
    if (!roomSyncV2On() || !inCall) return
    const led = new RoomLedger()
    chatLedgerRef.current = led
    const wire: LedgerWire = { broadcast: (m) => clSend(m), onMessage: (cb) => clOn((from, m) => cb(from, m as LedgerMsg)) }
    const sync = new LedgerSync(led, wire)
    const offLed = led.on(() => reconstructChatFromLedger())
    led.merge(chatToLedger(chatRef.current, { now: Date.now() })) // seed our current chat (pushes as updates)
    sync.requestSync() // pull the union from whoever's already here
    // The once-at-bind request can be LOST: an existing peer is the WebRTC initiator, so its data channel to a
    // joiner opens a beat BEFORE the joiner's channel back opens — the joiner's `request` then broadcasts into a
    // not-yet-open link and no `state` reply ever comes (observed: a late joiner never received a >30MB media
    // entry, only the legacy-path text). Every legacy sync heals via the onRosterChange seam, but a newcomer PULL
    // is the fragile direction. So on every roster change we also PUSH our full snapshot (op:'state') — the
    // existing peer's link IS open, so its push lands — alongside re-pulling. Small (chat metadata; bytes ride the
    // blob store) and merge-idempotent (applied under applyingRemote → no echo), so it can't storm.
    const offRoster = onRosterChange(() => {
      sync.requestSync()
      clSend({ v: 1, op: 'state', state: led.snapshot() })
    })
    return () => {
      offRoster()
      offLed()
      sync.close()
      chatLedgerRef.current = null
    }
  }, [inCall, clSend, clOn, reconstructChatFromLedger, onRosterChange])
  // Buffer → ledger: mirror the chat on every change; new lines become owned keys (pushed via LedgerSync),
  // already-present lines merge to a no-op (so a reconstructed remote line doesn't echo back out).
  useEffect(() => {
    if (!roomSyncV2On() || !chatLedgerRef.current) return
    chatLedgerRef.current.merge(chatToLedger(chatRef.current, { now: Date.now() }))
  }, [chat])

  const pay = usePay(broadcastContent, meshSendTo, sendAllowed, registerContentHandler)
  const app = useApp(broadcastContent, meshSendTo, sendAllowed, registerContentHandler)
  const ink = useInk(broadcastContent, sendAllowed, registerContentHandler, nameRef, voiceIdRef)

  // Schema discovery (the room capability directory — agent/app self-description) is its own module over the seam:
  // it owns its maps, registers a gated receive handler, and re-publishes own schemas to late joiners via
  // onRosterChange. The engine just instantiates it + spreads its API; clearPeers() is called on a call reset.
  const schema = useSchema(broadcastContent, sendAllowed, registerContentHandler, onRosterChange, voiceIdRef)

  // Bounded interactive widgets are their own module over the seam. A widget's durable, chronological home is the
  // CHAT log (still in the engine), so the module reaches it through two stable callbacks: recordWidgetInChat
  // refreshes-or-appends the widget's single chat line (keyed by id, via the pure recordWidget); dropWidgetFromChat
  // removes it (the owner retraction + the local Dismiss). newXid is the engine's id generator (shared w/ transfer).
  const recordWidgetInChat = useCallback((w: { from: string; name: string; id: string; kind: string; data: unknown; ts?: number }) => {
    chatSeqRef.current += 1
    setChat((prev) => recordWidget(prev, w, chatSeqRef.current)) // recordWidget inserts ordered by w.ts (refresh-in-place by widget id)
  }, [])
  const dropWidgetFromChat = useCallback((id: string) => {
    setChat((prev) => prev.filter((it) => it.widget?.id !== id))
  }, [])
  const widgets = useWidgets(broadcastContent, sendAllowed, registerContentHandler, onRosterChange, newXid, recordWidgetInChat, dropWidgetFromChat, (id) => presentRosterNameOf(rosterRef.current, id))

  // PERSISTENT-ROOM PUBLIC-CHAT reconciliation (the in-call union sync) over the same seam: on each roster change we
  // re-broadcast the WHOLE public text chat WE HOLD (the buffer, via chatRef) — every line carrying its OWN original
  // from/name — not just lines we authored. Every peer merges by mid (dedup) + ts (order) via the engine's k:'chat'
  // NOTE (2026-07-02): the LATE-JOINER CATCH-UP family (useChatSync / useMediaSync / useWidgetSync — re-broadcast
  // held text/media/widgets to a new peer on every roster change) was REMOVED. It was flaky (a small media synced
  // to late joiners while the >30MB path didn't; the reconciliation added its own load) and is being reworked. A
  // peer now only receives what's shared AFTER it joins — live delivery via the direct content handlers is
  // untouched. Schema/capability discovery (useSchema) and the owner's own live interactive-widget state (useWidgets)
  // still ride onRosterChange; the agent's explicit durable ledger (export/importLedger) is unaffected.

  // Min-version kill-switch: once at boot, ask the deployment's floor whether THIS build is
  // retired. Fail-open (a blip never blocks); if retired, the engine refuses to join (below).
  useEffect(() => {
    if (previewRef.current) return // the landing demo never dials — nothing to retire
    let alive = true
    void checkRetired(APP_VERSION, MIN_VERSION_URL).then((r) => {
      if (!alive || !r.retired) return
      retiredRef.current = r
      setRetired(r)
      setError(r.message || 'This version of Kibitz is out of date and has been retired. Reload the page.')
    })
    return () => {
      alive = false
    }
  }, [])

  // FAST RESUME: the instant our data link to `from` (re)opens after a self-heal re-dial, ask it to
  // re-stream any interrupted incoming transfer from our position — so a transient drop recovers in ~a
  // second instead of waiting the full STALL_MS reaper below. Idempotent (the sender drops chunks below our
  // position); the time-based reaper stays the backstop (and owns the give-up budget). No-op on the first
  // connect (no transfer in flight yet) and for non-resumable transfers.
  const nudgeResumeFrom = useCallback((from: string) => {
    if (!xferResumeOn()) return
    if (!readEngineMeta(rosterRef.current.find((x) => x.id === from)?.meta).features?.includes('xfer.resume')) return
    for (const [key, e] of incomingRef.current) {
      if (!key.startsWith(`${from}/`)) continue
      if (!(e.r instanceof DiskReassembler) || e.r.complete) continue
      const xid = key.slice(from.length + 1)
      meshRef.current?.sendData(from, { k: 'xresume', id: xid, have: e.r.received, ...(e.dm ? { dm: true as const } : {}) })
    }
  }, [])

  // Reap stalled INCOMING transfers — a peer that vanished mid-send leaves a partial reassembler. After
  // STALL_MS of silence: for a RESUMABLE streamed transfer (disk-tier, both sides support resume, the peer is
  // still in the roster), nudge the sender with `xresume {have}` to re-drive from our position — up to a few
  // tries — instead of failing; otherwise (or once tries are spent) drop it + mark the line failed.
  const XFER_RESUME_TRIES = 3
  useEffect(() => {
    const t = setInterval(() => {
      const now = Date.now()
      for (const [key, e] of incomingRef.current) {
        if (now - e.r.lastAt <= XFER.STALL_MS) continue
        const slash = key.indexOf('/')
        const from = key.slice(0, slash)
        const xid = key.slice(slash + 1)
        const canResume =
          xferResumeOn() &&
          e.r instanceof DiskReassembler &&
          !e.r.complete &&
          !!readEngineMeta(rosterRef.current.find((x) => x.id === from)?.meta).features?.includes('xfer.resume') &&
          (e.resumeTries ?? 0) < XFER_RESUME_TRIES
        if (canResume) {
          e.resumeTries = (e.resumeTries ?? 0) + 1
          e.r.lastAt = now // give the resume another STALL_MS window before the next nudge / giving up
          meshRef.current?.sendData(from, { k: 'xresume', id: xid, have: (e.r as DiskReassembler).received, ...(e.dm ? { dm: true as const } : {}) })
          continue
        }
        incomingRef.current.delete(key)
        if (e.mid) recvMediaMidsRef.current.delete(e.mid) // stalled-out media may be re-replayed → unclaim its mid
        if (e.r instanceof DiskReassembler) void e.r.abort() // free the partial OPFS/disk temp
        forgetPartial(xid)
        if (e.chatId) setChat((prev) => prev.map((it) => (it.id === e.chatId && it.attachment ? { ...it, attachment: { ...it.attachment, state: 'failed' } } : it)))
      }
    }, 5000)
    return () => clearInterval(t)
  }, [])

  // CROSS-RELOAD RESUME (docs/large-transfer.md): on (re)entering a salted room, look for OPFS receives this
  // browser left unfinished in a prior session. For each: truncate to the last whole chunk, reopen for append,
  // and either finalize (already complete on disk) or re-register a DiskReassembler at that position and ask
  // the sender (if still present) to re-stream the rest (`xresume`); the stall reaper retries otherwise. The
  // sender matches by xid across our NEW peer id. OPFS-only (FSA's user-file can't be reopened to append).
  const restoredRef = useRef(false)
  useEffect(() => {
    const kv = persistKV()
    const room = roomSalt
    if (restoredRef.current || !kv || !room || !xferResumeOn() || !detectSinkCaps().opfs) return
    restoredRef.current = true
    void (async () => {
      for (const rec of loadPartials(kv, room)) {
        const re = await reopenOpfsSink(rec.sinkName, XFER.CHUNK_BYTES).catch(() => null)
        if (!re) {
          deletePartial(kv, room, rec.xid)
          continue
        }
        chatSeqRef.current += 1
        const chatId = chatSeqRef.current
        if (re.have >= rec.n) {
          // The whole file is already on disk (we crashed right at the end) → finalize it, no re-stream.
          try {
            const url = URL.createObjectURL(await re.sink.finish())
            if (re.sink.cleanup) xferCleanupRef.current.set(url, () => re.sink.cleanup!())
            const att: Attachment = { xid: rec.xid, kind: rec.kind, mime: rec.mime || 'application/octet-stream', name: rec.name, size: rec.size, url, progress: 1, state: 'done' }
            setChat((prev) => appendChat(prev, { from: rec.from, name: rec.fromName, text: '', attachment: att, id: chatId, self: false, dm: rec.dm }))
          } catch {
            await re.sink.abort()
          }
          deletePartial(kv, room, rec.xid)
          continue
        }
        const att: Attachment = { xid: rec.xid, kind: rec.kind, mime: rec.mime || 'application/octet-stream', name: rec.name, size: rec.size, progress: rec.n ? re.have / rec.n : 0, state: 'active' }
        setChat((prev) => appendChat(prev, { from: rec.from, name: rec.fromName, text: '', attachment: att, id: chatId, self: false, dm: rec.dm }))
        const dr = new DiskReassembler({ n: rec.n, size: rec.size }, Promise.resolve(re.sink), Date.now(), { at: re.have, bytes: re.bytes })
        // No hasher on a resumed transfer (the sender can't hash from a mid-offset → no hash to verify).
        incomingRef.current.set(`${rec.from}/${rec.xid}`, { r: dr, chatId, kind: rec.kind, mime: rec.mime, name: rec.name, fromName: rec.fromName, dm: rec.dm })
        if (rosterRef.current.find((x) => x.id === rec.from)) meshRef.current?.sendData(rec.from, { k: 'xresume', id: rec.xid, have: re.have, ...(rec.dm ? { dm: true as const } : {}) })
        // (else: the sender isn't here yet — the stall reaper will retry xresume once it stalls.)
      }
    })()
  }, [roomSalt])

  // The host can reset the room → clear our ephemeral chat scrollback. The buffer IS the reconciliation re-broadcast
  // source, so clearing it also stops the next roster-change from re-broadcasting the wiped history back in. Also drop
  // the media-mid dedup set so a post-reset re-share of the same image isn't silently skipped.
  useEffect(() => {
    room?.link.onReset?.(() => {
      recvMediaMidsRef.current.clear()
      setChat([])
    })
  }, [room])

  const getSafetyCode = useCallback(
    (participantId: string): Promise<SafetyInfo | null> =>
      meshRef.current?.safetyCodeFor(participantId) ?? Promise.resolve(null),
    [],
  )

  const getConnectionInfo = useCallback(
    (participantId: string): Promise<ConnInfo | null> =>
      meshRef.current?.connectionInfoFor(participantId) ?? Promise.resolve(null),
    [],
  )

  // --- Identity (L3) — all no-ops unless idConfig is set ---------------------------
  const selfIdentityRef = useRef<VerifiedIdentity | null>(null)

  // Generate the pinned cert ONCE; join() and sign-in share it whichever runs first,
  // so the token's nonce (hash of this cert's fingerprint) matches the cert every peer
  // actually handshakes with.
  const ensurePinnedCert = useCallback(async (): Promise<RTCCertificate | null> => {
    if (pinnedCertRef.current) return pinnedCertRef.current
    // An AGENT (a signing key was provided) proves its committed key with a CERT-BOUND assertion,
    // so it must sign over the Widget-pinned SHARED cert — the one ALSO pinned on the presence peer,
    // which is exactly what the authority reads off our handshake. The driver presents the key
    // BEFORE join (so a gated room admits us on the first announce), which can run before that cert
    // has propagated; WAIT for it rather than mint our own throwaway cert (whose fingerprint the
    // authority never sees → "not cert-bound to this connection"). Fail-OPEN to a retry, never to a
    // wrong cert: if it still hasn't landed, return null so the next assertion refresh tries again —
    // poisoning pinnedCertRef with an own cert here would strand the agent unverifiable forever.
    if (agentSignKeyRef.current && !sharedCertRef.current) {
      for (let i = 0; !sharedCertRef.current && !pinnedCertRef.current && i < 100; i++) {
        await new Promise((r) => setTimeout(r, 100))
      }
      if (pinnedCertRef.current) return pinnedCertRef.current
      if (!sharedCertRef.current) return null
    }
    // Prefer the Widget-pinned shared cert (also on the presence peer → one token gates
    // both the authority and peers). Only generate our own when there isn't one.
    if (sharedCertRef.current) {
      pinnedCertRef.current = sharedCertRef.current
      selfFpRef.current = certFingerprint(sharedCertRef.current) ?? ''
      return sharedCertRef.current
    }
    // Share ONE in-flight generation between concurrent callers (join + sign-in in the
    // same tick) so they don't each mint a different cert — which would desync the
    // nonce (signed against one fingerprint) from the cert the mesh actually presents.
    if (!pinnedCertPromiseRef.current) {
      pinnedCertPromiseRef.current = generatePinnedCert().then((cert) => {
        if (cert) {
          pinnedCertRef.current = cert
          selfFpRef.current = certFingerprint(cert) ?? ''
        }
        pinnedCertPromiseRef.current = null
        return cert
      })
    }
    return pinnedCertPromiseRef.current
  }, [])

  // Hand our signed token to any roster peer we haven't yet (sign-in + new joiners).
  const shareSelfToken = useCallback(() => {
    const jwt = selfJwtRef.current
    const mesh = meshRef.current
    if (!jwt || !mesh) return
    for (const m of rosterRef.current) {
      if (m.id === voiceIdRef.current || sentTokenToRef.current.has(m.id)) continue
      mesh.sendData(m.id, { k: 'idtoken', jwt } satisfies ContentMsg)
      sentTokenToRef.current.add(m.id)
    }
  }, [])

  // Verify OUR OWN freshly-signed token exactly as peers will (signature + cert binding) — via
  // verifyPeerMulti when accepted providers are configured (Google/email-code), else the single
  // Google config. Best-effort: if keys are unreachable we skip the local badge but still
  // broadcast the token, so peers verify it once they can reach the provider's keys.
  const selfVerify = useCallback(async (jwt: string, certFp: string): Promise<VerifiedIdentity | null> => {
    const now = Math.floor(Date.now() / 1000)
    const providers = acceptProvidersRef.current
    if (providers && providers.length) {
      const v = await verifyPeerMulti({ jwt, remoteFp: certFp, providers, now, salt: roomSaltRef.current }).catch(() => null)
      return v && v.ok ? v.identity : null
    }
    const cfg = idConfigRef.current
    const resolver = jwksRef.current
    if (!cfg || !resolver) return null
    const jwks = await resolver.resolve(discoveryIssuerFor(cfg))
    const v = await verifyPeerIdentity({ jwt, remoteFp: certFp, audience: cfg.clientId, issuer: issuersFor(cfg), jwks, now, salt: roomSaltRef.current })
    return v.ok ? v.identity : null
  }, [])

  // Adopt a freshly-obtained token — from our own in-page sign-in OR a token minted by an
  // external sign-in surface (e.g. the extension's kibitz.chat verify popup, which signs with
  // the nonce from `identityNonce()`). Verify it locally as peers will, hand it to the room
  // gate, and deliver it to the roster. Returns true if adopted (broadcast), even when the
  // local badge couldn't be computed (keys unreachable). Stale-guarded against a cert that
  // rotated/teardown while a late dialog resolved.
  const ingestSelfToken = useCallback(
    async (jwt: string, certFp: string): Promise<boolean> => {
      if (selfFpRef.current !== certFp) return false
      selfJwtRef.current = jwt
      // Hand the token to the room so it rides our knock/announce — an identity-gated authority
      // verifies it (against our presence cert) before admitting us.
      roomRef.current?.link.setIdentityToken?.(jwt)
      try {
        const identity = await selfVerify(jwt, certFp)
        if (identity && selfFpRef.current === certFp) {
          selfIdentityRef.current = identity
          setSelfIdentity(identity)
        }
      } catch {
        /* keys unreachable — peers still verify the broadcast token */
      }
      if (selfFpRef.current !== certFp) return false // torn down during verify
      sentTokenToRef.current.clear() // (re)deliver to everyone now we have a token
      shareSelfToken()
      return true
    },
    [shareSelfToken, selfVerify],
  )

  const signInIdentity = useCallback(
    async (container: HTMLElement, method: 'google' | 'email' = 'google'): Promise<boolean> => {
      // Pick the local sign-in provider: Google (built from idConfig) or email-code (our backend).
      const provider =
        method === 'email'
          ? emailCodeProvider({ room: roomSaltRef.current ?? '', grant: getGrant() ?? undefined })
          : providerRef.current
      if (!provider) return false
      await ensurePinnedCert()
      const certFp = selfFpRef.current
      if (!certFp) {
        setError("Couldn't prepare a secure identity on this device.")
        return false
      }
      const nonce = await nonceForFingerprint(certFp, roomSaltRef.current)
      const res = await provider.signIn({ nonce, container })
      if (!res?.jwt) return false
      return ingestSelfToken(res.jwt, certFp)
    },
    [ensurePinnedCert, ingestSelfToken],
  )

  // The cert-bound nonce an EXTERNAL sign-in surface must echo so the token it mints binds to
  // THIS connection (the extension's kibitz.chat popup reads it, passes it to GIS/email, and
  // returns the token to `provideIdentityToken`). Null until our cert is ready. Same value
  // signInIdentity computes internally — exposed so signer and verifier can be different pages.
  const identityNonce = useCallback(async (): Promise<string | null> => {
    await ensurePinnedCert()
    const certFp = selfFpRef.current
    if (!certFp) return null
    return nonceForFingerprint(certFp, roomSaltRef.current)
  }, [ensurePinnedCert])

  // Adopt a cert-bound token obtained out-of-page (signed against `identityNonce()`), exactly as
  // an in-page sign-in would. Lets an embedder run the OIDC/email flow on a real https origin
  // (where GIS + our backend work) and hand the result back to the headless engine.
  const provideIdentityToken = useCallback(
    async (jwt: string): Promise<boolean> => {
      if (!jwt || jwt.length > JWT_MAX) return false
      await ensurePinnedCert()
      const certFp = selfFpRef.current
      if (!certFp) return false
      return ingestSelfToken(jwt, certFp)
    },
    [ensurePinnedCert, ingestSelfToken],
  )

  // AI-AGENT room entry: sign a fresh cert-bound assertion over (room, our DTLS fingerprint)
  // and hand it to the room so it rides our announce — the authority verifies it against the
  // room's allow-list before admitting us. `roomSalt` is the normalized room id, which equals
  // the manifest's `room`, so the assertion binds to the same room the allow-list was signed for.
  const refreshAgentAssertion = useCallback(async (): Promise<void> => {
    const key = agentSignKeyRef.current
    if (!key) return
    // The assertion's room MUST equal the manifest's room (== roomSalt). Signing with '' would
    // bind to no room and always be rejected — so wait for the salt rather than emit a dud.
    const room = roomSaltRef.current
    if (!room) return
    await ensurePinnedCert()
    const fp = selfFpRef.current
    if (!fp) return
    const assertion = await signAgentAssertion(key, { room, fp, now: Math.floor(Date.now() / 1000) })
    roomRef.current?.link.setAgentAssertion?.(assertion)
  }, [ensurePinnedCert])

  // Mount AS an agent: adopt the agent's own private signing key (a JWK the operator holds),
  // present a cert-bound assertion now, and keep it fresh on a timer (under the assertion's
  // freshness window) so a reconnect — which the authority re-verifies — never goes stale.
  const provideAgentKey = useCallback(
    async (privateKeyJwk: JsonWebKey): Promise<boolean> => {
      try {
        agentSignKeyRef.current = await importAgentPrivateKey(privateKeyJwk)
      } catch {
        return false
      }
      // Replace any prior timer BEFORE the await, so a throwing refresh can't strand the old one.
      if (agentRefreshRef.current) clearInterval(agentRefreshRef.current)
      agentRefreshRef.current = setInterval(() => void refreshAgentAssertion(), 4 * 60 * 1000)
      await refreshAgentAssertion()
      return true
    },
    [refreshAgentAssertion],
  )
  // Stop the re-sign timer when the call unmounts (no leaked interval).
  useEffect(() => () => void (agentRefreshRef.current && clearInterval(agentRefreshRef.current)), [])

  // Mount AS a paid agent: forward the latest network-access credit credential (opaque to us — the
  // operator's runner fetches it from a trusted issuer and re-supplies it ~every minute) to the room
  // so it rides our announce. The authority verifies it and keeps admitting us while it's fresh.
  const provideAgentCredit = useCallback((credential: string): void => {
    roomRef.current?.link.setAgentCredit?.(credential)
  }, [])

  // HOST admin: after claimHost unseals the link's host private key, hold it so we can sign cert-bound
  // moderation commands the coordinator verifies against the link-committed host PUBLIC key.
  const hostPrivRef = useRef<CryptoKey | null>(null)
  const claimHost = useCallback(
    async (password: string, sealedBlob: string): Promise<boolean> => {
      const jwk = await unsealHostKey(sealedBlob, password)
      if (!jwk) return false // wrong password / tampered blob
      let priv: CryptoKey
      try {
        priv = await importHostPrivateKey(jwk)
      } catch {
        return false
      }
      const room = roomSaltRef.current
      if (!room) return false
      await ensurePinnedCert()
      const fp = selfFpRef.current
      if (!fp) return false
      hostPrivRef.current = priv
      const token = await signHostCommand(priv, { room, fp, op: 'claim', now: Math.floor(Date.now() / 1000) })
      roomRef.current?.link.sendModCommand?.(token)
      return true
    },
    [ensurePinnedCert],
  )
  const hostModerate = useCallback(
    async (op: HostOp, target?: string): Promise<boolean> => {
      const priv = hostPrivRef.current
      if (priv) {
        // PASSWORD tier: sign a cert-bound command the coordinator verifies (works from any seat).
        const room = roomSaltRef.current
        if (!room) return false
        await ensurePinnedCert()
        const fp = selfFpRef.current
        if (!fp) return false
        const token = await signHostCommand(priv, { room, fp, op, ...(target ? { target } : {}), now: Math.floor(Date.now() / 1000) })
        roomRef.current?.link.sendModCommand?.(token)
        return true
      }
      // SOFT (name) tier: no key to sign with — drive the authority methods directly. These are no-ops
      // unless we're the coordinator, which scopes soft-host moderation to "the host IS the coordinator"
      // (the creator-stays flow). claim is implicit (by name), so it has no command here.
      const r = roomRef.current
      if (!r) return false
      switch (op) {
        case 'lobbyon': r.setLobby?.(true); break
        case 'lobbyoff': r.setLobby?.(false); break
        case 'lock': r.setLocked?.(true); break
        case 'unlock': r.setLocked?.(false); break
        case 'reset': r.resetRoom?.(); break
        case 'kick': if (target) r.remove?.(target); break
        case 'admit': if (target) r.admit?.(target); break
        case 'deny': if (target) r.deny?.(target); break
        case 'claim': break
      }
      return true
    },
    [ensurePinnedCert],
  )
  // SOFT host claim: adopt the committed host name as our display name and re-announce, so the authority
  // recognizes us as the host (name match). nameRef is set directly for a timing-safe announce; the Widget
  // also setName(hostName) to keep its own state + localStorage in sync.
  const claimHostByName = useCallback(
    (hostName: string) => {
      nameRef.current = hostName
      announceSelf(true)
    },
    [announceSelf],
  )
  // OIDC host: when WE'RE the authority and have verified a member proved the committed host email, mark
  // them the host. No-op on a participant / non-OIDC room (the room gates it). The Widget calls this from
  // an effect once getIdentity/selfIdentity resolves the matching email.
  const declareHost = useCallback((memberId: string) => {
    roomRef.current?.declareHost?.(memberId)
  }, [])

  // Verify a peer's cert-bound token, peer-to-peer. Memoised per (peer, jwt, cert) so
  // the UI can poll cheaply; null until they've sent a token AND we're connected.
  const getIdentity = useCallback(async (participantId: string): Promise<VerifiedIdentity | null> => {
    const cfg = idConfigRef.current
    const providers = acceptProvidersRef.current
    if (!cfg && !(providers && providers.length)) return null
    if (participantId === voiceIdRef.current) return selfIdentityRef.current
    const jwt = idTokensRef.current.get(participantId)
    if (!jwt) return null
    const fp = (await meshRef.current?.safetyCodeFor(participantId))?.remoteFp
    if (!fp) return null // connection not ready — the poll will retry
    const cached = idCacheRef.current.get(participantId)
    if (cached && cached.jwt === jwt && cached.fp === fp) return cached.id
    let id: VerifiedIdentity | null = null
    if (providers && providers.length) {
      // Multi-provider: route the token by its issuer to the right provider (Google / email-code).
      const r = await verifyPeerMulti({ jwt, remoteFp: fp, providers, now: Math.floor(Date.now() / 1000), salt: roomSaltRef.current }).catch(() => null)
      id = r && r.ok ? r.identity : null
    } else if (cfg) {
      // Single-provider (Google) back-compat path, with one JWKS-rotation retry.
      const resolver = jwksRef.current
      if (!resolver) return null
      const discovery = discoveryIssuerFor(cfg)
      const run = async () =>
        verifyPeerIdentity({
          jwt,
          remoteFp: fp,
          audience: cfg.clientId,
          issuer: issuersFor(cfg),
          jwks: await resolver.resolve(discovery),
          now: Math.floor(Date.now() / 1000),
          salt: roomSaltRef.current,
        })
      let result = await run().catch(() => null)
      if (result && !result.ok && /kid|signature/.test(result.reason)) {
        resolver.invalidate(discovery)
        result = await run().catch(() => null)
      }
      id = result && result.ok ? result.identity : null
    }
    idCacheRef.current.set(participantId, { jwt, fp, id })
    capMap(idCacheRef.current, IDTOKEN_CAP)
    return id
  }, [])

  // Track the roster; while in the call, reconcile the mesh to match it.
  useEffect(() => {
    if (!room) return
    room.link.onRoster((members) => {
      // rosterHold (experimental, ?rhold=1): a broker flap can broadcast a roster that DROPS a peer we still have a
      // live P2P link to → "alone" on a working connection. Union those peers back in (with their last-known meta)
      // so they stay VISIBLE while their mesh heartbeat is fresh. Default-off ⇒ `shown` === `members`. The
      // protocol-gate / admission / mesh.setRoster below deliberately keep using `members` (the authority truth) —
      // the mesh keeps the held peer's link alive on its own (its heartbeat-gated drop grace).
      let shown = members
      if (rosterHoldOn() && meshRef.current) {
        const have = new Set(members.map((m) => m.id))
        const held = meshRef.current
          .liveMeshPeers()
          .filter((id) => id !== voiceIdRef.current && !have.has(id))
          .map((id) => lastMemberRef.current.get(id))
          .filter((m): m is CallMember => !!m)
        if (held.length) shown = [...members, ...held]
      }
      for (const m of members) lastMemberRef.current.set(m.id, m) // cache current meta for a future hold
      rosterRef.current = shown
      setRoster(shown) // UI: the FULL roster — the self-check (above) bounces an HONEST over-cap joiner nicely
      // Wire-protocol compatibility gate (core/buildGate): if a peer is on a STRICTLY HIGHER protocol than us, we
      // can't speak its wire format. ROUTINE deploys keep the SAME protocol, so this NEVER fires for them — a normal
      // deploy no longer reloads anyone mid-call (the old gate reloaded on every newer BUILD, which kicked live
      // calls; that was the "kicked: not the latest version" bug). ONLY a deliberate protocol bump trips it, and even
      // then we DON'T auto-reload (that yanks a live call) — we surface a non-disruptive "refresh when ready" prompt
      // (the kw-retired-reload button) and let the user pick the moment. Fail-open: any error ⇒ continue normally.
      const staleBuild = decideStale(
        PROTOCOL_VERSION,
        members.filter((m) => m.id !== voiceIdRef.current).map((m) => readEngineMeta(m.meta as Record<string, unknown> | undefined).protocol),
      )
      if (staleBuild.stale && !retiredRef.current) {
        try {
          console.warn(`[kibitz] protocol-gate: a peer is on a newer wire protocol (${staleBuild.newerProtocol} > ${PROTOCOL_VERSION}) → prompting a refresh (no auto-reload)`)
          const r: RetirementCheck = { retired: true, message: 'A newer version is in this call. Refresh when you’re ready.' }
          retiredRef.current = r
          setRetired(r)
          setError(r.message || 'Please refresh.')
        } catch {
          /* test/SSR → fail-open, fall through */
        }
      }
      // Mesh: only the ADMITTED set (cap humans, agents free, no eviction) — so an over-cap peer gets no media/data
      // even if it ignores the self-check (collusion-resistant). Uncapped ⇒ admitMembers returns everyone (no-op).
      const admitted = admitMembers(
        members.map((m) => ({ id: m.id, human: m.meta?.role !== 'agent' && m.meta?.kind !== 'voice-assistant' })),
        maxHumans,
        admittedRef.current,
      )
      admittedRef.current = admitted
      meshRef.current?.setRoster(maxHumans ? members.filter((m) => admitted.has(m.id)) : members)
      // Self-heal: the roster authority can change/restart (host migration) and come
      // back EMPTY. If we're in the call but absent from an incoming roster,
      // re-announce ourselves — converges in one round-trip, token-deduped.
      if (mediaRef.current && voiceIdRef.current && !members.some((m) => m.id === voiceIdRef.current)) {
        announceSelf(true)
      }
      // If we've signed in, hand our cert-bound token to anyone newly present.
      shareSelfToken()
      // If we're the authority and hold capability grants, re-broadcast them on every
      // roster change so a NEW joiner enforces the current policy too (and so a freshly
      // promoted authority after a host migration re-publishes what it inherited).
      if (grantsRef.current.size) broadcastCapsRef.current()
      // Modules that replay owned state to late joiners (schema discovery + interactive widgets) re-broadcast via
      // the onRosterChange seam — order-independent so a peer that just joined gets schemas + widgets and pins.
      for (const fn of rosterChangeHandlersRef.current) fn()
    })
  }, [room, announceSelf, shareSelfToken])

  // Presence is NEVER fire-and-forget: while in the call, re-announce every few
  // seconds. Any transient drop during connection setup (or an authority restart)
  // then self-corrects within a tick — so a missing tile fixes itself instead of
  // waiting for the user to toggle their mic/camera to force the re-announce.
  // Re-announcing an unchanged roster is a no-op for the mesh (setRoster only acts
  // on real membership deltas), so this can't disrupt live media.
  useEffect(() => {
    if (!inCall) return
    const id = setInterval(() => {
      if (mediaRef.current) announceSelf(true)
    }, 3000)
    return () => clearInterval(id)
  }, [inCall, announceSelf])

  // Verified-roster (docs §7) — recompute the mutual, pre-share gate while in the call.
  // For each present peer we read its cert-bound verified identity (getIdentity, memoised
  // so this poll is cheap) and check it against the committed roster; our own verified
  // identity drives the self-gate. The result lands in BOTH state (for the UI) and a ref
  // (so the content senders/receiver above can gate synchronously). Inert — and reset to
  // the inert view — whenever there's no roster, so non-verified-roster rooms are untouched.
  useEffect(() => {
    const members = rosterMembersRef.current ?? []
    const domains = rosterDomainsRef.current ?? []
    if (members.length === 0 && domains.length === 0) {
      const inert = evaluateRosterGate({ members: null })
      rosterGateRef.current = inert
      setRosterGate(inert)
      return
    }
    if (!inCall) return
    let alive = true
    const recompute = async () => {
      const present = rosterRef.current.filter((m) => m.id !== voiceIdRef.current)
      const peers = await Promise.all(
        present.map(async (m) => ({ id: m.id, identity: (await getIdentity(m.id).catch(() => null))?.email ?? null })),
      )
      if (!alive) return
      const view = evaluateRosterGate({ members, domains, self: selfIdentityRef.current?.email ?? null, peers })
      rosterGateRef.current = view
      setRosterGate(view)
    }
    void recompute()
    const id = setInterval(recompute, 1500)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [rosterKey, inCall, getIdentity])

  const teardown = useCallback(() => {
    reannounceRef.current.forEach(clearTimeout)
    reannounceRef.current = []
    meshRef.current?.close()
    meshRef.current = null
    mediaRef.current?.close()
    mediaRef.current = null
    voiceIdRef.current = ''
    setSelfVoiceId(null)
    stopStream(localRef.current)
    localRef.current = null
    // The placeholder may be swapped OUT of the stream while the camera is on —
    // stop it explicitly so the canvas capture is released either way.
    placeholderRef.current?.stop()
    placeholderRef.current = null
    // Same for the silent audio placeholder (gone once the real mic is swapped in).
    placeholderAudioRef.current?.stop()
    placeholderAudioRef.current = null
    // Release the dedicated media-gate placeholders (kept alive for the whole call).
    gateVideoPhRef.current?.stop()
    gateVideoPhRef.current = null
    gateAudioPhRef.current?.stop()
    gateAudioPhRef.current = null
    // Every placeholder track is stopped now → close the shared silent AudioContext so it isn't left
    // `running` on the idle landing page (iOS audio-engine drain). Re-minted lazily on the next join.
    closeSilentAudio()
    realMicRef.current = false
    stopStream(selfStreamRef.current)
    selfStreamRef.current = null
    setSelfStream(null)
    setRemote(new Map())
    setInCall(false)
    setCamOn(false)
    setMicOn(false)
    micRef.current = false
    camRef.current = false
    // Identity: drop the cert/token/cache so a fresh call mints a fresh cert and the
    // user re-signs (a new cert ⇒ a new binding). Leaves idConfig/provider/jwks intact.
    // Clearing selfFpRef also invalidates any sign-in still mid-dialog (it captured the
    // old fingerprint and bails when it no longer matches — see signInIdentity).
    pinnedCertRef.current = null
    pinnedCertPromiseRef.current = null
    selfFpRef.current = ''
    selfJwtRef.current = ''
    idTokensRef.current.clear()
    idCacheRef.current.clear()
    sentTokenToRef.current.clear()
    // Peers' published schemas are ephemeral to the call (a fresh call rediscovers them). Our OWN schemas survive
    // inside the module — the app registered them and we re-publish on reconnect. (clearPeers is []-stable.)
    schema.clearPeers()
    selfIdentityRef.current = null
    setSelfIdentity(null)
    // Verified-roster: drop back to the inert view so a left/ended call never strands the
    // UI in a "verifying the room…" hold (a fresh call recomputes from scratch).
    const inertGate = evaluateRosterGate({ members: rosterMembersRef.current, domains: rosterDomainsRef.current })
    rosterGateRef.current = inertGate
    setRosterGate(inertGate)
  }, [])

  // Leave the call if the room/page goes away (only announce if we'd joined).
  useEffect(() => {
    return () => {
      if (mediaRef.current) announceSelf(false)
      teardown()
    }
  }, [teardown, announceSelf])

  const join = useCallback(async (): Promise<boolean> => {
    if (!roomRef.current || mediaRef.current) return false
    // Kill-switch: a retired build refuses to connect (the notice is already on `error`).
    if (retiredRef.current) {
      setError(retiredRef.current.message || 'This version of Kibitz has been retired — reload the page.')
      return false
    }
    // Join WITHOUT a microphone prompt or capture: negotiate a SILENT placeholder audio lane up front
    // (a real, flowing zero-gain track — see createPlaceholderAudioTrack — so even iOS completes the
    // connection), and swap the real mic in on first unmute via replaceTrack. NOT capturing the mic at
    // join matters in a car: starting mic capture makes iOS yank Bluetooth audio from the high-quality
    // A2DP media profile onto the narrowband HFP call profile, glitching the car link — so we stay on
    // A2DP until you actually choose to talk. Internet calls connect via STUN/TURN regardless of mic
    // permission; on a LAN, iOS exposes connectable (non-mDNS) candidates once you unmute (which grabs
    // the mic and re-establishes). Only if Web Audio is missing do we fall back to grabbing at join.
    const stream = new MediaStream()
    let grabbedRealMic = false
    if (!previewRef.current) {
      // LAN/offline (the mesh runs iceServers:[], no TURN): grab the REAL mic at join so iOS exposes its
      // connectable (non-mDNS) host candidates — the synthetic placeholder never unlocks them, so offline
      // media silently never connects (presence rides the relay, so the roster still shows two tiles).
      // Online keeps the placeholder: TURN supplies relay candidates that don't need the unlock, and it
      // avoids the iOS A2DP→HFP Bluetooth glitch from grabbing the mic before you choose to talk.
      const micPlaceholder = offlineRef.current ? null : createPlaceholderAudioTrack()
      if (micPlaceholder) {
        placeholderAudioRef.current = micPlaceholder
        stream.addTrack(micPlaceholder)
      } else {
        // No Web Audio: grab the mic at join, MUTED. Permission unlocks the real ICE
        // candidates; the track stays disabled until the user unmutes.
        try {
          const mic = await navigator.mediaDevices.getUserMedia({ audio: AUDIO, video: false })
          const t = mic.getAudioTracks()[0]
          if (t) {
            t.enabled = false
            stream.addTrack(t)
            grabbedRealMic = true
            // Permission just unlocked real candidates — re-establish the data link
            // (created at panel-open, before permission) so it connects now.
            roomRef.current?.reconnect?.()
          }
        } catch (e) {
          flashNotice(micErrorMessage((e as DOMException)?.name || '', isStandaloneApp()))
          return false
        }
      }
    }
    // The media backend (PeerJS online, or the relay hub offline). Stash it before
    // the async open so a leave/unmount mid-handshake tears it down (check below).
    const media = makeMediaRef.current()
    mediaRef.current = media
    try {
      // Negotiate a two-way video lane up-front via a placeholder track, so camera
      // toggles never re-dial (see core/media + core/mesh). Added BEFORE open() so
      // the mesh's first dials already carry the video lane.
      const placeholder = createPlaceholderVideoTrack()
      placeholderRef.current = placeholder
      if (placeholder) stream.addTrack(placeholder)
      // Second video lane (screen-share), negotiated up-front: a dormant placeholder so the share m-line exists
      // from the first offer (adding it mid-call would renegotiate → iOS WebKit churn). Swapped to the real
      // screen by shareTrack(); never replaces the camera lane above. Kept OFFLINE too — offline media now
      // relays through the hub's TURN (not flaky peer-to-peer host candidates), which carries the extra video
      // m-line fine, so screen-share works on a LAN call again.
      const sharePh = createPlaceholderVideoTrack()
      sharePlaceholderRef.current = sharePh
      if (sharePh) stream.addTrack(sharePh)
      // OPT-IN 2nd AUDIO lane (a staged video's sound), negotiated up-front like the share VIDEO lane — appended
      // LAST so the m-line order is audio, video, video, audio (mic = audio[0], share-audio = audio[1]). Added
      // only when enabled, so by default the negotiated m-line set is unchanged (no impact on existing calls).
      // Still SKIPPED offline: a 2nd AUDIO section is the one the project saw break iOS negotiation outright, and
      // it's a niche feature — the screen-share VIDEO above is the part that matters on a LAN call.
      if (!previewRef.current && !offlineRef.current && shareAudioOn()) {
        const shareAudioPh = createPlaceholderAudioTrack()
        shareAudioPlaceholderRef.current = shareAudioPh
        if (shareAudioPh) stream.addTrack(shareAudioPh)
      }

      // Mint the dedicated media-gate placeholders NOW — before any await — so the silent
      // audio one is created while the join tap's user-activation is still fresh (an
      // AudioContext needs a gesture to resume). They're never added to `local`; the mesh
      // substitutes them per-peer to withhold a share / audio from an unentitled peer.
      if (!previewRef.current) {
        gateVideoPhRef.current = createPlaceholderVideoTrack()
        gateAudioPhRef.current = createPlaceholderAudioTrack()
      }

      // Identity (opt-in): pin a shared cert so every connection presents the same one
      // — a single signed token then verifies for all peers. Generated lazily and
      // shared with sign-in (whichever happens first). Skipped entirely when off.
      const certificate = idConfigRef.current ? ((await ensurePinnedCert()) ?? undefined) : undefined
      // Per-peer media gate (Phase 4): hand the gate + dedicated placeholders to open() so the mesh
      // installs it BEFORE the local stream — a peer already dialling us is gated from its first
      // frame. Inert for an all-human room (every grant full → real tracks to everyone, no churn).
      const mediaGateOpt = previewRef.current
        ? undefined
        : { gate: mediaGate.current, placeholders: { video: gateVideoPhRef.current, audio: gateAudioPhRef.current } }
      const { voiceId, mesh } = await media.open(stream, onRemote, { certificate, mediaGate: mediaGateOpt, relayOnly: relayOnlyRef.current })
      if (mediaRef.current !== media) {
        mesh.close()
        stopStream(stream)
        placeholder?.stop()
        return false // left during the handshake
      }
      voiceIdRef.current = voiceId
      setSelfVoiceId(voiceId)
      localRef.current = stream
      // Self preview/meter stream: the silent placeholder for now (rebuilt with the
      // real mic on first unmute, so the voice-meter analyser inits on real audio).
      const self = new MediaStream(stream.getAudioTracks())
      selfStreamRef.current = self
      setSelfStream(self)
      setMicOn(false)
      micRef.current = false
      camRef.current = false
      realMicRef.current = grabbedRealMic
      meshRef.current = mesh
      mesh.onData(dispatchContent) // content flows peer-to-peer over the data mesh
      mesh.onDataLinkOpen(nudgeResumeFrom) // a re-healed link → resume any interrupted transfer at once
      mesh.onPeerLeft((id) => {
        // A peer GRACEFULLY left (its P2P `bye`) → drop its tile NOW, don't wait for the authority roster or the
        // rosterHold silence timeout. leftPeers in the mesh keeps the hold from resurrecting it on the next tick.
        lastMemberRef.current.delete(id)
        rosterRef.current = rosterRef.current.filter((m) => m.id !== id)
        setRoster((prev) => prev.filter((m) => m.id !== id))
      })
      mesh.setAdmit((id) => !maxHumans || admittedRef.current.has(id)) // room human-cap: refuse over-cap peers' dials
      announceSelf(true) // re-broadcast the roster/presence including us
      // Dial anyone already in the call — but only the ADMITTED set when capped (so we never open beyond the cap).
      const joinAdmitted = admitMembers(
        rosterRef.current.map((m) => ({ id: m.id, human: m.meta?.role !== 'agent' && m.meta?.kind !== 'voice-assistant' })),
        maxHumans,
        admittedRef.current,
      )
      admittedRef.current = joinAdmitted
      mesh.setRoster(maxHumans ? rosterRef.current.filter((m) => joinAdmitted.has(m.id)) : rosterRef.current)
      setInCall(true)
      setError(null)
      // Belt-and-suspenders: re-announce a couple of times in case the first
      // announce raced the authority's data channel (the authority also re-syncs
      // the roster on its heartbeat — see room.ts — this just makes it snappy).
      reannounceRef.current.forEach(clearTimeout)
      reannounceRef.current = [600, 1800].map((ms) =>
        setTimeout(() => {
          if (mediaRef.current) announceSelf(true)
        }, ms),
      )
      return true
    } catch {
      stopStream(stream)
      placeholderRef.current?.stop()
      placeholderRef.current = null
      placeholderAudioRef.current = null // stopped by stopStream above
      media.close()
      if (mediaRef.current === media) mediaRef.current = null
      setError("Couldn't connect the call. Try again.")
      return false
    }
  }, [onRemote, announceSelf, ensurePinnedCert, flashNotice])

  const leave = useCallback(() => {
    announceSelf(false)
    teardown()
  }, [teardown, announceSelf])

  /** Free a captured-but-muted microphone (iOS): stop the real mic track and substitute the silent
   *  placeholder, so iOS drops the recording indicator and its record-mode audio session — which is
   *  what CLICKS on an app-switch gesture. The next unmute re-grabs the mic. Must be called from a
   *  user gesture (the placeholder AudioContext needs one). No-op unless iOS + muted + a real mic is
   *  currently captured. */
  const releaseMutedMic = useCallback(() => {
    if (keepMicCapturedRef.current) return // car mode holds the mic so call audio stays on the car
    if (!isIOS() || micRef.current || !realMicRef.current) return
    const stream = localRef.current
    if (!stream) return
    const ph = createPlaceholderAudioTrack()
    if (!ph) return
    meshRef.current?.replaceAudioTrack(ph) // real mic → silent placeholder on the live mesh
    for (const t of stream.getAudioTracks()) {
      stream.removeTrack(t)
      t.stop() // release the hardware → iOS recording indicator off
    }
    stream.addTrack(ph)
    placeholderAudioRef.current = ph
    realMicRef.current = false // so the next unmute re-grabs the mic
    const self = selfStreamRef.current
    const rebuilt = new MediaStream(self ? self.getVideoTracks() : [])
    selfStreamRef.current = rebuilt
    setSelfStream(rebuilt)
  }, [])

  // Grab the real mic and install it on the live mesh — replaceTrack the silent placeholder on every
  // connection (no re-dial/renegotiation, iOS-safe), swap it into the stream so future dials carry it,
  // and rebuild selfStream so the voice-meter analyser re-inits on real audio. Leaves the muted state
  // as-is (enabled = micRef). Returns true once a real mic is captured. No-op if already captured.
  const captureMic = useCallback(async (deviceId?: string): Promise<boolean> => {
    if (realMicRef.current) return true
    const stream = localRef.current
    if (!stream) return false
    let track: MediaStreamTrack | undefined
    try {
      const audio = deviceId ? { ...AUDIO, deviceId: { exact: deviceId } } : AUDIO
      let mic: MediaStream
      try {
        mic = await navigator.mediaDevices.getUserMedia({ audio, video: false })
      } catch (e1) {
        // A chosen mic that's gone, or a constraint this device can't meet → fall back to ANY mic before failing
        // (only that case; a true permission denial / no-device must still surface, not silently retry).
        const name = (e1 as DOMException)?.name
        if (deviceId || name === 'OverconstrainedError') mic = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
        else throw e1
      }
      track = mic.getAudioTracks()[0]
    } catch (e) {
      // Accurate, actionable message by cause (blocked vs. busy vs. no-mic) — and the iOS Settings route when we're
      // an installed Home-Screen app, where there's no address bar to re-grant. (Was a catch-all "blocked".)
      flashNotice(micErrorMessage((e as DOMException)?.name || '', isStandaloneApp()))
      return false
    }
    if (!track) return false
    // Permission just unlocked real ICE candidates (iOS Safari) — kick the data link to re-establish.
    roomRef.current?.reconnect?.()
    // Put the real track on every sender NOW — over the silent placeholder (unmute-after-mute) OR over a
    // track iOS killed when the app was backgrounded (the revive path). replaceTrack is renegotiation-free.
    meshRef.current?.replaceAudioTrack(track)
    const placeholder = placeholderAudioRef.current
    if (placeholder) {
      stream.removeTrack(placeholder)
      placeholder.stop()
      placeholderAudioRef.current = null
    }
    // Drop any stale/ended audio track (e.g. the mic iOS released on background) so only the fresh one remains.
    stream.getAudioTracks().forEach((t) => {
      if (t === track) return
      try {
        t.stop()
      } catch {
        /* already stopped */
      }
      stream.removeTrack(t)
    })
    if (!stream.getAudioTracks().includes(track)) stream.addTrack(track)
    track.enabled = micRef.current // honour the current muted state (engageMic captures while muted)
    realMicRef.current = true
    try { setMicDeviceIdState(track.getSettings().deviceId || '') } catch { /* Settings unavailable — leave as-is */ }
    // iOS may end this track when the app is backgrounded again — notice it so the next foreground re-grabs.
    track.addEventListener('ended', () => { realMicRef.current = false; reviveRef.current?.() }, { once: true })
    const self = selfStreamRef.current
    const rebuilt = new MediaStream([track, ...(self ? self.getVideoTracks() : [])])
    selfStreamRef.current = rebuilt
    setSelfStream(rebuilt)
    return true
  }, [flashNotice])

  const toggleMic = useCallback(async (deviceId?: string) => {
    const stream = localRef.current
    if (!stream) return
    const next = !micRef.current
    // FIRST unmute grabs the mic now (no prompt on entry — it lands when you choose to talk). An explicit deviceId
    // (the pre-join's chosen mic) wins; else re-use the in-call menu's pick so unmute keeps the chosen input.
    if (next && !realMicRef.current && !(await captureMic(deviceId ?? micChoiceRef.current ?? undefined))) return
    micRef.current = next
    stream.getAudioTracks().forEach((t) => (t.enabled = next))
    setMicOn(next)
    // When muting, FREE the captured mic (iOS) — stops the recording, so there's no recording
    // indicator and nothing for an app-switch gesture to click. (Car mode opts out — see keepMic.)
    if (!next) releaseMutedMic()
  }, [captureMic, releaseMutedMic])

  // Car mode (iOS): capture the mic while staying muted, so the call's voice audio routes to a
  // Bluetooth/car device immediately and there's no profile-switch glitch on later mute/unmute. Paired
  // with setKeepMicCaptured(true) so releaseMutedMic won't free it. Other platforms route fine without.
  const engageMic = useCallback(() => {
    if (!isIOS()) return
    void captureMic()
  }, [captureMic])
  const setKeepMicCaptured = useCallback((on: boolean) => {
    keepMicCapturedRef.current = on
  }, [])

  // iOS: the mic is grabbed at join to unlock ICE, but you join MUTED — free it as soon as the call
  // is up so a listener who never touches mute also gets the recording indicator off. Safe: ICE is
  // unlocked by PERMISSION (which persists), not by capturing; the gate placeholder already resumed
  // the audio context at join, so no fresh gesture is needed. Self-gates (iOS + muted + real mic).
  useEffect(() => {
    if (inCall) releaseMutedMic()
  }, [inCall, releaseMutedMic])

  // Acquire the camera and install it on the live mesh — the shared path for BOTH turning the camera on
  // (toggleCam) and reviving it after iOS released it on a background. Silent replaceTrack on every
  // connection (re-dials crash iOS WebKit). Drops the placeholder AND any track iOS killed, re-arms an
  // `ended` watcher, and sets the on-state. Returns false if getUserMedia was blocked (caller decides UX).
  const captureCam = useCallback(
    async (facing: CamFacing, deviceId?: string): Promise<boolean> => {
      const mesh = meshRef.current
      const stream = localRef.current
      if (!mesh || !stream) return false
      facingRef.current = facing
      setCamFacing(facing)
      let camTrack: MediaStreamTrack | undefined
      try {
        const video = deviceId ? { ...VIDEO, deviceId: { exact: deviceId } } : videoConstraints(facing)
        const cam = await navigator.mediaDevices.getUserMedia({ video })
        camTrack = cam.getVideoTracks()[0]
      } catch {
        return false // blocked / needs a gesture — the caller surfaces it
      }
      if (!camTrack) return false
      // Permission just unlocked real ICE candidates (iOS) — re-establish the data link if needed.
      roomRef.current?.reconnect?.()
      navigator.mediaDevices
        .enumerateDevices()
        .then((ds) => setCanFlip(ds.filter((d) => d.kind === 'videoinput').length > 1))
        .catch(() => {})
      mesh.replaceVideoTrack(camTrack) // silent swap on every live connection — no re-dial/renegotiation
      const placeholder = placeholderRef.current
      // Drop the placeholder (kept referenced for the off-swap) + any stale/ended video track; keep the new one.
      stream.getVideoTracks().forEach((t) => {
        if (t === camTrack) return
        if (t !== placeholder) {
          try {
            t.stop()
          } catch {
            /* already stopped */
          }
        }
        stream.removeTrack(t)
      })
      if (!stream.getVideoTracks().includes(camTrack)) stream.addTrack(camTrack)
      // Re-read selfStream AFTER the await — toggleMic may have rebuilt it while getUserMedia was in flight.
      const liveSelf = selfStreamRef.current
      liveSelf?.getVideoTracks().forEach((t) => liveSelf.removeTrack(t))
      liveSelf?.addTrack(camTrack)
      // iOS may end this track on the next background — notice it so the next foreground re-grabs.
      camTrack.addEventListener('ended', () => reviveRef.current?.(), { once: true })
      camRef.current = true
      try { setCamDeviceIdState(camTrack.getSettings().deviceId || '') } catch { /* Settings unavailable — leave as-is */ }
      setCamOn(true)
      announceSelf(true)
      setError(null)
      return true
    },
    [announceSelf],
  )

  const toggleCam = useCallback(async (facing?: CamFacing, deviceId?: string) => {
    const mesh = meshRef.current
    const stream = localRef.current
    // Ignore a re-tap while a toggle is mid-flight (getUserMedia is async — two
    // overlapping toggles could leave the UI and the live stream out of sync).
    if (!mesh || !stream || togglingCamRef.current) return
    togglingCamRef.current = true
    const turningOn = !camRef.current
    try {
      if (turningOn) {
        // Turning the camera ON uses the FRONT/selfie cam by default — UNLESS an explicit facing is
        // passed (e.g. the pre-join carried a rear selection into the call). The default matters: a
        // prior flip-to-rear left facingRef on 'environment', so re-enabling the camera (incl. the
        // bottom-bar flip button when it was off) must not surprise-reopen the REAR camera. "phones
        // never surprise with the rear camera." Flip after, on purpose, to go rear. captureCam does the
        // acquire + swap + on-state (shared with the iOS background-revive path). A specific deviceId (pre-join or
        // the in-call menu's remembered pick) wins over facing.
        if (!(await captureCam(facing ?? 'user', deviceId ?? camChoiceRef.current ?? undefined))) flashNotice('Camera access was blocked.')
      } else {
        // Swap back to the placeholder FIRST (no sender ever holds a dead track),
        // then stop and detach the camera.
        const self = selfStreamRef.current
        const placeholder = placeholderRef.current
        if (placeholder) mesh.replaceVideoTrack(placeholder)
        stream.getVideoTracks().forEach((t) => {
          if (t === placeholder) return
          t.stop()
          stream.removeTrack(t)
        })
        if (placeholder && !stream.getVideoTracks().includes(placeholder)) stream.addTrack(placeholder)
        self?.getVideoTracks().forEach((t) => self.removeTrack(t))
        camRef.current = false
        announceSelf(true)
        setCamOn(false)
        setError(null)
      }
    } catch {
      flashNotice(turningOn ? 'Camera access was blocked.' : 'Could not switch off the camera.')
    } finally {
      togglingCamRef.current = false
    }
  }, [captureCam, announceSelf, flashNotice])

  // Switch the MIC input device mid-call (desktop). Remembers the pick (so mute/unmute keeps it) and, if the mic is
  // live, swaps the input NOW via captureMic's renegotiation-free replaceTrack — resetting realMicRef so it re-grabs
  // (the same reset the iOS revive path uses). On failure the old mic stays. If muted, the pick just applies on unmute.
  const switchMic = useCallback(
    async (deviceId: string) => {
      micChoiceRef.current = deviceId || ''
      setMicDeviceIdState(deviceId || '')
      if (!micRef.current || !realMicRef.current) return // off / not captured → applies on next unmute
      realMicRef.current = false
      if (!(await captureMic(deviceId || undefined))) realMicRef.current = true // re-grab failed → keep the current mic
    },
    [captureMic],
  )
  // Switch the CAMERA input device mid-call (desktop). captureCam has no "already captured" guard, so it re-acquires
  // + replaceTracks the live video silently. Remembers the pick for a later camera off/on; a no-op while the camera
  // is off (the pick applies when it's next turned on) or a toggle is mid-flight.
  const switchCam = useCallback(
    async (deviceId: string) => {
      camChoiceRef.current = deviceId || ''
      setCamDeviceIdState(deviceId || '')
      if (!camRef.current || togglingCamRef.current) return // off / mid-toggle → applies on next enable
      togglingCamRef.current = true
      try {
        if (!(await captureCam(facingRef.current, deviceId || undefined))) flashNotice('Could not switch camera.')
      } finally {
        togglingCamRef.current = false
      }
    },
    [captureCam, flashNotice],
  )

  // iOS releases the mic/camera when the app is backgrounded (app switch / screen lock) — unavoidable. This
  // brings them back when the app returns: for each lane the user still WANTS whose real track actually died
  // (planRevive), re-acquire it (captureMic / captureCam). A SILENT re-grab works if iOS still honours the
  // prior gesture; if not (it needs a fresh tap), flag `needsMediaGesture` so the UI offers a one-tap resume,
  // which calls back here from a real gesture. No-op off iOS / when nothing died / in car mode. Idempotent
  // (revivingRef guards a foreground event racing a track-`ended` event).
  const reviveMedia = useCallback(async (includeMuted = false): Promise<void> => {
    if (!isIOS() || !mediaRef.current || revivingRef.current) return
    const stream = localRef.current
    if (!stream) return
    const micTrack = stream.getAudioTracks().find((t) => t !== placeholderAudioRef.current)
    const camTrack = stream.getVideoTracks().find((t) => t !== placeholderRef.current)
    // iOS sometimes leaves a track LIVE but MUTED (frames/audio paused) instead of ending it, and it does NOT
    // always auto-resume on foreground. So on the DELAYED pass (includeMuted — after a grace for iOS to unmute
    // on its own) treat a still-muted wanted track as needing re-acquire too, not just an `ended` one.
    const stalled = (t?: MediaStreamTrack) => trackDead(t) || (includeMuted && !!t && t.muted)
    const plan = planRevive({
      ios: true,
      inCall: true,
      micIntent: micRef.current,
      camIntent: camRef.current,
      keepMic: keepMicCapturedRef.current,
      micDead: stalled(micTrack),
      camDead: stalled(camTrack),
    })
    if (!plan.reMic && !plan.reCam) {
      setNeedsMediaGesture(false)
      return
    }
    revivingRef.current = true
    let needGesture = false
    try {
      if (plan.reMic) {
        realMicRef.current = false // the dead track must not short-circuit captureMic's re-grab
        if (!(await captureMic())) needGesture = true
      }
      if (plan.reCam && !(await captureCam(facingRef.current))) needGesture = true
    } finally {
      revivingRef.current = false
    }
    setNeedsMediaGesture(needGesture)
  }, [captureMic, captureCam])
  reviveRef.current = reviveMedia
  /** Called from a user tap (gesture satisfied) to bring the mic/camera back when the silent revive needed one. */
  const resumeMedia = useCallback(() => {
    void reviveMedia()
  }, [reviveMedia])

  /** Front ⇄ rear: a silent replaceTrack on every live connection — the same
   * no-churn path as the camera toggle (re-dials crash iOS WebKit natively). */
  const flipCam = useCallback(async () => {
    const mesh = meshRef.current
    const stream = localRef.current
    if (!mesh || !stream || !camRef.current || togglingCamRef.current) return
    togglingCamRef.current = true
    const next: CamFacing = facingRef.current === 'user' ? 'environment' : 'user'
    try {
      const cam = await navigator.mediaDevices.getUserMedia({ video: videoConstraints(next) })
      const newTrack = cam.getVideoTracks()[0]
      if (!newTrack) throw new Error('no camera track')
      mesh.replaceVideoTrack(newTrack)
      const placeholder = placeholderRef.current
      stream.getVideoTracks().forEach((t) => {
        if (t === placeholder) return
        t.stop()
        stream.removeTrack(t)
      })
      stream.addTrack(newTrack)
      const self = selfStreamRef.current
      self?.getVideoTracks().forEach((t) => self.removeTrack(t))
      self?.addTrack(newTrack)
      facingRef.current = next
      setCamFacing(next)
      setError(null)
    } catch {
      flashNotice('Could not switch cameras.')
    } finally {
      togglingCamRef.current = false
    }
  }, [flashNotice])

  // (The OS / car media-control wiring lives in the Widget now — it needs the app-level leaveCall to
  // exit cleanly, and on iOS a silent Now-Playing claim to make the car's controls route to us.)

  // Connection robustness on a flaky link (cellular in a moving car, Wi-Fi handoff): when the network
  // drops and comes back — or the tab returns to the foreground — kick the signaling link to reconnect
  // so the mesh recovers promptly instead of sitting in a half-dead state. Idempotent (reconnect is
  // already called liberally elsewhere); the TURN relay remains the fallback path when the direct one
  // is too lossy. Only while in a call.
  // Publish call state so the app shell (the PWA UpdateBanner) can hold a version reload while a call is LIVE — a
  // silent reload mid-call would drop it. A global flag (read on-demand) + a change event (so the update layer can
  // reload the instant the call ENDS). Version skew is additive/back-compatible, so running the old build until the
  // call finishes is safe.
  useEffect(() => {
    if (typeof window === 'undefined') return
    ;(globalThis as Record<string, unknown>)['__kbzInCall'] = inCall
    window.dispatchEvent(new CustomEvent('kbz:incallchange', { detail: inCall }))
  }, [inCall])

  useEffect(() => {
    if (!inCall || typeof window === 'undefined') return
    const kick = () => roomRef.current?.reconnect?.()
    // Bringing the app to the FOREGROUND. A standalone iOS PWA doesn't always fire `visibilitychange` cleanly on
    // resume, so we also listen for `focus` and `pageshow` (debounced, since `focus` is chatty) — whichever fires,
    // we revive. Pass 1 (now): re-acquire a track iOS ENDED. Pass 2 (after a grace): catch a track left LIVE-but-
    // MUTED that didn't auto-resume on its own.
    let lastFg = 0
    const onForeground = () => {
      const now = Date.now()
      if (now - lastFg < 400) return // debounce repeated focus/visibility within a single resume
      lastFg = now
      kick()
      reviveRef.current?.(false)
      window.setTimeout(() => reviveRef.current?.(true), 1500)
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') onForeground()
    }
    window.addEventListener('online', kick)
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onForeground)
    window.addEventListener('pageshow', onForeground)
    return () => {
      window.removeEventListener('online', kick)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onForeground)
      window.removeEventListener('pageshow', onForeground)
    }
  }, [inCall])

  /** Return the video lane to off — swap the placeholder back in, stop the shared
   *  track. Mirrors the camera-off branch so no sender ever holds a dead track. */
  const stopShare = useCallback(() => {
    const mesh = meshRef.current
    if (!mesh) return
    // Sharing is its OWN lane now, independent of the camera. Stopping restores the dormant share placeholder
    // on the SHARE lane and releases the capture — and NEVER touches the camera lane (camRef/cam stay as-is),
    // so a presenter who had their camera on keeps it.
    sharingRef.current = false
    const t = shareSelfRef.current
    shareSelfRef.current = null
    mesh.replaceShareTrack(sharePlaceholderRef.current)
    if (t) t.stop()
    // Also drop the share-AUDIO (a screen-share's tab/system sound, or a staged clip's audio) — restore the
    // dormant silent placeholder so the 2nd audio lane goes quiet (no-op if the lane wasn't negotiated).
    const at = shareAudioSelfRef.current
    shareAudioSelfRef.current = null
    mesh.replaceShareAudioTrack(shareAudioPlaceholderRef.current)
    if (at) at.stop()
    setSharing(false)
    announceSelf(true)
  }, [announceSelf])

  /** Publish a screen/tab-capture track on the dedicated SHARE lane (the 2nd video lane) — a silent
   *  replaceTrack swap, no re-dial/renegotiation. The camera lane is left alone, so the sharer keeps their
   *  camera/avatar in their tile while the share fills the stage. The extension feeds its chrome.tabCapture
   *  track straight in here. Per-peer gated by `see-screen` as it goes out. */
  const shareTrack = useCallback(
    async (track: MediaStreamTrack) => {
      const mesh = meshRef.current
      if (!mesh) return false
      try {
        // Mark the share active BEFORE publishing so the per-peer gate withholds it (substitutes the
        // placeholder) from a peer lacking `see-screen` as it goes out — never reaching them, not one frame.
        sharingRef.current = true
        shareSelfRef.current = track
        mesh.replaceShareTrack(track) // SHARE lane only — camera lane untouched
        setSharing(true)
        // "Stop sharing" from the browser's own bar ends the track → revert cleanly.
        track.addEventListener('ended', () => sharingRef.current && stopShare(), { once: true })
        announceSelf(true)
        setError(null)
        return true
      } catch {
        sharingRef.current = false // publish failed — we're not sharing after all
        shareSelfRef.current = null
        flashNotice('Could not start the screen share.')
        return false
      }
    },
    [announceSelf, stopShare, flashNotice],
  )

  /** Publish a custom outgoing AUDIO track to the mesh (e.g. a synthesized song) — peers hear it
   *  immediately. Pass null to restore the silent placeholder (back to emitting nothing). Doesn't
   *  touch the mic/unmute UI state — for a headless agent that joined muted and wants to "speak". */
  const publishAudioTrack = useCallback((track: MediaStreamTrack | null) => {
    const mesh = meshRef.current
    if (!mesh) return
    if (track) {
      mesh.replaceAudioTrack(track)
    } else {
      const ph = placeholderAudioRef.current || createPlaceholderAudioTrack()
      if (ph) {
        placeholderAudioRef.current = ph
        mesh.replaceAudioTrack(ph)
      }
    }
  }, [])
  // Publish a staged video's SOUND on the dedicated 2nd audio lane (leaving the mic untouched). null restores the
  // dormant silent placeholder. No-op unless the share-audio lane was negotiated (opt-in) — laneSender → null.
  const publishShareAudio = useCallback((track: MediaStreamTrack | null) => {
    meshRef.current?.replaceShareAudioTrack(track || shareAudioPlaceholderRef.current)
  }, [])

  // Inject a synthetic video track onto the CAMERA lane (the always-present video sender → no renegotiation),
  // so it renders in OUR tile and announces cam-on. `sharing` is untouched (stays false), so this is NOT a
  // stage screen-share — a human pins the tile to promote it. null → swap the placeholder back (tile → avatar).
  // Same stream/announce bookkeeping as the camera toggle, but with an injected track (no getUserMedia).
  const publishVideoTrack = useCallback(
    (track: MediaStreamTrack | null) => {
      const mesh = meshRef.current
      const stream = localRef.current
      if (!mesh || !stream) return
      const placeholder = placeholderRef.current
      const self = selfStreamRef.current
      if (track) {
        mesh.replaceVideoTrack(track)
        stream.getVideoTracks().forEach((t) => {
          if (t === placeholder || t === track) return
          t.stop()
          stream.removeTrack(t)
        })
        if (!stream.getVideoTracks().includes(track)) stream.addTrack(track)
        self?.getVideoTracks().forEach((t) => self.removeTrack(t))
        self?.addTrack(track)
        camRef.current = true
        setCamOn(true)
      } else {
        if (placeholder) mesh.replaceVideoTrack(placeholder)
        stream.getVideoTracks().forEach((t) => {
          if (t === placeholder) return
          t.stop()
          stream.removeTrack(t)
        })
        if (placeholder && !stream.getVideoTracks().includes(placeholder)) stream.addTrack(placeholder)
        self?.getVideoTracks().forEach((t) => self.removeTrack(t))
        camRef.current = false
        setCamOn(false)
      }
      announceSelf(true)
    },
    [announceSelf],
  )

  /** Pick a screen/tab/window via the browser and share it (no extension needed). */
  const shareScreen = useCallback(async () => {
    try {
      // Ask the browser to FOCUS the captured tab/window after the share starts, via a CaptureController
      // — otherwise sharing a tab leaves you sitting on the call tab, not the thing you're presenting
      // (a web page can't switch tabs itself; this is the only sanctioned way). Best-effort: the type
      // isn't in lib.dom everywhere, and setFocusBehavior must be called right after the capture begins.
      const Ctl = (window as unknown as { CaptureController?: new () => { setFocusBehavior?: (b: string) => void } }).CaptureController
      const controller = Ctl ? new Ctl() : undefined
      // Request audio too — the picker offers "share tab/system audio". If the user includes it, send it on the
      // share-AUDIO lane (no-op unless that opt-in lane is negotiated; the mic is untouched either way).
      const ds = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true, controller } as DisplayMediaStreamOptions)
      try {
        controller?.setFocusBehavior?.('focus-captured-surface')
      } catch {
        /* focus control unsupported / too late — the share still works */
      }
      const track = ds.getVideoTracks()[0]
      if (!track) return false
      const ok = await shareTrack(track)
      if (ok) {
        const atrack = ds.getAudioTracks()[0]
        if (atrack) {
          shareAudioSelfRef.current = atrack
          meshRef.current?.replaceShareAudioTrack(atrack) // peers hear the shared screen's audio (lane permitting)
          atrack.addEventListener('ended', () => meshRef.current?.replaceShareAudioTrack(shareAudioPlaceholderRef.current), { once: true })
        }
      }
      return ok
    } catch {
      flashNotice('Screen share was blocked or cancelled.')
      return false
    }
  }, [shareTrack, flashNotice])

  const setAvatar = useCallback(
    (next: string) => {
      avatarRef.current = next
      setAvatarState(next)
      try {
        localStorage.setItem(AVATAR_KEY, next)
      } catch {
        /* ignore */
      }
      // Rebroadcast so the room sees the change immediately (only meaningful in a call).
      if (meshRef.current) announceSelf(true)
    },
    [announceSelf],
  )

  const setMeta = useCallback(
    (next: Record<string, unknown>) => {
      // NO-OP IF UNCHANGED. A caller that re-derives the same meta every render (e.g. a follower re-advertising
      // stageHave, whose effect deps include the per-render `call` object) would otherwise setMetaState(a NEW
      // object) → re-render → effect fires again → setMeta → … a tight loop that floods `announceSelf` presence
      // broadcasts (PeerJS BinaryPack) and grows memory without bound. Shallow-compare guards every caller.
      if (metaShallowEqual(metaRef.current, next)) return
      metaRef.current = next
      setMetaState(next)
      // Rebroadcast so the roster carries the new metadata (only meaningful in a call).
      if (meshRef.current) announceSelf(true)
    },
    [announceSelf],
  )

  const participants = useMemo<CallParticipant[]>(() => {
    const others = roster
      .filter((m) => m.id !== selfVoiceId)
      .map((m) => {
        const { engine, features, appMeta } = readEngineMeta(m.meta)
        return {
          id: m.id,
          name: m.name,
          cam: m.cam,
          avatar: m.avatar ?? '',
          stream: cameraStreamFor(
            m.id,
            remote.get(m.id) ?? null,
            meshRef.current?.remoteShareTrack(m.id) ?? null,
            meshRef.current?.remoteShareAudioTrack(m.id) ?? null,
          ),
          shareStream: shareStreamFor(m.id, meshRef.current?.remoteShareTrack(m.id) ?? null),
          shareAudioStream: shareAudioStreamFor(m.id, meshRef.current?.remoteShareAudioTrack(m.id) ?? null),
          isSelf: false,
          meta: appMeta,
          engine,
          features,
        }
      })
    if (inCall && selfVoiceId) {
      // Your own tile carries your actual name (like the original app) — 'You' only as a
      // fallback when none was given.
      return [
        {
          id: selfVoiceId,
          name: name.trim() || 'You',
          cam: camOn,
          avatar,
          stream: selfStream,
          shareStream: shareStreamFor(selfVoiceId, sharing ? shareSelfRef.current : null),
          shareAudioStream: null, // self doesn't play its own staged-video sound back
          isSelf: true,
          mirror: camFacing === 'user' && !sharing,
          sharing,
          meta,
          engine: APP_VERSION,
          features: advertisedFeatures(),
        },
        ...others,
      ]
    }
    return others
  }, [roster, remote, inCall, camOn, avatar, selfStream, selfVoiceId, name, camFacing, sharing, meta, shareStreamFor, shareAudioStreamFor])

  // Room human-cap (cooperative quality guardrail): a room link may carry cap=N (max HUMANS). The P2P mesh
  // degrades past a handful (every peer uploads to every other), so if we arrive to find the room already at the
  // cap, we step back out with a notice. Honest clients self-limit; exceeding it needs a modified client and only
  // hurts that call. Agents don't count toward the cap. No cap param (e.g. all of kibitz.chat) ⇒ unlimited.
  const maxHumans = useMemo(() => {
    try {
      // fragment first (the creator's bare-fragment control link), then the legacy query (the /j-hop invite).
      const v = parseInt(splitRoomHash(location.hash).params.get('cap') || new URLSearchParams(location.search).get('cap') || '', 10)
      return Number.isInteger(v) && v > 0 ? v : null
    } catch {
      return null
    }
  }, [])
  useEffect(() => {
    if (!maxHumans || !inCall || !selfVoiceId) return
    // Rank-based self-limit: I leave ONLY if *I* am the overflow — the (maxHumans+1)-th human or later in the
    // authority's shared roster order (a Map's insertion order, broadcast identically to every peer). Counting
    // "others >= cap" was catastrophically wrong: when an over-cap joiner appears, EVERY incumbent also sees `cap`
    // others and the whole room collapsed. By my own rank, exactly the late arrivals bounce and the incumbents
    // stay — matching the mesh's admitMembers (same roster order, same agent-exclusion). Agents never count; if I'm
    // not in the roster yet (mid-migration), I don't bounce (the 3s re-announce re-adds me, then this re-checks).
    const isHuman = (m: CallMember) => m.meta?.role !== 'agent' && m.meta?.kind !== 'voice-assistant'
    let rank = 0
    for (const m of roster) {
      if (!isHuman(m)) continue
      rank++
      if (m.id === selfVoiceId) {
        if (rank > maxHumans) {
          flashNotice(`This room is full (max ${maxHumans}).`)
          leave()
        }
        return
      }
    }
  }, [roster, maxHumans, inCall, selfVoiceId, leave, flashNotice])

  return {
    ready: !!room,
    inCall,
    participants,
    rosterCount: roster.length,
    micOn,
    camOn,
    needsMediaGesture,
    avatar,
    error,
    notice,
    retired,
    join,
    leave,
    toggleMic,
    releaseMutedMic,
    engageMic,
    setKeepMicCaptured,
    toggleCam,
    flipCam,
    switchMic,
    switchCam,
    micDeviceId,
    camDeviceId,
    resumeMedia,
    canFlip,
    speakerId,
    setSpeaker,
    sharing,
    shareScreen,
    shareTrack,
    publishShareAudio,
    stopShare,
    publishAudioTrack,
    publishVideoTrack,
    setAvatar,
    setMeta,
    chat,
    sendChat,
    seedChatHistory,
    exportLedger,
    ledgerVersion,
    importLedger,
    sendImage,
    onImage,
    onFile,
    sendContent,
    sendFile,
    cancelTransfer,
    broadcastLedger: ledger.send,
    onLedger: ledger.on,
    fetchBlob,
    sendCtl: ctl.send,
    sendCtlTo: ctl.sendTo,
    onCtl: ctl.on,
    acceptTransfer,
    declineTransfer,
    sendApp: app.sendApp,
    sendAppTo: app.sendAppTo,
    onApp: app.onApp,
    sendPay: pay.sendPay,
    onPay: pay.onPay,
    sendInk: ink.sendInk,
    onInk: ink.onInk,
    registerSchema: schema.registerSchema,
    getSchemas: schema.getSchemas,
    onSchema: schema.onSchema,
    sendWidget: widgets.sendWidget,
    removeWidget: widgets.removeWidget,
    onWidget: widgets.onWidget,
    sendWidgetEvent: widgets.sendWidgetEvent,
    onWidgetEvent: widgets.onWidgetEvent,
    hideWidget: widgets.hideWidget,
    getSafetyCode,
    getConnectionInfo,
    identityEnabled: !!idConfig || !!(acceptProviders && acceptProviders.length),
    selfIdentity,
    signInIdentity,
    identityNonce,
    provideIdentityToken,
    provideAgentKey,
    provideAgentCredit,
    claimHost,
    claimHostByName,
    declareHost,
    hostModerate,
    isVerifiedHost: !!selfVoiceId && room?.hostId?.() === selfVoiceId,
    getIdentity,
    rosterGate,
    getCapabilityGrant,
    setCapabilityGrant,
    getAgentAudit,
  }
}
