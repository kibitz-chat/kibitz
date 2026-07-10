// Mounts a floating AgentBubble per present agent, plus the room creator's summon bubble when no agent
// is here yet. Enforces one-open-panel-at-a-time with a shared scrim, and hosts the brand "rate the agent"
// iframe overlay (outside the bubbles' transform, so its position:fixed is viewport-relative). Spec:
// docs/floating-agent-control.md (kibitz). Rendered inside `.kw-stagewrap` (Widget.tsx), behind
// brand.agentBubble. `speaking` is passed in (Widget already runs useActiveSpeakers — don't double it).
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CallController } from '../react/useCall'
import { liveAgentMenus, actionMessage } from './agentActions'
import { liveHostMenus, type HostMenu } from './hostMenu'
import { AgentBubble } from './AgentBubble'
import { splitActions, engagedFromMeta } from './agentBubbleState'
import { wt } from '../react/i18n'

// An AI agent peer: read-only `role:'agent'` OR a full-capability voice-assistant (mirrors useAgentPresence).
const isAgentPeer = (p: { meta?: Record<string, unknown> }) => p.meta?.role === 'agent' || p.meta?.kind === 'voice-assistant'

// Auto-open timing (arrival panel): collapse while the agent greets, expand once it's DONE. "Done" is an EXPLICIT
// signal — the agent sets `meta.greeted` when its intro greeting finishes (driver.mjs `setGreeted`), so we don't
// infer it from audio silence (which flickers across the greeting's own sentence pauses). GREET_MAX = a safety-net
// fallback: open anyway if the flag never arrives (e.g. an older agent build that doesn't send it).
const GREET_MAX_MS = 20000

export function AgentBubbleLayer({
  call,
  isCreator,
  summonAgent,
  summoning,
  agentResumable,
  speaking,
  menuOrigin,
  room,
  hidden,
  topupUrl,
}: {
  call: CallController
  isCreator: boolean
  summonAgent: () => void
  summoning: boolean
  agentResumable: boolean
  speaking: ReadonlySet<string>
  menuOrigin?: string
  room?: string
  hidden?: ReadonlySet<string>
  topupUrl?: string
}) {
  const [, bump] = useState(0)
  useEffect(() => call.onSchema(() => bump((n) => n + 1)), [call])
  const [openId, setOpenId] = useState<string | null>(null)
  const [rate, setRate] = useState<HostMenu | null>(null)

  // While the rate frame is open, let the brand page dismiss itself — honoring only messages from the
  // build-LOCKED origin — and close on Escape. Mirrors HostMenuBar's origin-checked handling.
  useEffect(() => {
    if (!rate || !menuOrigin) return
    let lockedOrigin = ''
    try {
      lockedOrigin = new URL(menuOrigin).origin
    } catch {
      return
    }
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== lockedOrigin) return
      const d = e.data as { type?: unknown; action?: unknown } | null
      if (d && typeof d === 'object' && d.type === 'kibitz:hostmenu' && d.action === 'close') setRate(null)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setRate(null)
    }
    window.addEventListener('message', onMsg)
    document.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('message', onMsg)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [rate, menuOrigin])

  const agents = call.participants.filter((p) => !p.isSelf && isAgentPeer(p))
  const present = new Set(call.participants.map((p) => p.id))
  const selfId = call.participants.find((p) => p.isSelf)?.id // rater identity for a presence-based (no-coupon) rating
  const menus = liveAgentMenus(call.getSchemas(), present)
  const hostMenus = liveHostMenus(call.getSchemas(), present, menuOrigin, { room, rater: selfId })
  const menuFor = (id: string) => menus.find((m) => m.from === id)
  const hostFor = (id: string) => hostMenus.find((h) => h.from === id)

  const anyAgent = agents.length > 0
  const showSummon = isCreator && !anyAgent

  // Auto-open a newly-ARRIVED agent's panel — but WAIT for its GREETING to finish first: collapse while it greets,
  // then expand to the Engage prompt ("go ahead, friend") once done. "Done" comes from the agent EXPLICITLY: it sets
  // `meta.greeted` when its intro greeting is delivered (driver.mjs `setGreeted`). No audio-silence guessing. A
  // GREET_MAX fallback opens it anyway if the flag never lands (older agent build / lost meta). Once per agent — a
  // manual close stays closed; a leaver is forgotten so a re-summon re-runs it. (The collapse on arrival is DESIRED:
  // the summon bubble unmounts the moment the agent mounts, so `openId` — still '__summon' — matches nothing.)
  const autoOpenedRef = useRef<Set<string>>(new Set())
  const greetRef = useRef<Map<string, number>>(new Map()) // per waiting agent: the GREET_MAX safety-net timeout id
  const openArrival = useCallback((id: string) => {
    if (autoOpenedRef.current.has(id)) return
    autoOpenedRef.current.add(id)
    const t = greetRef.current.get(id)
    if (t) window.clearTimeout(t)
    greetRef.current.delete(id)
    setOpenId(id)
  }, [])
  const agentIds = agents.map((p) => p.id).join(',')
  useEffect(() => {
    const live = new Set(agentIds ? agentIds.split(',') : [])
    for (const id of autoOpenedRef.current) if (!live.has(id)) autoOpenedRef.current.delete(id)
    for (const [id, t] of greetRef.current) if (!live.has(id)) { window.clearTimeout(t); greetRef.current.delete(id) }
    for (const id of live) {
      if (autoOpenedRef.current.has(id) || greetRef.current.has(id)) continue
      greetRef.current.set(id, window.setTimeout(() => openArrival(id), GREET_MAX_MS)) // fallback only — meta.greeted opens it sooner
    }
  }, [agentIds, openArrival])
  // The explicit "greeting done" signal: expand the panel as soon as the agent's meta.greeted flips true.
  const greetedKey = agents.filter((p) => (p.meta as Record<string, unknown> | undefined)?.greeted).map((p) => p.id).join(',')
  useEffect(() => {
    for (const id of greetedKey ? greetedKey.split(',') : []) openArrival(id)
  }, [greetedKey, openArrival])
  useEffect(() => () => { for (const t of greetRef.current.values()) window.clearTimeout(t); greetRef.current.clear() }, [])

  // Engage nudge (summoner only). If an agent's sat here ~60s with NO one engaging it yet, a surprise can stall
  // because nobody knows the wake cue. So we surface the cue AS a one-tap button: a compact "go ahead, friend" pill
  // that (after a confirm tap, to avoid a fat-finger) hands the agent the floor — the button form of saying it out
  // loud. Summoner-only (they set it up and can act), once per call, 10s auto-hide, gone the moment it's engaged.
  const firstAgent = agents[0]
  const firstMenu = firstAgent ? menuFor(firstAgent.id) : undefined
  const engageAction = firstMenu ? splitActions(firstMenu.actions).engage : undefined
  // `engageAction` is a FRESH object every render (splitActions builds a new one), so it must NEVER go in an effect
  // dependency array — derive a stable boolean instead. Its churning identity is exactly what kept restarting the
  // 60s nudge timer below (this layer re-renders every ~1–2s on presence ticks), so the nudge never once fired.
  const hasEngage = !!engageAction
  const anyEngaged = agents.some((p) => engagedFromMeta(p.meta as Record<string, unknown> | undefined))
  const everEngagedRef = useRef(false)
  const nudgeDoneRef = useRef(false) // one-shot per call
  const [engageNudge, setEngageNudge] = useState(false)
  const [confirming, setConfirming] = useState(false)
  useEffect(() => {
    if (anyEngaged) everEngagedRef.current = true
  }, [anyEngaged])
  useEffect(() => {
    if (anyAgent) return // reset when the agent leaves / the call ends
    nudgeDoneRef.current = false
    everEngagedRef.current = false
    setEngageNudge(false)
    setConfirming(false)
  }, [anyAgent])
  useEffect(() => {
    // Only the summoner, agent present + offers Engage, never engaged, not already fired.
    if (!isCreator || !anyAgent || !hasEngage || everEngagedRef.current || nudgeDoneRef.current) return
    const timer = window.setTimeout(() => {
      if (everEngagedRef.current) return // engaged during the wait → skip
      nudgeDoneRef.current = true
      setEngageNudge(true)
    }, 60_000)
    return () => window.clearTimeout(timer)
    // STABLE booleans only — do NOT add engageAction/anyEngaged (fresh/changing refs would reset the 60s timer
    // every render so it never elapses). everEngagedRef (checked inside) + the anyEngaged effect below cover engagement.
  }, [isCreator, anyAgent, hasEngage])
  useEffect(() => {
    if (!engageNudge || confirming) return // hold the pill open while they're mid-confirm
    const hide = window.setTimeout(() => setEngageNudge(false), 10_000)
    return () => window.clearTimeout(hide)
  }, [engageNudge, confirming])
  useEffect(() => {
    if (!confirming) return
    const revert = window.setTimeout(() => setConfirming(false), 4_000) // un-arm if they hesitate
    return () => window.clearTimeout(revert)
  }, [confirming])
  useEffect(() => {
    if (anyEngaged) {
      setEngageNudge(false)
      setConfirming(false)
    }
  }, [anyEngaged])
  const doEngage = () => {
    if (firstAgent && engageAction) call.sendAppTo(firstAgent.id, actionMessage(engageAction.id))
    setEngageNudge(false)
    setConfirming(false)
  }

  if (!anyAgent && !showSummon) return null

  return (
    <div className="kw-agb-layer">
      {/* The expanded panel is NON-MODAL: a tap on the call must not collapse it (you were tapping the video, not
          dismissing the agent). Collapse is the grabber-bar tap / the pill — no full-screen scrim tap-catcher. */}
      {engageNudge && engageAction && (
        <div className="kw-engagenudge" data-confirm={confirming ? 'true' : 'false'}>
          <button type="button" className="kw-engagenudge-go" onClick={() => (confirming ? doEngage() : setConfirming(true))}>
            {confirming ? wt('Hand it the floor? ✓') : wt('🎙️ “go ahead, friend”')}
          </button>
          <button type="button" className="kw-engagenudge-x" aria-label={wt('Dismiss')} onClick={() => { setEngageNudge(false); setConfirming(false) }}>
            ✕
          </button>
        </div>
      )}
      {agents
        .filter((p) => !hidden?.has(p.id))
        .map((p, i) => (
          <AgentBubble
            key={p.id}
            call={call}
            isCreator={isCreator}
            participant={p}
            menu={menuFor(p.id)}
            speaking={speaking.has(p.id)}
            hostMenu={hostFor(p.id)}
            onRate={setRate}
            topupUrl={topupUrl}
            index={i}
            open={openId === p.id}
            onOpen={() => setOpenId(p.id)}
            onClose={() => setOpenId((o) => (o === p.id ? null : o))}
          />
        ))}
      {showSummon && (
        <AgentBubble
          key="__summon"
          call={call}
          isCreator={isCreator}
          summon
          summoning={summoning}
          known={agentResumable}
          onSummon={summonAgent}
          index={0}
          open={openId === '__summon'}
          onOpen={() => setOpenId('__summon')}
          onClose={() => setOpenId((o) => (o === '__summon' ? null : o))}
        />
      )}
      {rate && (
        <div className="kw-hostmenu-overlay" style={{ pointerEvents: 'auto' }} onClick={(e) => e.target === e.currentTarget && setRate(null)}>
          <div className="kw-hostmenu-panel">
            <button type="button" className="kw-hostmenu-close" aria-label="Close" onClick={() => setRate(null)}>
              ✕
            </button>
            {/* Origin build-locked (hostMenu.ts). allow-same-origin lets the brand page read its own coupon. */}
            <iframe className="kw-hostmenu-frame" src={rate.url} title={rate.label} sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox" />
          </div>
        </div>
      )}
    </div>
  )
}
