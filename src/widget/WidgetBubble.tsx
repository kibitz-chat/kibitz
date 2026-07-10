import { useRef } from 'react'
import { mapWidgetOn, type CallController, type ChatItem } from '../react/useCall'
import { pickStagedWidget } from '../react/stageWidget'
import { MAP_WIDGET_KIND, sanitizeMapData } from './mapWidget'
import { getWidgetKind } from './widgets/registry'
import { MapWidget } from './MapWidget'
import { WidgetView } from './widgets/WidgetView'
import { saveWidget } from './saveWidget'
import type { MapInst, WidgetInst } from './useStageWidgets'

// One agent-posted widget rendered INLINE in the chat log as a first-class message: the chat is its durable,
// chronological home (session-lifetime, like every other line). Prefers the LIVE instance kept by useStageWidgets
// (keyed by the same id — pins fold in, lockstep view) and falls back to the stored snapshot (sanitized here, since
// the transport recorded the raw payload kind-agnostically) once the live instance is gone. In-call it offers Stage
// / Off-stage, a local Dismiss (anti-spam — removes from YOUR chat only), and 💾 Save to disk. Stage twin: StagedWidget.
export function WidgetBubble({
  m,
  call,
  preview,
  mapInstances,
  widgetInstances,
  stagedWidget,
  dropMapPin,
  stageMapWidget,
  stageWidgetPixels,
  dismiss,
}: {
  m: ChatItem
  call: CallController
  preview: boolean
  mapInstances: ReadonlyMap<string, MapInst>
  widgetInstances: ReadonlyMap<string, WidgetInst>
  stagedWidget: ReturnType<typeof pickStagedWidget>
  dropMapPin: (id: string, lat: number, lng: number) => void
  stageMapWidget: (id: string | null) => void
  /** Stage this widget AS PIXELS: snapshot its rendered node and share it like an image (presenter renders +
   *  shares, viewers watch — robust for late joiners). Returns false if it couldn't (then we fall back to the
   *  per-peer pointer path). Undefined ⇒ pixel staging is off (STAGE_WIDGET_PIXELS=false) → always use the pointer. */
  stageWidgetPixels?: (node: HTMLElement, id: string) => Promise<boolean>
  dismiss: (id: string) => void
}) {
  const bodyRef = useRef<HTMLDivElement>(null)
  const w = m.widget
  if (!w) return null
  const { id, kind } = w
  const name = call.participants.find((p) => p.id === m.from)?.name || m.name || 'Agent'
  const isMap = kind === MAP_WIDGET_KIND
  const staged = stagedWidget?.id === id
  const inCall = call.inCall && !preview
  // Press Stage: for a non-map widget, prefer PIXELS (snapshot → share as an image) so it reaches every viewer,
  // including late joiners, without them needing the widget's data. Falls back to the per-peer pointer path when
  // pixel staging is off or the snapshot fails (and maps always use the pointer — external tiles can't be captured).
  const onStage = async () => {
    if (!isMap && stageWidgetPixels && bodyRef.current) {
      if (await stageWidgetPixels(bodyRef.current, id)) return
    }
    stageMapWidget(id)
  }

  // Live instance (interactive) wins; else the stored snapshot, sanitized here for a static render.
  const mapInst = isMap ? mapInstances.get(id) : undefined
  const mapData = mapInst?.data ?? (isMap ? sanitizeMapData(w.data) : null)
  const genInst = !isMap ? widgetInstances.get(id) : undefined
  const genData = genInst?.data ?? (!isMap ? getWidgetKind(kind)?.sanitize(w.data) : null)
  if (isMap && (!mapWidgetOn() || !mapData)) return null
  if (!isMap && genData == null) return null

  return (
    <div className="kw-msg">
      <span className="kw-msg-name">{name}</span>
      <div ref={bodyRef} className="kw-widget-body">
        {isMap && mapData ? (
          <MapWidget data={mapData} pins={mapInst?.pins ?? []} onDropPin={(lat, lng) => dropMapPin(id, lat, lng)} />
        ) : (
          <WidgetView kind={kind} data={genData} onEvent={(e) => call.sendWidgetEvent(id, e)} />
        )}
      </div>
      <div className="kw-msg-widget-acts" role="menu">
        {inCall &&
          (staged ? (
            <button type="button" onClick={() => stageMapWidget(null)} title="Take this off the shared stage">
              ✕ Off stage
            </button>
          ) : (
            <button type="button" onClick={() => void onStage()} title="Put this on the shared stage for everyone">
              📺 Stage
            </button>
          ))}
        <button type="button" onClick={() => void saveWidget(kind, id, mapInst?.data ?? genInst?.data ?? w.data)} title="Save this widget to disk">
          💾 Save
        </button>
        {/* Local moderation: any recipient can remove a widget from THEIR OWN chat (anti-spam / anti-phishing). */}
        <button type="button" onClick={() => dismiss(id)} title="Remove this from your chat">
          🚫 Dismiss
        </button>
      </div>
    </div>
  )
}
