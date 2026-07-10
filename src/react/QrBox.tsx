import { useEffect, useState } from 'react'

/**
 * Render `text` as a QR code. The generator (`qrcode-generator`) is loaded with a
 * DYNAMIC import on first use, so in the app build it code-splits out of the entry
 * bundle (landing/room stay lean) and in the single-file widget build it's simply
 * inlined. The QR is drawn locally — the text never leaves the page.
 */
export function QrBox({ text, className }: { text: string; className?: string }) {
  const [svg, setSvg] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    setSvg(null)
    void import('../core/qr').then(({ qrSvg }) => {
      if (!live) return
      try {
        setSvg(qrSvg(text))
      } catch {
        setSvg(null) // unencodable (absurd length) — caller still shows the link
      }
    })
    return () => {
      live = false
    }
  }, [text])
  return svg ? (
    <div className={className} aria-label="QR code" dangerouslySetInnerHTML={{ __html: svg }} />
  ) : (
    <div className={className} aria-hidden="true" />
  )
}
