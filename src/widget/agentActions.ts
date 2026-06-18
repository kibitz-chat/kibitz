// Consumer side of the `agent-actions@1` protocol: an agent on the call publishes its actions via
// registerSchema('agent-actions', …); we render them as a menu and send a chosen action back to it
// over the data mesh. Kibitz stays agnostic — it never inspects WHAT an action does, only its label.
//
// This module is pure (no React) so the parsing + liveness logic is unit-testable.
import type { SchemaInfo } from '../react/useCall'

export const AGENT_ACTIONS_SCHEMA = 'agent-actions'
export const ACTION_MSG_KIND = 'agent-action@1'

// Where an agent asks its menu to surface (manifest `ui.placement`). The agent chooses; an unknown or
// missing value falls back to 'chat' (the original behavior, so older agents are unchanged).
// The placement vocabulary of the agent-actions@1 protocol. Kibitz is the canonical owner here;
// downstream agent runtimes mirror THIS list, not the other way around.
export const PLACEMENTS = ['stage', 'chat', 'tile', 'controls'] as const
export type Placement = (typeof PLACEMENTS)[number]
export const DEFAULT_PLACEMENT: Placement = 'chat'
const asPlacement = (v: unknown): Placement => (PLACEMENTS as readonly string[]).includes(v as string) ? (v as Placement) : DEFAULT_PLACEMENT

// ── Theme (manifest `ui.theme`) ───────────────────────────────────────────────────
// A small, validated look-and-feel vocabulary the AGENT declares; the widget applies it generically,
// so new looks need no widget change. NOT raw CSS — every value is allow-listed or strictly pattern-
// checked, so an agent can't inject CSS or break the host UI.
export const CHIP_STYLES = ['solid', 'outline', 'ghost', 'pill'] as const
export const SIZES = ['compact', 'normal', 'large'] as const
export const BUTTON_STYLES = ['icon', 'labeled'] as const
export type ChipStyle = (typeof CHIP_STYLES)[number]
export type Size = (typeof SIZES)[number]
export type ButtonStyle = (typeof BUTTON_STYLES)[number]

export interface AgentTheme {
  accent?: string // a validated CSS color (set as a custom property); undefined → the widget default
  icon?: string // replaces the generic 🤖; undefined → 🤖
  chip: ChipStyle
  size: Size
  button: ButtonStyle
}

// Accept ONLY a hex color or a strict rgb()/hsl() with a safe char class — so the value can never
// escape a CSS custom-property assignment into another declaration.
const COLOR_RE = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
// Functional notation: only digits/punctuation + spaces/tabs inside (no newlines) — tight by design.
const FUNC_COLOR_RE = /^(?:rgb|hsl)a?\([0-9.,%/ \t]{1,40}\)$/i
const safeColor = (v: unknown): string | undefined => {
  const s = typeof v === 'string' ? v.trim() : ''
  return COLOR_RE.test(s) || FUNC_COLOR_RE.test(s) ? s : undefined
}
const oneOf = <T extends string>(list: readonly T[], v: unknown, dflt: T): T => (list as readonly string[]).includes(v as string) ? (v as T) : dflt
// Icon: a short visible string (an emoji or 1-2 glyphs). React escapes text, so XSS isn't the risk —
// we just cap length and drop angle-brackets/control chars for tidiness.
const safeIcon = (v: unknown): string | undefined => {
  if (typeof v !== 'string') return undefined
  const s = [...v.trim()].slice(0, 4).join('').replace(/[<>\x00-\x1f]/g, '')
  return s || undefined
}

export function parseTheme(raw: unknown): AgentTheme {
  const t = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    ...(safeColor(t.accent) ? { accent: safeColor(t.accent) } : {}),
    ...(safeIcon(t.icon) ? { icon: safeIcon(t.icon) } : {}),
    chip: oneOf(CHIP_STYLES, t.chip, 'solid'),
    size: oneOf(SIZES, t.size, 'normal'),
    button: oneOf(BUTTON_STYLES, t.button, 'icon'),
  }
}

export interface AgentAction {
  id: string
  label: string
  desc?: string
  voice?: string[]
  chat?: string[]
}
export interface AgentMenu {
  /** The publishing agent's participant id — where a chosen action is sent back. */
  from: string
  agent: string
  placement: Placement
  theme: AgentTheme
  actions: AgentAction[]
}

function parseManifest(schema: unknown): { agent: string; placement: Placement; theme: AgentTheme; actions: AgentAction[] } | null {
  if (!schema || typeof schema !== 'object') return null
  const s = schema as Record<string, unknown>
  if (!Array.isArray(s.actions)) return null
  const actions: AgentAction[] = []
  for (const raw of s.actions) {
    if (!raw || typeof raw !== 'object') continue
    const a = raw as Record<string, unknown>
    if (typeof a.id !== 'string' || typeof a.label !== 'string') continue
    actions.push({
      id: a.id,
      label: a.label,
      ...(typeof a.desc === 'string' ? { desc: a.desc } : {}),
      ...(Array.isArray(a.voice) ? { voice: a.voice.filter((v): v is string => typeof v === 'string') } : {}),
      ...(Array.isArray(a.chat) ? { chat: a.chat.filter((v): v is string => typeof v === 'string') } : {}),
    })
  }
  if (!actions.length) return null
  const ui = s.ui && typeof s.ui === 'object' ? (s.ui as Record<string, unknown>) : {}
  return {
    agent: typeof s.agent === 'string' && s.agent ? s.agent : 'Agent',
    placement: asPlacement(ui.placement),
    theme: parseTheme(ui.theme),
    actions,
  }
}

/**
 * Derive the live agent menus from the known schemas, keeping only agents still on the call (so a
 * menu disappears when its agent leaves). One menu per publisher; malformed manifests are dropped.
 */
export function liveAgentMenus(schemas: readonly SchemaInfo[], presentIds: ReadonlySet<string>): AgentMenu[] {
  const byFrom = new Map<string, AgentMenu>()
  for (const s of schemas) {
    if (s.name !== AGENT_ACTIONS_SCHEMA || !presentIds.has(s.from)) continue
    const m = parseManifest(s.schema)
    if (m) byFrom.set(s.from, { from: s.from, agent: m.agent, placement: m.placement, theme: m.theme, actions: m.actions })
  }
  return [...byFrom.values()]
}

/** Menus that asked to render at a given placement (used to render each surface independently). */
export const menusFor = (menus: readonly AgentMenu[], placement: Placement): AgentMenu[] =>
  menus.filter((m) => m.placement === placement)

/** Menus a given viewer hasn't locally hidden (the Agents-menu checkboxes — view-only, per viewer). */
export const visibleMenus = (menus: readonly AgentMenu[], hidden?: ReadonlySet<string>): AgentMenu[] =>
  hidden && hidden.size ? menus.filter((m) => !hidden.has(m.from)) : [...menus]

/** The message sent to the agent when a menu button is clicked. */
export const actionMessage = (id: string) => ({ kind: ACTION_MSG_KIND, id })
