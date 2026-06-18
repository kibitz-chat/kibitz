// The call layouts you can page between (the "view"). Kept DOM-free and pure so the offer rule is
// unit-testable on its own — Widget.tsx recomputes `pageableViews(...)` each render from live state.

export type CallView = 'speaker' | 'gallery' | 'car' | 'strip'

// Cycle order. Car first (swipe-left from Speaker reaches it on the room app); then the default Speaker,
// the Gallery grid, and the compact Strip (a row of small tiles).
export const VIEW_ORDER: readonly CallView[] = ['car', 'speaker', 'gallery', 'strip']

/**
 * Which views to offer right now, filtered from {@link VIEW_ORDER}:
 * - **speaker** is always available (one big active-speaker tile + a filmstrip).
 * - **gallery** (everyone in an even GRID) is redundant with speaker when you're alone, so it needs ≥2
 *   people.
 * - **strip** (everyone in a single compact ROW of small tiles — "tiles in a row") is Speaker's alternate
 *   layout for the EMBEDDED WIDGET only — i.e. *not* a `carSurface`. The dedicated room window / installed
 *   app uses Car instead; Strip there would just clutter the swipe.
 * - **car** (driving mode) belongs only to the real room app you'd prop up in the car — a touch device on
 *   a `carSurface` (the dedicated room window / installed app); never the embedded widget.
 */
export function pageableViews(o: { canTouch: boolean; carSurface: boolean; multiParty: boolean }): readonly CallView[] {
  return VIEW_ORDER.filter(
    (v) =>
      (v !== 'car' || (o.canTouch && o.carSurface)) &&
      (v !== 'gallery' || o.multiParty) &&
      (v !== 'strip' || !o.carSurface),
    // speaker is always offered
  )
}
