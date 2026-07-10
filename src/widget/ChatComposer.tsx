import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'

// The chat composer (kw-chatrow): the recipient chip (everyone / private to one person), the ＋ attachment menu
// (photo / camera / video / record / audio / file — six hidden <input>s behind one button), and the message input
// + send. Lifted out of Widget.tsx. The six file-input refs, the attach-menu open state, and its click-outside
// close effect are COMPOSER-INTERNAL (they live here now); everything else — the draft, the send + attach handlers,
// the recipient list, the roster gate, the ink slot — is passed in. Purely presentational over those. Global classes.
export function ChatComposer({
  draft,
  setDraft,
  sendDraft,
  recipients,
  recipientId,
  setRecipientId,
  presenter,
  preview,
  setInkSlot,
  sendImageAttach,
  sendAttachFile,
  rg,
  rosterCompromised,
  onFocusChange,
}: {
  draft: string
  setDraft: Dispatch<SetStateAction<string>>
  sendDraft: () => void
  recipients: readonly { id: string; name?: string }[]
  recipientId: string | null
  setRecipientId: Dispatch<SetStateAction<string | null>>
  presenter: boolean
  preview: boolean
  setInkSlot: Dispatch<SetStateAction<HTMLElement | null>>
  sendImageAttach: (file: File | null | undefined) => void
  sendAttachFile: (file: File | null | undefined) => void
  rg: { active: boolean; canShare: boolean }
  rosterCompromised: boolean
  /** Notify the parent when the message input gains/loses focus — used to hide the call-control bar while typing. */
  onFocusChange?: (focused: boolean) => void
}) {
  const imgInputRef = useRef<HTMLInputElement | null>(null) // any file
  const camInputRef = useRef<HTMLInputElement | null>(null) // camera shot
  const photoInputRef = useRef<HTMLInputElement | null>(null) // photo library
  const vidInputRef = useRef<HTMLInputElement | null>(null) // video library
  const vidCamInputRef = useRef<HTMLInputElement | null>(null) // record a video from the camera
  const audInputRef = useRef<HTMLInputElement | null>(null) // audio library
  const widgetInputRef = useRef<HTMLInputElement | null>(null) // a saved widget {kind,data} JSON → re-shared as the widget
  const [attachOpen, setAttachOpen] = useState(false) // the ＋ attachment menu
  // Close the ＋ menu on an outside pointer-down. The widget is in an OPEN shadow root, so the event's
  // target is retargeted to the host — match via composedPath(), NOT target.closest() (see widget notes).
  useEffect(() => {
    if (!attachOpen) return
    const onDown = (e: Event) => {
      const path = (e as Event & { composedPath?: () => EventTarget[] }).composedPath?.() || []
      if (!path.some((n) => n instanceof HTMLElement && n.classList.contains('kw-attach-wrap'))) setAttachOpen(false)
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [attachOpen])

  return (
    <form
      className="kw-chatrow"
      onSubmit={(e) => {
        e.preventDefault()
        sendDraft()
      }}
    >
      {/* Tools (recipient chip · pay · attach) on their own row. In chatsplit it sits ABOVE the input
          (so the input row stays short in the narrow chat column); in a wide chat it's the left of the
          same row. Recipient goes private (🔒 accent) when a single person is chosen. */}
      <div className="kw-chatrow-tools">
        {recipients.length > 0 && (
          <select
            className={`kw-to kw-to-chip${recipientId ? ' kw-to-chip--priv' : ''}`}
            value={recipientId ?? ''}
            onChange={(e) => setRecipientId(e.target.value || null)}
            title={recipientId ? 'Sending privately to one person' : 'Sending to everyone in the room'}
            aria-label="Send to"
          >
            <option value="">👥 Everyone</option>
            {recipients.map((p) => (
              <option key={p.id} value={p.id}>
                🔒 {p.name || 'Guest'}
              </option>
            ))}
          </select>
        )}
        {/* Pen/ink tools (StageInk portals here) live in the tools row while a screen is shared — the
            colour popup opens upward over the messages. Not rendered when no one's sharing. */}
        {presenter && !preview && <div className="kw-toolslot kw-toolslot-chat" ref={setInkSlot} />}
      </div>
      {/* The input is ONE bubble (.kw-chatrow-input carries the rounded border/bg): ＋ attach on the LEFT,
          the text input in the middle (flex:1, transparent), ➤ send on the RIGHT — in EVERY state/orientation. */}
      <div className="kw-chatrow-input">
        {!preview && (
          <>
            {/* Hidden pickers behind one ＋ menu: 🖼️ photo library (image/*), 📷 camera (capture),
                📄 any file. The engine chunks each at full resolution. */}
            <input ref={photoInputRef} type="file" accept="image/*" hidden
              onChange={(e) => { sendImageAttach(e.target.files?.[0]); e.target.value = '' }} />
            <input ref={camInputRef} type="file" accept="image/*" capture="environment" hidden
              onChange={(e) => { sendImageAttach(e.target.files?.[0]); e.target.value = '' }} />
            <input ref={imgInputRef} type="file" hidden
              onChange={(e) => { sendAttachFile(e.target.files?.[0]); e.target.value = '' }} />
            <input ref={vidInputRef} type="file" accept="video/*" hidden
              onChange={(e) => { sendAttachFile(e.target.files?.[0]); e.target.value = '' }} />
            <input ref={vidCamInputRef} type="file" accept="video/*" capture="environment" hidden
              onChange={(e) => { sendAttachFile(e.target.files?.[0]); e.target.value = '' }} />
            <input ref={audInputRef} type="file" accept="audio/*" hidden
              onChange={(e) => { sendAttachFile(e.target.files?.[0]); e.target.value = '' }} />
            <input ref={widgetInputRef} type="file" accept=".json,application/json" hidden
              onChange={(e) => { sendAttachFile(e.target.files?.[0]); e.target.value = '' }} />
            <div className="kw-attach-wrap">
              <button
                type="button"
                className="kw-chat-attach"
                disabled={rg.active && !rg.canShare}
                onClick={() => setAttachOpen((o) => !o)}
                title="Add a photo, camera shot, or file"
                aria-label="Add attachment"
                aria-haspopup="menu"
                aria-expanded={attachOpen}
              >
                ＋
              </button>
              {attachOpen && (
                <div className="kw-attach-menu" role="menu">
                  <button type="button" role="menuitem" onClick={() => { setAttachOpen(false); photoInputRef.current?.click() }}>🖼️ Photo</button>
                  <button type="button" role="menuitem" onClick={() => { setAttachOpen(false); camInputRef.current?.click() }}>📷 Camera</button>
                  <button type="button" role="menuitem" onClick={() => { setAttachOpen(false); vidInputRef.current?.click() }}>🎬 Video</button>
                  <button type="button" role="menuitem" onClick={() => { setAttachOpen(false); vidCamInputRef.current?.click() }}>🎥 Record</button>
                  <button type="button" role="menuitem" onClick={() => { setAttachOpen(false); audInputRef.current?.click() }}>🎵 Audio</button>
                  <button type="button" role="menuitem" onClick={() => { setAttachOpen(false); imgInputRef.current?.click() }}>📄 File</button>
                  <button type="button" role="menuitem" onClick={() => { setAttachOpen(false); widgetInputRef.current?.click() }} title="Share a saved widget (a 💾 Saved {kind,data} JSON)">🧩 Widget</button>
                </div>
              )}
            </div>
          </>
        )}
        <input
          value={draft}
          maxLength={500}
          dir="auto"
          disabled={rg.active && !rg.canShare}
          placeholder={
            rg.active && !rg.canShare
              ? rosterCompromised
                ? 'Blocked — an unlisted person is here'
                : 'Verifying the room…'
              : recipientId
                ? `Private to ${recipients.find((p) => p.id === recipientId)?.name || 'them'}…`
                : 'Say it quietly…'
          }
          onChange={(e) => setDraft(e.target.value)}
          onFocus={() => onFocusChange?.(true)}
          onBlur={() => onFocusChange?.(false)}
        />
        {/* preventDefault on mousedown keeps the INPUT focused when the button is tapped. Without it, iOS blurs the
            input first → the parent re-adds the call-control bar (composerFocused → false) → the layout shifts under
            the finger → iOS cancels the tap → "keyboard just closes, message not sent". Keeping focus also leaves the
            keyboard up for the next message (standard chat behaviour). The click still fires + submits the form. */}
        <button
          type="submit"
          disabled={!draft.trim() || (rg.active && !rg.canShare)}
          onMouseDown={(e) => e.preventDefault()}
        >
          ➤
        </button>
      </div>
    </form>
  )
}
