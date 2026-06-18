/**
 * Which `/api/turn` endpoint the ONLINE call fetches ICE/TURN credentials from
 * — the twin of signalConfig's signalHost, but for TURN + entitlement.
 *
 * Default: same-origin `/api/turn`, served by whatever hosts this build
 * (kibitz.chat, or a self-hosted / forked deployment that brings its own TURN
 * keys + entitlement KV). A host can override it via the `turnHost` mount option
 * to point at an INDEPENDENT TURN + billing provider on another origin — so "who
 * ships the client" and "who provides and bills TURN" can be different parties.
 *
 * The endpoint contract is open: `GET /api/turn`, optional
 * `Authorization: Bearer <licenseKey>`, → `{ iceServers }`. The server sends
 * CORS `*` (see functions/api/turn.ts), so a client on one origin can use a
 * provider on another. Set at mount time (before the call connects), exactly
 * like signalHost; the per-session ICE cache in iceConfig then reflects it.
 */

/** Pure builder (testable): the /api/turn URL for `host`, or the same-origin
 *  path when blank. Accepts a bare host (`turn.example.com`) or a full origin
 *  (`https://turn.example.com/`); scheme and trailing slashes are normalized. */
export function buildTurnEndpoint(host: string | null | undefined): string {
  const h = (host ?? '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '')
  return h ? `https://${h}/api/turn` : '/api/turn'
}

/** A forced TURN + entitlement host set by the `turnHost` mount option (e.g. an
 *  independent provider). null = same-origin `/api/turn` (the default). */
let forcedHost: string | null = null

export function setTurnHost(host: string | null): void {
  forcedHost = host && host.trim() ? host.trim() : null
}

/** The /api/turn URL to fetch right now — the configured provider, or
 *  same-origin when none was set. */
export function getTurnEndpoint(): string {
  return buildTurnEndpoint(forcedHost)
}

// NOTE: there is deliberately no URL-param ("?turn=<host>") path here. Letting a
// link silently point a joiner's relay at an arbitrary host would let a third
// party harvest the joiner's IP + connection metadata without consent. turnHost is
// only ever set in code (the mount option), by an embedder who owns both sides;
// sponsored "opener pays" goes through the signed room-grant (core/grant), which
// uses kibitz's OWN /api/turn. See functions/README.md and the security page.
