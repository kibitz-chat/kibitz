import { useState, type CSSProperties } from 'react'
import { ALL_ACT, ALL_PERCEIVE, type Capability, type Grant } from '../core/capabilities'
import type { AuditEntry } from '../react/useCall'

// Host-side consent + control for AGENTS in the room (the visible face of the capability layer).
// An agent joins read-only by default; here the host sees exactly what each agent may PERCEIVE
// (content that flows to it) and ACT (what it may emit), toggles capabilities, and revokes — the
// engine enforces every change (host-local in v1). Self-contained + inline-styled so it drops into
// the shadow-rooted panel without touching its CSS. Grants live in a ref in useCall, so a tick
// forces a re-read after each change.

const LABEL: Record<Capability, string> = {
  'see-screen': 'see screen',
  'hear-audio': 'hear audio',
  'read-chat': 'read chat',
  'read-roster': 'see who’s here',
  'receive-directed': 'private data',
  'read-media': 'see shared images',
  'read-files': 'receive files',
  'send-chat': 'post chat',
  'speak': 'speak',
  'act': 'act / control',
}
const ALL: Capability[] = [...ALL_PERCEIVE, ...ALL_ACT]
const PERCEIVE_SET = new Set<string>(ALL_PERCEIVE)

function has(g: Grant, cap: Capability): boolean {
  return g.perceive.includes(cap as never) || g.act.includes(cap as never)
}
/** Toggle one capability in/out of the right list. */
function toggle(g: Grant, cap: Capability): Grant {
  const key = PERCEIVE_SET.has(cap) ? 'perceive' : 'act'
  const list = g[key] as string[]
  const next = list.includes(cap) ? list.filter((c) => c !== cap) : [...list, cap]
  return { ...g, [key]: next }
}

export interface AgentInfo {
  id: string
  name: string
}

export function AgentConsent({
  agents,
  getGrant,
  setGrant,
  getAudit,
}: {
  agents: AgentInfo[]
  getGrant: (id: string) => Grant
  setGrant: (id: string, g: Grant | null) => void
  getAudit?: (id: string) => readonly AuditEntry[]
}) {
  const [, tick] = useState(0)
  if (!agents.length) return null
  const apply = (id: string, g: Grant | null) => {
    setGrant(id, g)
    tick((n) => n + 1)
  }

  const wrap: CSSProperties = {
    margin: '8px 0',
    padding: '10px 12px',
    border: '1px solid rgba(143,211,176,0.35)',
    background: 'rgba(143,211,176,0.08)',
    borderRadius: 12,
    fontSize: 13,
  }
  const head: CSSProperties = { fontWeight: 700, color: '#8fd3b0', marginBottom: 8 }
  const name: CSSProperties = { fontWeight: 600, marginBottom: 6 }
  const row: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 5 }
  const chip = (on: boolean): CSSProperties => ({
    font: 'inherit',
    fontSize: 12,
    padding: '3px 8px',
    borderRadius: 999,
    cursor: 'pointer',
    border: '1px solid rgba(255,255,255,0.18)',
    background: on ? '#18794e' : 'rgba(255,255,255,0.06)',
    color: on ? '#fff' : '#bcd',
  })

  return (
    <div style={wrap}>
      <div style={head}>🤖 Agents — what each may do</div>
      {agents.map((a) => {
        const g = getGrant(a.id)
        return (
          <div key={a.id} style={{ marginTop: 8 }}>
            <div style={name}>
              {a.name || 'Agent'}
              {g.backend ? (
                <span style={{ fontWeight: 400, opacity: 0.7 }}>
                  {' · '}
                  {g.backend}
                  {g.egress ? ' — what it sees leaves the room' : ''}
                </span>
              ) : null}
            </div>
            <div style={row}>
              {ALL.map((cap) => {
                const on = has(g, cap)
                return (
                  <button key={cap} type="button" style={chip(on)} onClick={() => apply(a.id, toggle(g, cap))}>
                    {on ? '✓' : '+'} {LABEL[cap]}
                  </button>
                )
              })}
            </div>
            <button
              type="button"
              style={{ ...chip(false), marginTop: 6, color: '#ff8d85', borderColor: 'rgba(255,141,133,0.4)' }}
              onClick={() => apply(a.id, { perceive: [], act: [] })}
            >
              Revoke all
            </button>
            {(() => {
              const events = getAudit?.(a.id) ?? []
              if (!events.length) return null
              return (
                <div style={{ marginTop: 6, fontSize: 11, opacity: 0.75, lineHeight: 1.5 }}>
                  {events.slice(0, 4).map((e, i) => (
                    <div key={i}>
                      {e.kind === 'blocked' ? `⛔ tried to ${e.detail} (blocked)` : `⚙ permissions: ${e.detail}`}
                    </div>
                  ))}
                </div>
              )
            })()}
          </div>
        )
      })}
    </div>
  )
}
