import { type Dispatch, type SetStateAction } from 'react'
import { saveBans } from '../react/bans'
import { addAllowedEmail } from '../core/identity'
import type { HostLobby } from '../react/useLobby'

// The host's moderation menu: verified-only toggle + guest allow-list, lobby/lock toggles, ban summary, and the
// knock queue (admit/deny). Purely presentational — all the state + the hostLobby moderation API live in the
// parent (Widget); this renders them. Extracted from Widget.tsx. The kw-* classes are global (shadow-rooted) —
// keep them verbatim. The `hostLobby.canGate && hostMenuOpen` guard stays at the call site.
export function HostToolsMenu({
  hostLobby,
  identityEnabled,
  requireVerified,
  setRequireVerified,
  guestEmails,
  setGuestEmails,
  guestInput,
  setGuestInput,
  bannedEmails,
  setBannedEmails,
  roomKey,
  onClose,
}: {
  hostLobby: HostLobby
  identityEnabled: boolean
  requireVerified: boolean
  setRequireVerified: Dispatch<SetStateAction<boolean>>
  guestEmails: string[]
  setGuestEmails: Dispatch<SetStateAction<string[]>>
  guestInput: string
  setGuestInput: Dispatch<SetStateAction<string>>
  bannedEmails: ReadonlySet<string>
  setBannedEmails: Dispatch<SetStateAction<ReadonlySet<string>>>
  roomKey: string
  onClose: () => void
}) {
  return (
    <div className="kw-hostmenu" role="dialog" aria-label="Host tools">
      <div className="kw-hostmenu-head">
        <span>Host tools</span>
        <button className="kw-hostmenu-x" onClick={onClose} aria-label="Close host tools">
          ✕
        </button>
      </div>
      {identityEnabled && (
        <>
          <button
            className={`kw-lobtoggle${requireVerified ? ' on' : ''}`}
            onClick={() => setRequireVerified((v) => !v)}
            aria-pressed={requireVerified}
            title={
              requireVerified
                ? 'Verified only — people must sign in; anyone unverified is removed. Tap to allow guests.'
                : 'Anyone can join (guests welcome). Tap to require a verified identity.'
            }
          >
            {requireVerified ? '🪪 Verified people only' : '🪪 Guests allowed'}
          </button>
          {requireVerified && (
            <div className="kw-guestlist">
              <p className="kw-guesthint">
                {guestEmails.length
                  ? 'Only these verified people can join:'
                  : 'Any verified person can join. Add emails to limit it to specific people.'}
              </p>
              {guestEmails.length > 0 && (
                <ul className="kw-guests">
                  {guestEmails.map((e) => (
                    <li key={e} className="kw-guestrow">
                      <span className="kw-guestmail" title={e}>
                        {e}
                      </span>
                      <button
                        className="kw-guestx"
                        onClick={() => setGuestEmails((l) => l.filter((x) => x !== e))}
                        aria-label={`Remove ${e} from the guest list`}
                        title={`Remove ${e}`}
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <form
                className="kw-guestadd"
                onSubmit={(ev) => {
                  ev.preventDefault()
                  setGuestEmails((l) => addAllowedEmail(l, guestInput))
                  setGuestInput('')
                }}
              >
                <input
                  className="kw-guestinput"
                  type="email"
                  value={guestInput}
                  onChange={(ev) => setGuestInput(ev.target.value)}
                  placeholder="add an email…"
                  aria-label="Add an email to the guest list"
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                />
                <button className="kw-guestaddbtn" type="submit">
                  Add
                </button>
              </form>
            </div>
          )}
        </>
      )}
      <div className="kw-host-row">
        <button
          className={`kw-lobtoggle${hostLobby.lobbyOn ? ' on' : ''}`}
          onClick={() => hostLobby.setLobby(!hostLobby.lobbyOn)}
          aria-pressed={hostLobby.lobbyOn}
          title={
            hostLobby.lobbyOn
              ? 'Lobby on — you approve who joins. Tap to let the link admit anyone.'
              : 'Anyone with the link joins. Tap to require your approval.'
          }
        >
          {hostLobby.lobbyOn ? '🔒 Approving joiners' : '🔓 Anyone with the link'}
        </button>
        <button
          className={`kw-lockbtn${hostLobby.locked ? ' on' : ''}`}
          onClick={() => hostLobby.setLocked(!hostLobby.locked)}
          aria-pressed={hostLobby.locked}
          title={
            hostLobby.locked
              ? 'Room locked — no one new can join (people here can still reconnect). Tap to unlock.'
              : 'Seal the room: no new people can join, even with the link.'
          }
        >
          {hostLobby.locked ? '🔐 Locked' : '🔐 Lock room'}
        </button>
        {/* No human "Reset/clear chat" button — chat is ephemeral (it vanishes when everyone
            leaves), so a wipe-the-scrollback control earned more confusion than value. The
            `resetRoom()` controller method stays for embedders who want to surface it. */}
      </div>
      {bannedEmails.size > 0 && (
        <div className="kw-banrow">
          <span title="People you removed are blocked from rejoining with that signed-in account">
            🚫 {bannedEmails.size} banned
          </span>
          <button
            className="kw-banclear"
            onClick={() => {
              setBannedEmails(new Set())
              saveBans(roomKey, new Set())
            }}
            title="Lift all bans for this room"
          >
            Clear
          </button>
        </div>
      )}
      {hostLobby.knocks.length > 0 && (
        <ul className="kw-knocks">
          {hostLobby.knocks.map((k) => (
            <li key={k.id} className="kw-knockrow">
              <span className="kw-knocker">
                <span aria-hidden="true">{k.avatar || '✋'}</span> {k.name || 'Guest'}
              </span>
              <button className="kw-admit" onClick={() => hostLobby.admit(k.id)} title={`Let ${k.name || 'them'} in`}>
                Admit
              </button>
              <button className="kw-deny" onClick={() => hostLobby.deny(k.id)} title="Refuse">
                Deny
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
