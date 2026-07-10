import { useEffect, useRef, useState } from 'react'
import { getRecentRooms, forgetRecentRoom, clearRecentRooms, type RecentRoom } from '../core/recentRooms'
import { ClockIcon } from '../widget/icons'

const REVEAL = 60 // px of the delete basket revealed by a left swipe

// The date + time of the LAST call to this room (room.at, stamped on every entry) — e.g. "Jun 29, 9:43 PM".
// Locale-formatted (the viewer's own format/zone); '' when missing so old entries don't show "Invalid Date".
const fmtWhen = (at: number): string => {
  if (!at) return ''
  try {
    return new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  } catch {
    return ''
  }
}

// One room row: swipe LEFT to reveal a red 🗑 basket; pressing the basket confirms the delete (no accidental ✕).
// A plain tap re-enters the room. Pointer events cover touch + mouse; touch-action:pan-y leaves vertical scroll free.
function RecentItem({ room, onEnter, onForget }: { room: RecentRoom; onEnter: (hash: string) => void; onForget: (code: string) => void }) {
  const [offset, setOffset] = useState(0)
  const [dragging, setDragging] = useState(false)
  const drag = useRef<{ x: number; base: number; moved: boolean } | null>(null)
  const suppress = useRef(false) // a drag synthesizes a trailing click — ignore that one
  const open = offset <= -REVEAL / 2
  return (
    <div className={`recent-item${open ? ' swiped' : ''}`}>
      <button type="button" className="recent-del" onClick={() => onForget(room.code)} aria-label={`Delete ${room.name}`} title="Delete this room" tabIndex={open ? 0 : -1}>
        🗑
      </button>
      <button
        type="button"
        className="recent-enter"
        style={{ transform: `translateX(${offset}px)`, transition: dragging ? 'none' : undefined }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          drag.current = { x: e.clientX, base: offset, moved: false }
          setDragging(true)
        }}
        onPointerMove={(e) => {
          if (!drag.current) return
          const d = e.clientX - drag.current.x
          if (Math.abs(d) > 4) drag.current.moved = true
          setOffset(Math.max(-REVEAL, Math.min(0, drag.current.base + d)))
        }}
        onPointerUp={() => {
          if (!drag.current) return
          suppress.current = drag.current.moved
          setOffset((o) => (o <= -REVEAL / 2 ? -REVEAL : 0))
          drag.current = null
          setDragging(false)
        }}
        onPointerCancel={() => {
          setOffset((o) => (o <= -REVEAL / 2 ? -REVEAL : 0))
          drag.current = null
          setDragging(false)
        }}
        onClick={() => {
          if (suppress.current) { suppress.current = false; return } // ignore the click synthesized after a swipe
          if (offset <= -REVEAL / 2) setOffset(0) // open → a tap snaps it closed
          else onEnter(room.hash) // closed → re-enter
        }}
      >
        <span className="recent-enter-i" aria-hidden="true">↩</span>
        <span className="recent-enter-main">
          <span className="recent-enter-t">{room.name}</span>
          {room.at ? <span className="recent-enter-when">{fmtWhen(room.at)}</span> : null}
        </span>
      </button>
    </div>
  )
}

// "Recent rooms" on the start-a-room page — a dropdown of rooms you've opened, so you can re-enter one after
// leaving. Each row: ↩ tap re-enters (carries the summon key), swipe-left → 🗑 basket → press to delete. Clear all
// is a two-tap confirm. Closes on outside-click / Escape. Local-only — nothing leaves the device.
export function RecentRooms() {
  const [rooms, setRooms] = useState(() => getRecentRooms())
  const [open, setOpen] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  useEffect(() => {
    if (!confirmClear) return
    const t = setTimeout(() => setConfirmClear(false), 3000) // auto-disarm the "tap again" confirm
    return () => clearTimeout(t)
  }, [confirmClear])

  if (rooms.length === 0) return null

  const enter = (hash: string) => {
    const target = location.origin + location.pathname + hash
    const sameDoc = target.split('#')[0] === location.href.split('#')[0]
    location.assign(target)
    if (sameDoc) location.reload()
  }
  const forget = (code: string) => {
    forgetRecentRoom(code)
    const next = getRecentRooms()
    setRooms(next)
    if (next.length === 0) setOpen(false)
  }

  return (
    <div className={`recent${open ? ' open' : ''}`} ref={wrapRef}>
      <button type="button" className="recent-toggle" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}>
        <span className="recent-toggle-l">
          <ClockIcon /> Recent rooms
        </span>
        <span className="recent-count">{rooms.length}</span>
        <span className="recent-caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="recent-menu" role="menu">
          {rooms.map((r) => (
            <RecentItem key={r.code} room={r} onEnter={enter} onForget={forget} />
          ))}
          <div className="recent-hint">Swipe a room left to delete it</div>
          <button
            type="button"
            className={`recent-clear${confirmClear ? ' armed' : ''}`}
            onClick={() => {
              if (confirmClear) { clearRecentRooms(); setRooms([]); setOpen(false) }
              else setConfirmClear(true)
            }}
          >
            {confirmClear ? '✓ Tap again to clear all' : '🗑 Clear all'}
          </button>
        </div>
      )}
    </div>
  )
}
