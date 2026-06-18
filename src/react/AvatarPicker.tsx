import type { ReactElement } from 'react'

const CHOICES = ['', '🦊', '🐸', '🦉', '🐼', '🦁', '🐙', '🦄', '🐢'] as const

/** Emoji avatar row — '' means "use my initial". Shown while the camera is off. */
export function AvatarPicker({ value, onChange }: { value: string; onChange: (a: string) => void }): ReactElement {
  return (
    <div className="avatars" role="radiogroup" aria-label="Avatar">
      {CHOICES.map((a) => (
        <button
          key={a || 'none'}
          type="button"
          className={`avatar-pick${value === a ? ' picked' : ''}`}
          onClick={() => onChange(a)}
          title={a ? `Appear as ${a}` : 'Use your initial'}
        >
          {a || 'Aa'}
        </button>
      ))}
    </div>
  )
}
