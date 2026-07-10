/**
 * Keyboard shortcuts for the call panel. Deliberately SCOPED to the panel (the
 * Widget binds these on focus-within, never on window) — the widget floats over
 * arbitrary third-party pages, so it must never hijack the host page's keys.
 *
 *   m      → toggle mic
 *   v      → toggle camera
 *   Space  → push-to-talk (unmute while held, re-mute on release)
 */
export type ShortcutAction = 'mic' | 'cam' | 'ptt'

/** Map a key (from a KeyboardEvent) to a call action, or null. Letters are
 *  case-insensitive; Space is push-to-talk. */
export function shortcutFor(key: string): ShortcutAction | null {
  if (key === ' ' || key === 'Spacebar') return 'ptt' // 'Spacebar' = legacy Edge/IE
  const k = key.toLowerCase()
  if (k === 'm') return 'mic'
  if (k === 'v') return 'cam'
  return null
}

/** True when the event target is a text field — typing, so don't steal the key. */
export function isTypingTarget(el: EventTarget | null): boolean {
  const node = el as (HTMLElement & { tagName?: string }) | null
  if (!node || !node.tagName) return false
  const tag = node.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || tag === 'select' || node.isContentEditable === true
}

/** True when the target is a button-like control — let Space/Enter activate it
 *  instead of triggering push-to-talk (which Space would otherwise double up on).
 *  Covers <button>, button/submit/reset inputs, and role="button". */
export function isButtonTarget(el: EventTarget | null): boolean {
  const node = el as (HTMLElement & { tagName?: string; type?: string; getAttribute?: (n: string) => string | null }) | null
  if (!node?.tagName) return false
  const tag = node.tagName.toLowerCase()
  if (tag === 'button') return true
  if (tag === 'input') {
    const type = (node.type || '').toLowerCase()
    return type === 'button' || type === 'submit' || type === 'reset'
  }
  return node.getAttribute?.('role') === 'button'
}
