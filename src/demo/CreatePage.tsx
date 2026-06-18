import { useEffect, useRef, useState } from 'react'
import type { AgentEntry, VerifyMethod } from '../core/roomManifest'
import type { Grant } from '../core/capabilities'
import { getLicenseKey, setLicenseKey } from '../core/license'
import { getRelayOnly, setRelayOnly } from '../core/relayPref'
import { withGateFragment } from '../core/joinGateLink'
import { parseRoomConfig, roomConfigToJson, type RoomConfig, type RoomConfigInvitee } from './roomConfig'

// The "Set up your room" page — shown after "Start a room", BEFORE the room exists. Pick an
// optional description + WHO CAN JOIN, then create ONE GLOBAL link (docs/verification.md). The
// "Verified participants" option commits a PER-INVITEE roster into the link: each participant (the room
// creator included) verifies by their own method — Sign in (a specific email), OIDC (any verified
// account at a domain), or Email code (a mailed code; backend pending, shown but inert). Heavy
// crypto/room builders are LAZY-imported in the handler so the prerender stays browser-free.

type RoomMethod = 'open' | 'verified'
interface Row {
  name: string
  method: VerifyMethod
  email: string
  domain: string
  show: boolean
}
const emptyRow = (): Row => ({ name: '', method: 'signin', email: '', domain: '', show: false })

const METHOD_OPTS: { id: VerifyMethod; label: string; disabled?: boolean }[] = [
  { id: 'oidc', label: 'OIDC' },
  { id: 'signin', label: 'Sign in' },
  { id: 'mail', label: 'Email code' },
]

const rowValid = (r: Row) => (r.method === 'oidc' ? !!r.domain.trim() : !!r.email.trim())
const rowFilled = (r: Row) => !!(r.email.trim() || r.domain.trim() || r.name.trim())

export function CreatePage({
  initialDesc,
  googleClientId,
  onCancel,
}: {
  initialDesc?: string
  googleClientId?: string
  onCancel: () => void
}) {
  const [desc, setDesc] = useState(initialDesc ?? '')
  const [method, setMethod] = useState<RoomMethod>('open')
  // Layer 2 (privacy): an optional out-of-band passphrase that SEALS the roster in the link, so a
  // link-holder without it (and the host) can't read who's invited. Share it with the group
  // separately (not in the link). Joiners enter it to unlock the roster before verifying.
  const [passphrase, setPassphrase] = useState('')
  // Room admin (host). Four tiers:
  //  • 'none'     — no moderation at all (a fully open room).
  //  • 'name'     — SOFT host: commit a name; whoever joins under it is the host. No crypto, spoofable by
  //                 link-holders; great for "I'm first in, wait for the AI agent, then admit everyone".
  //                 Pairs with a waiting room ON by default.
  //  • 'oidc'     — STRONG + PORTABLE host: commit a verified EMAIL + a Google client id; the host signs in
  //                 to prove it. Un-spoofable, works on any device. Needs a Google OAuth client id.
  //  • 'password' — STRONG host: a host key sealed under a password; un-spoofable, moderates from any seat.
  const [hostTier, setHostTier] = useState<'none' | 'name' | 'oidc' | 'password'>('none')
  const [hostName, setHostName] = useState('') // the soft-host display name
  const [hostEmail, setHostEmail] = useState('') // the OIDC-host verified email
  const [hostPassword, setHostPassword] = useState('') // the strong-host password
  const [hostLobbyStart, setHostLobbyStart] = useState(true) // soft host: start with a waiting room
  const [creator, setCreator] = useState<Row>(emptyRow())
  const [rows, setRows] = useState<Row[]>([])
  // Pre-authorized AI agents: each has a generated keypair. The PUBLIC key is committed into the
  // room's manifest (allow-list); the PRIVATE key is shown ONCE for you to paste into your agent.
  // Watch-only by default; "can act" grants chat/act for an agent-only / collaboration room.
  const [agents, setAgents] = useState<{ pub: JsonWebKey; thumb: string; label: string; canAct: boolean }[]>([])
  const [revealPriv, setRevealPriv] = useState<string | null>(null) // the just-minted private JWK to copy
  const [clientId, setClientId] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // Friendly by default: the page shows just a description + Create (which makes an OPEN room — anyone
  // with the link). Everything else is tucked under Advanced so it isn't a scary wall of options.
  const [advancedOpen, setAdvancedOpen] = useState(false)
  // Premium relay (opener-pays): a license key held in THIS browser. When set, the room page's
  // Copy-link mints a signed grant into the invite so guests get a sponsored relay (core/grant).
  const [premKey, setPremKey] = useState(() => getLicenseKey() ?? '')
  const [premSaved, setPremSaved] = useState(() => !!getLicenseKey())
  const [premOpen, setPremOpen] = useState(false)
  // Privacy: route YOUR media/data through the TURN relay so peers see the relay's IP, not yours. A
  // per-browser preference (not a room setting), applied to the call you're about to enter.
  const [relayOnly, setRelayOnlyState] = useState(getRelayOnly)
  const savePrem = () => {
    const k = premKey.trim()
    setLicenseKey(k || null)
    setPremSaved(!!k)
  }
  // The room's Google sign-in app id. Use the site's if it's already configured; otherwise the
  // host pastes it once here and it rides in the link (it's public — safe to share).
  const effClientId = (googleClientId || clientId).trim()

  // Match the landing's warm paper theme (the palette vars live under body.paper).
  useEffect(() => {
    document.body.classList.add('paper')
    return () => document.body.classList.remove('paper')
  }, [])

  const setRow = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const addRow = () => setRows((rs) => [...rs, emptyRow()])
  const removeRow = (i: number) => setRows((rs) => rs.filter((_, j) => j !== i))
  const toInput = (r: Row) => ({ method: r.method, email: r.email, domain: r.domain, name: r.name, show: r.show })

  // --- JSON config: load a roster from a file, or download the current one ---------------------
  const fileRef = useRef<HTMLInputElement>(null)
  const inviteeToRow = (inv: RoomConfigInvitee): Row => ({
    name: inv.name ?? '',
    method: inv.method,
    email: inv.email ?? '',
    domain: inv.domain ?? '',
    show: !!inv.show,
  })
  const rowToInvitee = (r: Row): RoomConfigInvitee => ({
    ...(r.name.trim() ? { name: r.name.trim() } : {}),
    method: r.method,
    ...(r.method === 'oidc'
      ? { domain: r.domain.trim().toLowerCase().replace(/^@/, '') }
      : { email: r.email.trim().toLowerCase() }),
    ...(r.show ? { show: true } : {}),
  })
  const applyConfig = (c: RoomConfig) => {
    setErr(null)
    setDesc(c.description ?? '')
    setMethod(c.access)
    if (c.clientId && !googleClientId) setClientId(c.clientId)
    const invs = c.invitees ?? []
    setCreator(invs[0] ? inviteeToRow(invs[0]) : emptyRow())
    setRows(invs.slice(1).map(inviteeToRow))
  }
  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    e.target.value = '' // allow re-picking the same file
    if (!f) return
    const r = parseRoomConfig(await f.text())
    if (!r.ok) setErr(`Couldn't load that file: ${r.error}`)
    else applyConfig(r.config)
  }
  const buildConfig = (): RoomConfig => ({
    ...(desc.trim() ? { description: desc.trim() } : {}),
    access: method,
    ...(effClientId ? { clientId: effClientId } : {}),
    ...(method === 'verified' ? { invitees: [creator, ...rows].filter((r) => (r.method === 'oidc' ? r.domain.trim() : r.email.trim())).map(rowToInvitee) } : {}),
  })
  const download = () => {
    const blob = new Blob([roomConfigToJson(buildConfig())], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${(desc.trim() || 'kibitz-room').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'kibitz-room'}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  // Mint a fresh agent keypair: commit the public key to the room, reveal the private key ONCE so
  // you can paste it into the agent. Heavy crypto is lazy-imported (keeps the prerender browser-free).
  const genAgent = async () => {
    setErr(null)
    try {
      const { generateAgentKeypair, exportAgentPublicKey, exportAgentPrivateKey, agentKeyThumbprint } = await import('../core/agentKey')
      const kp = await generateAgentKeypair()
      const pub = await exportAgentPublicKey(kp.publicKey)
      const priv = await exportAgentPrivateKey(kp.privateKey)
      const thumb = await agentKeyThumbprint(pub)
      setAgents((a) => [...a, { pub, thumb, label: '', canAct: false }])
      setRevealPriv(JSON.stringify(priv))
    } catch {
      setErr('Could not generate an agent key.')
    }
  }
  const patchAgent = (i: number, p: Partial<(typeof agents)[number]>) => setAgents((a) => a.map((x, j) => (j === i ? { ...x, ...p } : x)))
  const removeAgent = (i: number) => setAgents((a) => a.filter((_, j) => j !== i))
  // An agent that "can act" gets chat + act on top of the watch-only default; else caps are omitted
  // (the authority applies the perceive-only default). The watch-only perceives are the agent default.
  const actingCaps: Grant = { perceive: ['read-chat', 'read-roster', 'receive-directed'], act: ['send-chat', 'act'] }

  const create = async () => {
    setErr(null)
    if (method === 'verified') {
      if (!effClientId) {
        setErr('Paste your Google sign-in app id (…apps.googleusercontent.com).')
        return
      }
      if (!rowValid(creator)) {
        setErr(creator.method === 'oidc' ? 'Enter a domain for your own line.' : 'Enter your own email.')
        return
      }
      for (const r of rows) {
        if (rowFilled(r) && !rowValid(r)) {
          setErr('Each person needs an email (or a domain for OIDC) — fill it in or remove the empty row.')
          return
        }
      }
    }
    setBusy(true)
    try {
      const [{ freshRoom }, { buildVerifiedRoster }] = await Promise.all([
        import('./roomName'),
        import('../core/joinGateRuntime'),
      ])
      // The room id is ALWAYS a fresh, un-guessable code — the typed text is only a description.
      const room = freshRoom()
      const base = `${location.origin}/#${room}`
      let link = base
      if (method === 'verified') {
        const all = [creator, ...rows].filter(rowValid).map(toInput)
        const exp = Math.floor(Date.now() / 1000) + 7 * 86400
        const agentKeys: AgentEntry[] | undefined = agents.length
          ? agents.map((a) => ({
              key: a.pub,
              ...(a.label.trim() ? { label: a.label.trim() } : {}),
              ...(a.canAct ? { caps: actingCaps } : {}),
            }))
          : undefined
        link = (await buildVerifiedRoster(base, room, all, effClientId, exp, passphrase.trim() || undefined, agentKeys)).roomLink
      }
      // Room admin (host) — commit the chosen tier into the link fragment.
      const hp = hostPassword.trim()
      const hn = hostName.trim()
      if (hostTier === 'password' && hp) {
        // STRONG: mint a host keypair, seal the private half under the password; commit gh (public) + ghk
        // (sealed private). Whoever enters the password claims admin and moderates from any seat.
        const [{ generateHostKeypair, exportHostPublicKey, exportHostPrivateKey, sealHostKey }, { encodeGateParams }] =
          await Promise.all([import('../core/hostKey'), import('../core/joinGateLink')])
        const kp = await generateHostKeypair()
        const pub = await exportHostPublicKey(kp.publicKey)
        const sealed = await sealHostKey(await exportHostPrivateKey(kp.privateKey), hp)
        link = withGateFragment(link, encodeGateParams({ mode: 'open', hostPubKey: pub, hostKeySealed: sealed }))
      } else if (hostTier === 'name' && hn) {
        // SOFT: commit the host NAME (ghn) and optionally start with a waiting room (gl). No crypto.
        const { encodeGateParams } = await import('../core/joinGateLink')
        link = withGateFragment(link, encodeGateParams({ mode: 'open', hostName: hn, lobbyOnStart: hostLobbyStart }))
      } else if (hostTier === 'oidc' && hostEmail.trim() && clientId.trim()) {
        // OIDC: commit the host EMAIL (gho) + the Google client id (gc). The host signs in to prove it;
        // the room stays open (no admission gate) — only admin is gated to the verified email.
        const { encodeGateParams } = await import('../core/joinGateLink')
        link = withGateFragment(
          link,
          encodeGateParams({ mode: 'open', hostEmail: hostEmail.trim(), clientId: clientId.trim() }),
        )
      }
      const d = desc.trim()
      // Ride the description in the FRAGMENT too (host-private), alongside any gate params.
      if (d) link = withGateFragment(link, new URLSearchParams({ d: d.slice(0, 80) }))
      // One global link — go to it. A verified-roster link shows the roster preview first.
      location.assign(link)
    } catch {
      setErr('Could not create the room. Try again.')
      setBusy(false)
    }
  }

  const renderRow = (r: Row, onChange: (p: Partial<Row>) => void, onRemove?: () => void) => (
    <div className="cp-rrow">
      <input className="cp-rname" value={r.name} onChange={(e) => onChange({ name: e.target.value })} placeholder="Name" autoCapitalize="words" />
      <select className="cp-rmethod" value={r.method} onChange={(e) => onChange({ method: e.target.value as VerifyMethod })}>
        {METHOD_OPTS.map((m) => (
          <option key={m.id} value={m.id} disabled={m.disabled}>
            {m.label}
          </option>
        ))}
      </select>
      {r.method === 'oidc' ? (
        <input
          className="cp-remail"
          value={r.domain}
          onChange={(e) => onChange({ domain: e.target.value })}
          placeholder="acme.com"
          autoCapitalize="off"
          spellCheck={false}
        />
      ) : (
        <input
          className="cp-remail"
          value={r.email}
          onChange={(e) => onChange({ email: e.target.value })}
          placeholder="alice@acme.com"
          inputMode="email"
          autoCapitalize="off"
          spellCheck={false}
        />
      )}
      <label className="cp-rshow" title="Reveal this email/domain in the roster everyone sees before joining">
        <input type="checkbox" checked={r.show} onChange={(e) => onChange({ show: e.target.checked })} />
        show
      </label>
      {onRemove ? (
        <button type="button" className="cp-rdel" onClick={onRemove} aria-label="Remove">
          ✕
        </button>
      ) : (
        <span />
      )}
    </div>
  )

  return (
    <main className="createpage">
      <div className="cp-card">
        <button type="button" className="cp-back" onClick={onCancel}>
          ← Back
        </button>
        <h1 className="cp-h">Set up your room</h1>

        <label className="cp-label" htmlFor="cp-desc">
          Room description <span>(optional)</span>
        </label>
        <input
          id="cp-desc"
          className="cp-name"
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          placeholder="e.g. Tuesday standup"
          maxLength={80}
          autoComplete="off"
          spellCheck={false}
        />

        <button
          type="button"
          className="cp-adv-h"
          aria-expanded={advancedOpen}
          onClick={() => setAdvancedOpen((o) => !o)}
        >
          <span>
            ⚙️ Advanced <em>(who can join · AI agents · premium)</em>
          </span>
          <span className="cp-prem-caret">{advancedOpen ? '▾' : '▸'}</span>
        </button>
        {advancedOpen && (
          <div className="cp-adv-body">
        <div className="cp-io">
          <button type="button" className="cp-iobtn" onClick={() => fileRef.current?.click()}>
            📁 Load from file
          </button>
          <button type="button" className="cp-iobtn" onClick={download}>
            ⬇ Download config
          </button>
          <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={onFile} />
        </div>

        <p className="cp-q">Room admin (host)?</p>
        <div className="cg-methods">
          {(['none', 'name', 'oidc', 'password'] as const).map((id) => (
            <button
              type="button"
              key={id}
              className={`cg-chip${hostTier === id ? ' on' : ''}`}
              aria-pressed={hostTier === id}
              onClick={() => {
                setHostTier(id)
                setErr(null)
              }}
            >
              {id === 'none' ? 'No admin' : id === 'name' ? 'Host by name' : id === 'oidc' ? 'Host by Google' : 'Host password'}
            </button>
          ))}
        </div>
        <p className="cg-blurb">
          {hostTier === 'none'
            ? 'No one can moderate — a fully open room.'
            : hostTier === 'name'
              ? 'You declare yourself host by name. Whoever joins under that name is the host (no password). Anyone with the link could claim it, so it’s for trust-friendly rooms — ideal for letting an AI agent in first, then admitting everyone.'
              : hostTier === 'oidc'
                ? 'You’re host by your verified Google email — sign in to claim admin. Can’t be spoofed, and works on any device (just sign in again). The room itself stays open; only admin is gated to your email. Needs a Google OAuth client id.'
                : 'A host password unlocks moderation and can’t be spoofed. Whoever knows it can claim admin from any seat. It rides the public link, so use a strong passphrase.'}
        </p>

        {hostTier === 'name' && (
          <>
            <label className="cp-label" htmlFor="cp-hostname">
              Your name <span>(as host)</span>
            </label>
            <input
              id="cp-hostname"
              className="cp-name"
              value={hostName}
              onChange={(e) => setHostName(e.target.value)}
              placeholder="e.g. Alex"
              autoCapitalize="words"
              spellCheck={false}
            />
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                marginTop: 10,
                fontSize: '0.95rem',
                color: 'var(--pdim)',
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={hostLobbyStart}
                onChange={(e) => setHostLobbyStart(e.target.checked)}
                style={{ width: 18, height: 18, flex: 'none' }}
              />
              <span>Start with a waiting room (admit the agent first, then everyone)</span>
            </label>
          </>
        )}

        {hostTier === 'oidc' && (
          <>
            <label className="cp-label" htmlFor="cp-hostemail">
              Your verified email <span>(host)</span>
            </label>
            <input
              id="cp-hostemail"
              className="cp-name"
              type="email"
              value={hostEmail}
              onChange={(e) => setHostEmail(e.target.value)}
              placeholder="you@example.com"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
            />
            <label className="cp-label" htmlFor="cp-hostcid">
              Google client id <span>(public — rides the link)</span>
            </label>
            <input
              id="cp-hostcid"
              className="cp-name"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder="723848163510-…apps.googleusercontent.com"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
            />
            <p className="cg-fine">
              You become host by signing in with Google as that exact email — <strong>un-spoofable</strong> and works on
              any device. The room stays open to everyone; only admin is gated to you. Needs a Google OAuth client id
              (it’s public).{' '}
              <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer">
                Get one →
              </a>
            </p>
          </>
        )}

        {hostTier === 'password' && (
          <>
            <label className="cp-label" htmlFor="cp-hostpw">
              Host password
            </label>
            <input
              id="cp-hostpw"
              className="cp-name"
              type="password"
              value={hostPassword}
              onChange={(e) => setHostPassword(e.target.value)}
              placeholder="a passphrase that claims admin (kick · lock · lobby)"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
            />
            <p className="cg-fine">
              Whoever knows it can <strong>claim admin</strong> — admit/deny at the door, lock the room, remove someone,
              reset. It rides the public link, so a weak one can be guessed offline — use a strong{' '}
              <strong>passphrase</strong>.
            </p>
          </>
        )}

        <p className="cp-q">Who can join?</p>
        <div className="cg-methods">
          {(['open', 'verified'] as RoomMethod[]).map((id) => (
            <button
              type="button"
              key={id}
              className={`cg-chip${method === id ? ' on' : ''}`}
              aria-pressed={method === id}
              onClick={() => {
                setMethod(id)
                setErr(null)
              }}
            >
              {id === 'open' ? 'Anyone with the link' : 'Verified participants'}
            </button>
          ))}
        </div>
        <p className="cg-blurb">
          {method === 'open'
            ? 'Whoever opens the link is in. The link itself is the key, so keep it private.'
            : 'One link commits a roster; each participant (you included) verifies by their own method before entering. Only listed, verified participants get in — people or AI agents.'}
        </p>

        {method === 'verified' && !googleClientId && (
          <div className="cp-signapp">
            <label className="cp-label" htmlFor="cp-cid">
              Sign-in app <span>(Google client id — paste once)</span>
            </label>
            <input
              id="cp-cid"
              className="cp-name"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder="723848163510-…apps.googleusercontent.com"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
            />
            <p className="cg-fine">
              Verification runs through Google sign-in. Paste your Google app’s client id — it’s public, rides safely in
              the link, and you only do this once.{' '}
              <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer">
                Get one →
              </a>
            </p>
          </div>
        )}

        {method === 'verified' && (
          <div className="cp-roster">
            <div className="cp-roster-head">
              <span>Person</span>
              <span>Verifies by</span>
              <span>Email / domain</span>
              <span>In&nbsp;link</span>
              <span />
            </div>
            {renderRow(creator, (p) => setCreator((c) => ({ ...c, ...p })))}
            {rows.map((r, i) => (
              <div key={i}>{renderRow(r, (p) => setRow(i, p), () => removeRow(i))}</div>
            ))}
            <button type="button" className="cp-radd" onClick={addRow}>
              + Add person
            </button>
            <p className="cg-fine">
              <strong>Sign in:</strong> only that exact verified email (Google). <strong>OIDC:</strong> any verified
              account at a domain (Google). <strong>Email code:</strong> a one-time code mailed to that address (no
              account needed). <strong>“In link”</strong> reveals the email/domain in the roster everyone sees before
              joining (off = hidden).
            </p>

            <label className="cp-label" htmlFor="cp-pass">
              Lock the roster with a shared secret <span>(optional)</span>
            </label>
            <input
              id="cp-pass"
              className="cp-name"
              type="password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              placeholder="a passphrase you share with the group separately"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
            />
            <p className="cg-fine">
              When set, the invite link carries the roster <strong>encrypted</strong> — neither the host nor anyone who
              just has the link can read who’s invited. Share this secret with your people through another channel (not
              in the link); they enter it once to unlock. Make it strong — a weak secret can be guessed.
            </p>

            <label className="cp-label">
              AI agents <span>(optional)</span>
            </label>
            {agents.map((a, i) => (
              <div className="cp-rrow" key={i}>
                <input
                  className="cp-rname"
                  value={a.label}
                  onChange={(e) => patchAgent(i, { label: e.target.value })}
                  placeholder="agent name (e.g. notes-bot)"
                />
                <code className="cp-rmethod" title="agent key id (thumbprint)" style={{ overflow: 'hidden', textOverflow: 'ellipsis', fontSize: '0.8em', opacity: 0.7 }}>
                  {a.thumb.slice(0, 10)}…
                </code>
                <label className="cp-rshow" title="Let this agent speak/chat (default: watch-only)">
                  <input type="checkbox" checked={a.canAct} onChange={(e) => patchAgent(i, { canAct: e.target.checked })} />
                  can&nbsp;act
                </label>
                <button type="button" className="cp-rdel" onClick={() => removeAgent(i)} aria-label="Remove">
                  ✕
                </button>
              </div>
            ))}
            <button type="button" className="cp-radd" onClick={genAgent}>
              + Generate agent key
            </button>
            {revealPriv && (
              <div className="cp-agent-priv">
                <p className="cg-fine">
                  🔑 <strong>Give this private key to your agent</strong> — shown once, never stored. The room keeps only
                  the matching public key.
                </p>
                <textarea
                  readOnly
                  rows={3}
                  className="cp-name"
                  style={{ fontFamily: 'monospace', fontSize: '0.75em', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}
                  value={revealPriv}
                  onFocus={(e) => e.currentTarget.select()}
                />
                <div className="cp-io">
                  <button type="button" className="cp-iobtn" onClick={() => void navigator.clipboard?.writeText(revealPriv)}>
                    📋 Copy private key
                  </button>
                  <button type="button" className="cp-iobtn" onClick={() => setRevealPriv(null)}>
                    Done
                  </button>
                </div>
              </div>
            )}
            <p className="cg-fine">
              An AI agent enters by its <strong>own key</strong> — no human sign-in. It’s <strong>watch-only</strong> by
              default; tick “can act” to let it chat/act (for an agent-only or collaboration room). Only the public key
              rides the link; the private key stays with the agent.
            </p>
          </div>
        )}

        <label className="cp-relay">
          <input
            type="checkbox"
            checked={relayOnly}
            onChange={(e) => {
              setRelayOnly(e.target.checked)
              setRelayOnlyState(e.target.checked)
            }}
          />
          <span className="cp-relay-txt">
            🛡️ Hide my IP from other people <em>(route through the relay)</em>
          </span>
        </label>
        <p className="cg-fine">
          Personal to this browser. When on, your media + data go through the TURN relay, so other participants see
          the relay’s IP — not yours. The relay (and the room host) still see your IP, and it can add a little latency,
          but it can’t read your end-to-end-encrypted media or messages.
        </p>

        <div className="cp-prem">
          <button
            type="button"
            className="cp-prem-h"
            aria-expanded={premOpen}
            onClick={() => setPremOpen((o) => !o)}
          >
            <span>
              ⚡ Premium <em>(optional)</em>
              {premSaved ? ' · ✓ saved' : ''}
            </span>
            <span className="cp-prem-caret">{premOpen ? '▾' : '▸'}</span>
          </button>
          {premOpen && (
            <div className="cp-prem-body">
              <p className="cg-fine">
                Sponsor your room’s infrastructure for everyone you invite — a relay that connects on tough networks,
                plus reliable verification emails when your room uses email-code. One key covers both: the invite link
                carries a signed grant tied to your key, and your key never leaves this browser. Calls already work for
                free without a key (direct, plus a free relay fallback); a key just adds the sponsored path.
                <br />
                <em>Beta: premium keys are issued by request — there’s no self-serve checkout yet.</em>
              </p>
              <div className="cp-prem-row">
                <input
                  className="cp-name"
                  value={premKey}
                  onChange={(e) => {
                    setPremKey(e.target.value)
                    setPremSaved(false)
                  }}
                  placeholder="paste premium key"
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  aria-label="Premium key"
                />
                <button type="button" className="cp-prem-save" onClick={savePrem}>
                  Save
                </button>
              </div>
              {premSaved && (
                <p className="cp-prem-ok">✓ Premium key saved — guests you invite get a sponsored relay + verification emails.</p>
              )}
            </div>
          )}
        </div>
          </div>
        )}

        <button type="button" className="cp-go" disabled={busy} onClick={create}>
          {busy ? 'Creating…' : 'Create room →'}
        </button>
        {err && <p className="cg-err">{err}</p>}
      </div>
    </main>
  )
}
