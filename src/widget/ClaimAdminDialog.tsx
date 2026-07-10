// The "Claim admin" dialog: a host-password prompt that unlocks moderation (kick / lock / waiting room).
// Purely presentational — the parent (Widget) owns the password state and the claimHost() call. Extracted from
// Widget.tsx. The kw-* classes are global (shadow-rooted), so keep them verbatim.
export function ClaimAdminDialog({
  pw,
  err,
  onPwChange,
  onSubmit,
  onClose,
}: {
  pw: string
  err: boolean
  onPwChange: (v: string) => void
  onSubmit: () => void | Promise<void>
  onClose: () => void
}) {
  return (
    <div className="kw-hostmenu kw-claimadmin" role="dialog" aria-label="Claim admin">
      <div className="kw-hostmenu-head">
        <span>Claim admin</span>
        <button className="kw-hostmenu-x" onClick={onClose} aria-label="Close" title="Close">
          ✕
        </button>
      </div>
      <p className="kw-claim-hint">Enter the host password to unlock moderation (kick · lock · waiting room).</p>
      <input
        className="kw-claim-pw"
        type="password"
        value={pw}
        autoComplete="off"
        placeholder="Host password"
        onChange={(e) => onPwChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void onSubmit()
        }}
      />
      {err && <p className="kw-claim-err">That password didn’t work.</p>}
      <button className="kw-claim-go" onClick={() => void onSubmit()} disabled={!pw}>
        Claim admin
      </button>
    </div>
  )
}
