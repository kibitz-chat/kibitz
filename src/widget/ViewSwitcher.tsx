import { isIOS } from '../core/media'
import { VIEW_LABEL, VIEW_ICON, type CallView } from './pageableViews'

// The view-cycle button in the call bar: tap to rotate through the available layouts (speaker / gallery / car /
// strip). Shown only with ≥2 pageable views and where the swipe + page-dots aren't already acting as the switcher
// (so no duplicate control). Purely presentational. Extracted from Widget.tsx's callControls. kw-ic class is global.
export function ViewSwitcher({
  availableViews,
  showViewDots,
  chatSplit,
  view,
  cycleView,
}: {
  availableViews: readonly CallView[]
  showViewDots: boolean
  chatSplit: boolean
  view: CallView
  cycleView: (dir?: 1 | -1, wrap?: boolean) => void
}) {
  if (!(availableViews.length > 1 && !showViewDots && !chatSplit)) return null
  return (
    <button
      className={`kw-ic${view !== 'speaker' ? ' active' : ''}`}
      onClick={() => cycleView(1, true)}
      aria-label={`${VIEW_LABEL[view]} view — tap to switch`}
      title={`${VIEW_LABEL[view]} view (tap to cycle ${availableViews.map((v) => VIEW_LABEL[v]).join(' · ')}${
        isIOS() ? '; or swipe the video' : ''
      })`}
    >
      {VIEW_ICON[view]}
    </button>
  )
}
