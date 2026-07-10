/**
 * The room's entire wire protocol. A room is a star: whoever claimed the room's
 * deterministic peer id is the AUTHORITY (it relays nothing media-related — media
 * is a separate p2p mesh — it only keeps the call roster and broadcasts it).
 */

/** One person currently in the call (broadcast to everyone in the room). */
export interface CallMember {
  /** The member's DEDICATED media peer id — what the mesh dials. */
  id: string
  name: string
  /** Camera currently on (drives video-vs-avatar in tiles; see mesh notes). */
  cam: boolean
  /** Emoji avatar shown (voice-reactive) while the camera is off; '' = initials. */
  avatar?: string
  /** Opaque per-participant metadata the host app attaches (e.g. seat, userId).
   *  Kibitz never reads it — it just rides the roster so every peer can map a
   *  participant to its own domain. Keep it SMALL; it's in every roster broadcast. */
  meta?: Record<string, unknown>
}

/** One chat line, as relayed by the authority. Ephemeral by construction:
 * it exists only in the open panels — there is no server that could store it. */
export interface ChatMessage {
  /** Sender's media peer id (matches the roster). */
  from: string
  name: string
  text: string
}

/**
 * A "pay me" request broadcast to the room — the recipient pays via the provider's
 * own rail (Stripe, PayPal, Lightning…). Kibitz only TRANSPORTS the link string and
 * never touches funds; `url` is shown to the payer (and validated) before opening.
 */
export interface PayRequest {
  /** Requester's media peer id (matches the roster). */
  from: string
  name: string
  /** Optional note — what it's for / how much (free text, e.g. "$20 for lunch"). */
  label?: string
  /** The payment link or URI (a web checkout URL, bitcoin:/lightning: URI, …). */
  url: string
  /** Sent privately to just you (not the whole room). */
  dm?: boolean
}

/**
 * An opaque application message, relayed verbatim between room peers — Kibitz
 * never inspects `data`. This is the seam embeds use for shared state that rides
 * the call's data channel (e.g. co-browse / follow-me: "everyone follows when one
 * person changes page"). Delivered to everyone EXCEPT the sender, so a broadcast
 * never echoes home.
 */
export interface AppMessage {
  /** Sender's media peer id (matches the roster) if they're a call member, else ''. */
  from: string
  /** Whatever the embed sent — structured-clone-able, never touched by Kibitz. */
  data: unknown
}

/**
 * A shared-annotation event over a presentation: a laser-pointer move, a freehand
 * draw point, or a clear. Coordinates are NORMALIZED (0..1) to the shared video's
 * CONTENT rect, so they land on the same spot on every viewer's screen regardless of
 * panel size / letterboxing. Ephemeral by construction — only the open panels hold it.
 */
export type InkEvent =
  | { k: 'ptr'; x: number; y: number } // laser pointer position (auto-coloured per person)
  | { k: 'draw'; sid: number; x: number; y: number; start?: boolean; color?: string } // a stroke point
  | { k: 'clear' } // wipe the SENDER's own strokes (not the whole board)
  // Bulk REPLAY of an image's doodle, keyed by the stage image. The stager (the painter that presents the image)
  // re-broadcasts it when the image is (re)shown or a new peer joins — so late joiners / cleared views get the
  // doodle too, not just whoever was present while it was drawn. `image` = the meta.stageImage content key.
  | { k: 'restore'; image: string; strokes: { color: string; pts: { x: number; y: number }[] }[] }

/**
 * Content sent PEER-TO-PEER over the data mesh (no authority relays it). The sender's
 * identity is the data connection's peer id, not anything in the payload — the
 * receiver attributes it from the roster, so a peer can't spoof another's name.
 * Directed delivery (`sendTo`) is done by sending only to one peer, not via a field.
 */
// `dm` marks a message that was sent to ONE recipient (via mesh.sendData) rather than
// broadcast — so the receiver can render it as private. It carries no recipient id:
// delivery already went only to that peer; the flag is purely for display.
/** A handler the engine's content registry invokes for ONE content kind, after the same roster/capability gate
 *  the engine applies to all content. `name` is the sender's resolved roster name (computed once by the engine).
 *  Lets a feature live as a self-contained module (e.g. useInk) instead of a branch in the engine's dispatch. */
export type ContentHandler = (from: string, c: ContentMsg, name: string) => void

export type ContentMsg =
  // A public/DM chat line. `mid` is a STABLE sender-assigned id (`${fromMediaId}#${senderSeq}`) and `ts` the
  // sender's wall-clock ms — together they let the public chat reconcile as the ORDERED UNION of everyone's
  // public lines on every roster change (late-joiner sync): authors re-broadcast their own public lines and
  // receivers MERGE (dedup by `mid`, order by `ts`). Both OPTIONAL for back-compat — a line from an old peer
  // carries neither, and the receiver assigns a fallback (`${from}#r${localSeq}`, ts = receive time). A `dm`
  // line is NEVER re-broadcast. New builds also send chat text via the xfer transfer below, which carries mid+ts too.
  //
  // `from`/`name` are set ONLY on REPLAYED HISTORY where the sender ISN'T the author — i.e. an agent that persisted
  // the room's prior transcript and re-injects it on rejoin (seedChatHistory). They name the ORIGINAL author so a
  // backfilled line shows who really said it, not the agent that re-broadcast it. A LIVE message omits them and the
  // receiver attributes it to the SENDER (the data-connection peer id), as today. SECURITY: this carried attribution
  // is DISPLAY-ONLY + UNVERIFIED — it MUST NOT confer any verified-identity treatment. Verified status is bound to a
  // live, cert-verified connection (keyed by the live peer id), never to a string a chat message carries, so a
  // replayed `from` can name anyone but can never forge a ✓ badge. In open rooms all names are already unverified.
  | { k: 'chat'; text: string; dm?: true; mid?: string; ts?: number; from?: string; name?: string }
  | { k: 'img'; mime: string; data: string; name?: string; w?: number; h?: number; dm?: true; mid?: string; ts?: number; from?: string; name2?: string } // LEGACY single-message inline image (base64, ≤one message). Still decoded; new builds send images via the xfer transfer. `mid`/`ts` give it a stable id + send time so the media reconciliation can dedup/order it like any public item; `from`/`name2` (replayed only) name the ORIGINAL author when re-broadcast on someone's behalf — DISPLAY-ONLY + UNVERIFIED. (`name2` not `name`, since `name` is the image's file name.)
  // Unified chunked CONTENT TRANSFER (text / image / file) — every piece of content rides the same
  // reliable+ordered mesh as a begin → chunks → end sequence, so a large file (or full-res image) is
  // split into bounded pieces and paced; small content is just a 1-chunk transfer. Additive: an old
  // peer ignores these kinds and is sent the legacy `chat`/`img` above instead.
  | { k: 'xbegin'; id: string; kind: 'text' | 'image' | 'file'; size: number; n: number; mime?: string; name?: string; offer?: true; dm?: true; mid?: string; ts?: number; author?: string; authorName?: string } // begin: total bytes `size`, chunk count `n`. `offer:true` = a PULL transfer (download tier): the sender holds the chunks until the receiver returns `xaccept` (the receiver picks a disk location first); a peer without the feature just ignores `offer` and is never sent this for an over-quota file. `mid`/`ts` (TEXT transfers only) carry the stable chat id + sender wall-clock so a reconciled public line merges/dedups like a `k:'chat'` one. `author`/`authorName` (TEXT replayed-history only, same role as chat's `from`/`name`) name the ORIGINAL author when the sender re-broadcast someone else's line — DISPLAY-ONLY + UNVERIFIED, never a verified badge.
  | { k: 'xaccept'; id: string; dm?: true } // receiver → sender: I chose a save location, start streaming transfer `id` (answers an `offer`)
  | { k: 'xdecline'; id: string; dm?: true } // receiver → sender: I declined / cancelled the save dialog for `id` (the sender drops the pending offer)
  | { k: 'xresume'; id: string; have: number; dm?: true } // receiver → sender: a (disk) transfer stalled; I have `have` chunks — re-stream `id` from there (the sender retains the source until acked)
  | { k: 'xack'; id: string; dm?: true } // receiver → sender: transfer `id` fully received — release the retained source
  | { k: 'xchunk'; id: string; i: number; data?: string; bytes?: Uint8Array; dm?: true } // chunk `i` of transfer `id`: base64 `data` (xfer.v1) OR raw `bytes` (xfer.v2 binary frame — never JSON-serialized; the decoded form of a binary mesh message)
  | { k: 'xend'; id: string; hash?: string; dm?: true } // transfer `id` fully sent; optional SHA-256 hex of the payload (xfer integrity — a receiver with the feature verifies + fails on mismatch; old peers ignore it)
  | { k: 'xcancel'; id: string; dm?: true } // transfer `id` aborted (either side)
  | { k: 'app'; data: unknown } // opaque shared-state (co-browse)
  | { k: 'pay'; label?: string; url: string; dm?: true } // a "pay me" link
  | { k: 'ink'; e: InkEvent; n?: string; c?: string } // shared pointer / annotation; n = mover's name, c = mover's colour (so it's the SAME for everyone, not re-derived per-receiver)
  | { k: 'idtoken'; jwt: string } // OIDC ID token, cert-bound (opt-in L3 identity)
  | { k: 'caps'; grants: Record<string, unknown> } // authority → all: per-peer capability grants
  | { k: 'schema'; name: string; version: string; schema: unknown } // app self-describes its `view` shape (agent discovery)
  | { k: 'ledger'; m: unknown } // room-state ledger CRDT sync (docs/room-state-ledger.md) — `m` is a LedgerMsg; opaque to apps (demuxed in useCall, never surfaced via onMessage)
  | { k: 'chatledger'; m: unknown } // unified-room-sync chat CRDT (docs/unified-room-sync.md) — a SECOND ledger channel carrying the chat union (media as hash refs), separate from `ledger`; `m` is a LedgerMsg, opaque to apps
  | { k: 'ctl'; m: unknown } // ephemeral control signals (a viewer asking the presenter to play/pause a staged clip; the presenter broadcasting its allow/playing state) — opaque to apps, demuxed in useCall
  // A BOUNDED interactive widget posted into the room (e.g. a map an agent shows). `kind` selects a FIRST-PARTY
  // renderer that ships in this bundle (the model/poster only supplies validated `data` — never code), `id` is the
  // instance, `data` is the renderer's payload. `replay` carries the accumulated `wevt` events (the shared overlay,
  // e.g. a map's pins) so shared interactions survive a join — sent when the widget is re-broadcast to (re)joiners.
  // `removed:true` retracts a previously-posted instance `id` (the owner pulls it back — e.g. a media that failed
  // to render): kind/data are empty and receivers drop the instance everywhere (chat + stage).
  //
  // `from`/`name` are set ONLY on a REPLAYED widget where the sender ISN'T the original poster — every participant
  // re-broadcasts the WHOLE public widget set it holds on a roster change (persistent room), so a departed poster's
  // widget is carried by anyone present. They name the ORIGINAL poster so the bubble shows who posted it, not the
  // peer that re-broadcast it. A live post / an owner's own re-broadcast omits them → attributed to the SENDER.
  // SECURITY: DISPLAY-ONLY + UNVERIFIED — the widget bubble renders a plain name with no identity lookup; a verified
  // ✓ is bound to the live cert-verified connection (keyed by the live peer id), which this field can never touch.
  // `ts` is the poster's send time (wall-clock ms), stamped like a text/media line so the widget's chat line is
  // ORDERED consistently with the rest of the public chat — a re-synced widget lands at its original position.
  | { k: 'widget'; id: string; kind: string; data: unknown; replay?: unknown[]; removed?: boolean; from?: string; name?: string; ts?: number }
  // An INTERACTION with widget instance `id` (e.g. a viewer dropping a pin on a map) — broadcast so the overlay is
  // shared by everyone. The instance owner (whoever posted the `widget`) retains these and replays them to late
  // joiners. `e` is opaque here; the bounded renderer for the widget's `kind` defines the event shape.
  | { k: 'wevt'; id: string; e: unknown }

/** Participant → authority. */
export type ClientWire =
  | {
      t: 'voice'
      on: boolean
      cam: boolean
      name: string
      avatar?: string
      /** Dedicated media peer id (present when on). */
      voiceId?: string
      /** Stable per-tab token so a reconnect replaces our old entry (no dupes). */
      token?: string
      /** Opaque host-app metadata (seat, userId…) — relayed in the roster, unread. */
      meta?: Record<string, unknown>
      /** Opt-in: a cert-bound OIDC ID token. When the room requires verified identity,
       *  the authority verifies this (signature + bound to OUR presence cert + domain)
       *  BEFORE admitting us — so an unverified peer never enters the roster. */
      jwt?: string
      /** Opt-in: an AI agent's cert-bound key assertion (see agentKey.ts). The authority
       *  verifies it against the room's allow-list (signature + bound to OUR presence cert)
       *  before admitting — so an agent enters by its OWN key, with no human in the loop. */
      agentAssertion?: string
      /** Opt-in: a short-lived (~1 min) signed "credit credential" from a trusted issuer
       *  proving a declared agent has paid for network presence. When a room requires it,
       *  the authority verifies it (signature + expiry + issuer) against the issuer's JWKS
       *  and re-checks on each announce; an agent whose credential lapses is dropped. The
       *  agent re-sends a fresh one ~every minute via setAgentCredit(). Default OFF. */
      agentCredit?: string
    }
  // NOTE: chat / pay / ink / co-browse are NOT here — content travels PEER-TO-PEER over
  // the data mesh (see ContentMsg + core/mesh), so the authority never relays it. The
  // authority handles only presence / coordination below.
  | { t: 'ping' } // liveness beacon (so the authority can reap silent peers)
  | { t: 'leave' }
  // "Knock" — sent on connect so the authority can gate entry when the lobby is on.
  // Carries the would-be name/avatar (self-asserted) the host sees before admitting,
  // the stable token so a previously-admitted identity is re-admitted silently, and
  // our media id once we're in the call so a NEW authority (after a host migration)
  // can grandfather us back into the call it inherited instead of re-gating us.
  | { t: 'knock'; name: string; avatar?: string; token?: string; voiceId?: string; jwt?: string; agentAssertion?: string; agentCredit?: string }
  // A signed moderation command from the verified HOST (claim/admit/deny/lock/unlock/reset/kick). The
  // `token` is a cert-bound, room-bound, fresh ECDSA assertion the coordinator verifies against the
  // link-committed host PUBLIC key before enacting — so admin is bound to the host key, not to who
  // holds the room id. Rejected outright when no host key is committed. See core/hostKey.ts.
  | { t: 'mod'; token: string }

/** Authority → participant. */
export type AuthorityWire =
  // `lobby` rides the roster so every client knows the admit-gate is on, and a peer
  // that becomes the next authority (migration) can re-apply the setting. `host` is
  // the authority's own media id, so every client can label who the host is. `locked`
  // seals the room — no NEW members get in (existing ones may still reconnect).
  | { t: 'roster'; members: CallMember[]; lobby?: boolean; host?: string; locked?: boolean }
  // (No chat/pay/ink/app here either — content is peer-to-peer over the data mesh.)
  | { t: 'ping' } // liveness beacon (so participants notice a dead authority)
  // Lobby status for a knocker: waiting for the host, admitted, refused, turned away
  // because the room is locked (sealed to new members), or refused because the room
  // requires a verified identity we haven't proven ('unverified').
  | { t: 'lobby'; status: 'waiting' | 'admitted' | 'denied' | 'locked' | 'unverified' }
  // You were removed from the room by the host — your client leaves, and the host
  // blocks your token/media id from rejoining (see room.ts `remove`).
  | { t: 'kick' }
  // The host reset the room — clients clear their ephemeral chat + annotations.
  | { t: 'reset' }
