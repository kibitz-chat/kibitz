import { useEffect, useRef, useState } from 'react'

type ScanStatus = 'starting' | 'scanning' | 'denied' | 'nocam' | 'unsupported'

/**
 * Live camera QR scanner — for JOINING a room by pointing at someone's room QR, on a phone
 * with no address bar (the installed PWA). Decoder is `jsQR` (pure JS), loaded with a DYNAMIC
 * import on open so it code-splits out of the entry/prerender bundle (mirrors QrBox). We don't
 * use the native BarcodeDetector: iOS Safari — the case this whole feature exists for — lacks it.
 *
 * The decoded text never leaves the page: it's fed straight to `onScan`, which returns true for a
 * real room (we stop) and false for any other QR (keep scanning, gently hinting).
 */
export function QrScanner({ onScan, onClose }: { onScan: (text: string) => boolean; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [status, setStatus] = useState<ScanStatus>('starting')
  const [notRoom, setNotRoom] = useState(false) // scanned a QR that wasn't a room

  // Keep onScan current without restarting the camera when the parent re-renders.
  const onScanRef = useRef(onScan)
  onScanRef.current = onScan

  useEffect(() => {
    let stream: MediaStream | null = null
    let raf = 0
    let cancelled = false

    const stop = () => {
      cancelled = true
      cancelAnimationFrame(raf)
      stream?.getTracks().forEach((t) => t.stop())
    }

    const start = async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setStatus('unsupported')
        return
      }
      try {
        // Rear camera for scanning a code held in front of you.
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      } catch (e) {
        if (cancelled) return
        const name = (e as DOMException)?.name
        setStatus(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : name === 'NotFoundError' ? 'nocam' : 'unsupported')
        return
      }
      if (cancelled || !videoRef.current) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }
      const video = videoRef.current
      video.srcObject = stream
      await video.play().catch(() => {
        /* autoplay quirks — the frame loop tolerates a not-yet-playing video */
      })

      const jsQR = (await import('jsqr')).default
      if (cancelled) return
      const canvas = document.createElement('canvas')
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) {
        setStatus('unsupported')
        return
      }
      setStatus('scanning')

      const tick = () => {
        if (cancelled) return
        const v = videoRef.current
        if (v && v.readyState >= 2 && v.videoWidth > 0) {
          const w = 360
          const h = Math.max(1, Math.round((v.videoHeight / v.videoWidth) * w))
          canvas.width = w
          canvas.height = h
          ctx.drawImage(v, 0, 0, w, h)
          const found = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' })
          if (found?.data) {
            if (onScanRef.current(found.data)) {
              stop() // a real room — the parent navigates away
              return
            }
            setNotRoom(true) // some other QR — keep looking
          }
        }
        raf = requestAnimationFrame(tick)
      }
      raf = requestAnimationFrame(tick)
    }

    void start()
    return stop
  }, [])

  const msg: Record<ScanStatus, string> = {
    starting: 'Starting camera…',
    scanning: notRoom ? 'That isn’t a room QR — point at the room’s code.' : 'Point at a room’s QR code.',
    denied: 'Camera access was blocked. Allow it in your browser settings, or paste the link instead.',
    nocam: 'No camera found — paste the link instead.',
    unsupported: 'This browser can’t open the camera — paste the link instead.',
  }
  const isError = status === 'denied' || status === 'nocam' || status === 'unsupported'

  return (
    <div className="qrscan">
      <video ref={videoRef} className="qrscan-video" muted playsInline aria-label="Camera viewfinder" />
      <p className={isError ? 'open-err' : 'hint'}>{msg[status]}</p>
      <button type="button" className="open-toggle" onClick={onClose}>
        Cancel
      </button>
      <p className="qrscan-build">build {__BUILD_ID__}</p>
    </div>
  )
}
