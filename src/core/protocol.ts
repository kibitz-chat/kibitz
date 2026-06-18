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

/**
 * Content sent PEER-TO-PEER over the data mesh (no authority relays it). The sender's
 * identity is the data connection's peer id, not anything in the payload — the
 * receiver attributes it from the roster, so a peer can't spoof another's name.
 * Directed delivery (`sendTo`) is done by sending only to one peer, not via a field.
 */
// `dm` marks a message that was sent to ONE recipient (via mesh.sendData) rather than
// broadcast — so the receiver can render it as private. It carries no recipient id:
// delivery already went only to that peer; the flag is purely for display.
export type ContentMsg =
  | { k: 'chat'; text: string; dm?: true }
  | { k: 'app'; data: unknown } // opaque shared-state (co-browse)
  | { k: 'pay'; label?: string; url: string; dm?: true } // a "pay me" link
  | { k: 'ink'; e: InkEvent; n?: string; c?: string } // shared pointer / annotation; n = mover's name, c = mover's colour (so it's the SAME for everyone, not re-derived per-receiver)
  | { k: 'idtoken'; jwt: string } // OIDC ID token, cert-bound (opt-in L3 identity)
  | { k: 'caps'; grants: Record<string, unknown> } // authority → all: per-peer capability grants
  | { k: 'schema'; name: string; version: string; schema: unknown } // app self-describes its `view` shape (agent discovery)

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
