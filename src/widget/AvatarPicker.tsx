import { EmojiAvatar } from '../react/CallSurface'

// The original card-game app's avatar set, verbatim.
const AVATARS = ['😀', '😎', '🤓', '🥳', '😺', '🦊', '🐼', '🐵', '🦁', '🐸', '🐯', '🐨', '🤖', '👽', '🦄', '🐲', '🔥', '⭐']

// The in-call avatar picker: an emoji grid plus a "use your initials" option. Picking sets the avatar and closes
// the picker. Purely presentational (the avatar lives in useCall); extracted from Widget.tsx. The kw-av* classes
// are global (shadow-rooted), so keep them verbatim.
export function AvatarPicker({
  avatar,
  setAvatar,
  onPick,
}: {
  avatar: string
  setAvatar: (a: string) => void
  onPick: () => void
}) {
  return (
    <div className="kw-avatars">
      <button
        className={`kw-av${avatar ? '' : ' sel'}`}
        onClick={() => {
          setAvatar('')
          onPick()
        }}
        title="Use your initials"
      >
        🔤
      </button>
      {AVATARS.map((a) => (
        <button
          key={a}
          className={`kw-av${avatar === a ? ' sel' : ''}`}
          onClick={() => {
            setAvatar(a)
            onPick()
          }}
        >
          <EmojiAvatar value={a} />
        </button>
      ))}
    </div>
  )
}
