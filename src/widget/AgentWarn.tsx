// The pre-join AI-assisted-call consent notice: warns that what you say (and your camera/video, for an audiovideo
// agent) plus the messages you send may be recorded and sent to third-party services, and that joining = consent.
// A room-SPECIFIC disclosure (`notice`, e.g. "an AI agent from kibitz.chat is on this call") is folded in as a
// sub-line of THIS one banner rather than a second box — the generic consent + the specifics used to render as two
// near-identical warnings (one red, one yellow). Extracted from Widget.tsx's pre-join screen. Global classes.
export function AgentWarn({ agentCall, notice }: { agentCall?: 'audio' | 'audiovideo'; notice?: string }) {
  if (!agentCall && !notice) return null
  const av = agentCall === 'audiovideo'
  return (
    <div className="kw-agentwarn" role="alert">
      <div className="kw-agentwarn-h">
        <span aria-hidden="true">🤖</span> AI-assisted call{av ? ' (audio + video)' : ' (audio)'}
      </div>
      {notice && <p className="kw-agentwarn-note">{notice}</p>}
      <p className="kw-agentwarn-b">
        {av
          ? 'What you say, your camera/video, and the messages you send may be recorded and sent to third-party services for processing. By joining, you consent.'
          : 'What you say — and the messages you send — may be recorded and sent to third-party services for processing. By joining, you consent.'}
      </p>
    </div>
  )
}
