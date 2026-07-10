import { mapWidgetOn, type CallController } from '../react/useCall'
import { pickStagedWidget } from '../react/stageWidget'
import { MapWidget } from './MapWidget'
import { WidgetView } from './widgets/WidgetView'
import { saveWidget } from './saveWidget'
import { MAP_WIDGET_KIND, type MapData, type MapPin } from './mapWidget'

type MapInst = { from: string; data: MapData; pins: readonly MapPin[]; view?: { center: { lat: number; lng: number }; zoom: number } }
type WidgetInst = { from: string; kind: string; data: unknown }

// The agent-posted MAP or generic WIDGET currently on the shared STAGE (a pointer in roster-meta; anyone can push).
// Renders whichever instance the stagedWidget pointer resolves to — a lockstep-followable MapWidget, or a generic
// kind-dispatched WidgetView — each with an "off stage" control. A given id lives in at most one registry, so at
// most one branch matches. Extracted from Widget.tsx; the shared guard (in-call, not preview, no screen-share, a
// staged pointer) lives here as an early return. kw-stage-widget classes are global — keep verbatim.
export function StagedWidget({
  call,
  preview,
  someonePresenting,
  stagedWidget,
  mapInstances,
  widgetInstances,
  dropMapPin,
  driveMapView,
  stageMapWidget,
}: {
  call: CallController
  preview: boolean
  someonePresenting: boolean
  stagedWidget: ReturnType<typeof pickStagedWidget>
  mapInstances: ReadonlyMap<string, MapInst>
  widgetInstances: ReadonlyMap<string, WidgetInst>
  dropMapPin: (id: string, lat: number, lng: number) => void
  driveMapView: (id: string, center: { lat: number; lng: number }, zoom: number) => void
  stageMapWidget: (id: string | null) => void
}) {
  if (!stagedWidget || !call.inCall || preview || someonePresenting) return null
  const sw = stagedWidget
  const by = call.participants.find((p) => p.id === sw.from)?.name
  if (mapWidgetOn() && mapInstances.has(sw.id)) {
    const inst = mapInstances.get(sw.id)!
    return (
      <div className="kw-stage-widget">
        <div className="kw-stage-widget-bar">
          <span className="kw-stage-widget-title">🗺 {inst.data.title || 'Map'}{by ? ` · staged by ${by}` : ''}</span>
          <span style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="kw-staged-ctl" onClick={() => void saveWidget(MAP_WIDGET_KIND, sw.id, inst.data)} title="Save this map as GeoJSON">
              💾 Save
            </button>
            <button type="button" className="kw-staged-ctl" onClick={() => stageMapWidget(null)} title="Take this map off the stage">
              ✕ Off stage
            </button>
          </span>
        </div>
        <div className="kw-stage-widget-body">
          <MapWidget
            data={inst.data}
            pins={inst.pins}
            onDropPin={(lat, lng) => dropMapPin(sw.id, lat, lng)}
            view={inst.view ?? null}
            onViewChange={(center, zoom) => driveMapView(sw.id, center, zoom)}
            fill
          />
        </div>
      </div>
    )
  }
  if (widgetInstances.has(sw.id)) {
    const inst = widgetInstances.get(sw.id)!
    return (
      <div className="kw-stage-widget">
        <div className="kw-stage-widget-bar">
          <span className="kw-stage-widget-title">{by ? `staged by ${by}` : ''}</span>
          <span style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="kw-staged-ctl" onClick={() => void saveWidget(inst.kind, sw.id, inst.data)} title="Save this widget to disk">
              💾 Save
            </button>
            <button type="button" className="kw-staged-ctl" onClick={() => stageMapWidget(null)} title="Take this off the stage">
              ✕ Off stage
            </button>
          </span>
        </div>
        <div className="kw-stage-widget-body">
          <WidgetView kind={inst.kind} data={inst.data} fill onEvent={(e) => call.sendWidgetEvent(sw.id, e)} />
        </div>
      </div>
    )
  }
  return null
}
