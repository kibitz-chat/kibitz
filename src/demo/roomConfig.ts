// Load/save a verified-room setup as a small JSON file — the easiest way to author a big roster:
// write it once, keep it in version control, re-import it. Pure parse + validate + serialize (no
// DOM), so it's testable and reusable. Shape (everything optional except `access`):
//
//   {
//     "description": "Tuesday standup",
//     "access": "verified",                 // or "open"
//     "clientId": "…apps.googleusercontent.com",
//     "invitees": [                          // first entry = the host
//       { "name": "Alice", "method": "signin", "email": "alice@acme.com", "show": true },
//       { "name": "Anyone at Acme", "method": "oidc", "domain": "acme.com" },
//       { "name": "Carol", "method": "mail", "email": "carol@x.com" }
//     ]
//   }

export type ConfigMethod = 'oidc' | 'signin' | 'mail'
export type Access = 'open' | 'verified'

export interface RoomConfigInvitee {
  name?: string
  method: ConfigMethod
  /** email for signin/mail. */
  email?: string
  /** domain for oidc. */
  domain?: string
  /** reveal the email/domain in the pre-entry preview (default false). */
  show?: boolean
}

export interface RoomConfig {
  description?: string
  access: Access
  /** the room's Google sign-in app id (verified rooms). */
  clientId?: string
  /** the roster; the FIRST entry is the host. */
  invitees?: RoomConfigInvitee[]
}

const METHODS: ConfigMethod[] = ['oidc', 'signin', 'mail']
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

function parseInvitee(raw: unknown, i: number): RoomConfigInvitee {
  if (!raw || typeof raw !== 'object') throw new Error(`invitee ${i + 1} is not an object`)
  const o = raw as Record<string, unknown>
  const method = str(o.method).toLowerCase()
  if (!METHODS.includes(method as ConfigMethod)) throw new Error(`invitee ${i + 1}: method must be one of ${METHODS.join(', ')}`)
  const m = method as ConfigMethod
  const email = str(o.email).toLowerCase()
  const domain = str(o.domain).toLowerCase().replace(/^@/, '')
  if (m === 'oidc' && !domain) throw new Error(`invitee ${i + 1}: an OIDC entry needs a "domain"`)
  if ((m === 'signin' || m === 'mail') && !email) throw new Error(`invitee ${i + 1}: a ${m} entry needs an "email"`)
  return {
    ...(str(o.name) ? { name: str(o.name) } : {}),
    method: m,
    ...(email ? { email } : {}),
    ...(domain ? { domain } : {}),
    ...(o.show === true ? { show: true } : {}),
  }
}

/** Parse + validate a JSON room config. Returns the config or a human-readable error. */
export function parseRoomConfig(text: string): { ok: true; config: RoomConfig } | { ok: false; error: string } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, error: 'not valid JSON' }
  }
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'expected a JSON object' }
  const o = raw as Record<string, unknown>
  const access = str(o.access).toLowerCase()
  if (access !== 'open' && access !== 'verified') return { ok: false, error: 'access must be "open" or "verified"' }
  try {
    const invitees = Array.isArray(o.invitees) ? o.invitees.map(parseInvitee) : []
    if (access === 'verified' && invitees.length === 0) return { ok: false, error: 'a verified room needs at least one invitee' }
    return {
      ok: true,
      config: {
        ...(str(o.description) ? { description: str(o.description) } : {}),
        access: access as Access,
        ...(str(o.clientId) ? { clientId: str(o.clientId) } : {}),
        ...(invitees.length ? { invitees } : {}),
      },
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'invalid invitee' }
  }
}

/** Serialize a config to pretty JSON (for the Download button). */
export function roomConfigToJson(config: RoomConfig): string {
  return JSON.stringify(config, null, 2)
}

/** A starter template shown/downloaded as an example. */
export const SAMPLE_ROOM_CONFIG: RoomConfig = {
  description: 'Tuesday standup',
  access: 'verified',
  clientId: '…apps.googleusercontent.com',
  invitees: [
    { name: 'You', method: 'signin', email: 'you@acme.com' },
    { name: 'Anyone at Acme', method: 'oidc', domain: 'acme.com' },
    { name: 'Bob', method: 'signin', email: 'bob@acme.com', show: true },
  ],
}
