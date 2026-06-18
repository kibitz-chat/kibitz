import { useEffect, useRef, useState } from 'react'
import { buildHelpPrompt, HELP_SOURCES } from './helpPrompt'

// Robust copy: the async Clipboard API needs a secure context + gesture (we have the gesture); fall
// back to selecting a hidden textarea + execCommand for http/older browsers. Returns success.
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* fall through to the legacy selection copy */
  }
  try {
    const el = document.createElement('textarea')
    el.value = text
    el.style.position = 'fixed'
    el.style.opacity = '0'
    document.body.appendChild(el)
    try {
      el.focus()
      el.select()
      return document.execCommand('copy')
    } finally {
      document.body.removeChild(el) // always detach, even if execCommand throws (no stale DOM node)
    }
  } catch {
    return false
  }
}

// Where to paste it. Just opens the assistant in a new tab — the flow is: copy here → open your
// assistant → paste. All three can browse the web (which the prompt relies on).
const ASSISTANTS: { name: string; url: string }[] = [
  { name: 'ChatGPT', url: 'https://chatgpt.com/' },
  { name: 'Claude', url: 'https://claude.ai/new' },
  { name: 'Gemini', url: 'https://gemini.google.com/app' },
]

/**
 * The Help / support page (route `#help`). Gives the visitor ONE copyable prompt that turns any AI
 * assistant into a Kibitz support agent: it points the assistant at the live product docs (which it
 * reads with web access) so it can answer anything about the app. No accounts, no support queue.
 */
export function HelpPage({ onBack }: { onBack: () => void }) {
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    document.body.classList.add('paper')
    return () => document.body.classList.remove('paper')
  }, [])
  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current)
    },
    [],
  )

  const prompt = buildHelpPrompt()

  const onCopy = async () => {
    const ok = await copyText(prompt)
    if (!ok) return
    setCopied(true)
    if (copyTimer.current) clearTimeout(copyTimer.current)
    copyTimer.current = setTimeout(() => setCopied(false), 3000)
  }

  return (
    <main className="installpage helppage">
      <button className="back-link" type="button" onClick={onBack}>
        ← Back
      </button>
      <h1>Get help with Kibitz</h1>
      <p className="sub">
        Have a question? <strong>Copy the prompt</strong> below and paste it into ChatGPT, Claude, Gemini, or any AI
        assistant <em>with web access</em>. It reads the Kibitz manual for itself, so it can answer anything you ask —
        how to start a room, share your screen, who can join, how the encryption works, and more.
      </p>

      <div className="help-actions">
        <button className="help-copy start" type="button" onClick={onCopy}>
          {copied ? '✓ Copied — now paste it into your assistant' : '📋 Copy the prompt'}
        </button>
      </div>

      <section className="help-open">
        <h2>Then open your assistant and paste</h2>
        <div className="help-assistants">
          {ASSISTANTS.map((a) => (
            <a key={a.name} className="help-assistant" href={a.url} target="_blank" rel="noopener noreferrer">
              {a.name} ↗
            </a>
          ))}
        </div>
        <p className="hint">Opens in a new tab — paste the prompt as your first message, then ask away.</p>
      </section>

      <details className="help-preview">
        <summary>See / select the prompt</summary>
        <textarea
          className="help-text"
          readOnly
          value={prompt}
          rows={10}
          aria-label="The support prompt to copy"
          onFocus={(e) => e.currentTarget.select()}
        />
      </details>

      <p className="hint help-self">
        Prefer to read it yourself? The full manual is at{' '}
        <a className="demo-link" href="/manual" target="_blank" rel="noopener noreferrer">
          /manual
        </a>{' '}
        and the engine docs at{' '}
        <a className="demo-link" href="/docs">
          /docs
        </a>
        .
      </p>

      <footer className="fine">
        <p className="fine-links">
          <a href="/privacy">Privacy</a> · <a href="/security">Security</a> · <a href="/docs">Engine</a> ·{' '}
          <a href={HELP_SOURCES.github} target="_blank" rel="noopener noreferrer">
            GitHub
          </a>
        </p>
      </footer>
    </main>
  )
}
