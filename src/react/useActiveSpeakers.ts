import { useEffect, useRef, useState } from 'react'
import type { CallParticipant } from './useCall'

// RMS (0..1) above which a participant counts as talking, with a short hold so the
// indicator doesn't strobe on the gaps between words.
const SPEAKING_RMS = 0.045
const HOLD_MS = 350

interface Node {
  source: MediaStreamAudioSourceNode
  analyser: AnalyserNode
  data: Uint8Array<ArrayBuffer>
  until: number
  stream: MediaStream // which stream this analyser taps — rebuild if it's replaced
}

/**
 * Detect who is currently talking by metering each participant's audio with the
 * Web Audio API (taps the stream for analysis only — never routed to the speakers,
 * so it can't echo). Returns the set of speaking participant ids. The AudioContext
 * is resumed on the first user gesture (iOS starts it suspended).
 */
export function useActiveSpeakers(participants: readonly CallParticipant[]): ReadonlySet<string> {
  const [speaking, setSpeaking] = useState<ReadonlySet<string>>(new Set())
  const ctxRef = useRef<AudioContext | null>(null)
  const nodesRef = useRef<Map<string, Node>>(new Map())

  // Build/drop analyser nodes to match the current participants and their streams.
  useEffect(() => {
    const AC =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AC) return
    let ctx = ctxRef.current
    if (!ctx) {
      ctx = new AC()
      ctxRef.current = ctx
    }
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {})
    const nodes = nodesRef.current
    const want = new Set<string>()
    for (const p of participants) {
      const stream = p.stream
      const track = stream?.getAudioTracks()[0]
      // Only meter a LIVE, audible source. Skip a missing/ended track AND a MUTED or DISABLED one
      // — your own mic when it's off (on iOS a muted mic track is attached at join for the
      // connection), or a muted peer. No point analysing silence, and an idle analyser graph keeps
      // iOS's audio engine needlessly awake — the source of the app-switch click when solo + muted.
      if (!stream || !track || track.readyState !== 'live' || track.muted || !track.enabled) continue
      want.add(p.id)
      const existing = nodes.get(p.id)
      if (existing && existing.stream === stream) continue // same stream → keep the analyser
      // New participant, OR the stream OBJECT was replaced — e.g. your own stream is
      // rebuilt when the real mic is swapped in on first unmute (lazy mic). Without
      // re-tapping the new stream, the meter keeps reading the old (silent) one, so
      // your own avatar never reacts to your voice.
      if (existing) {
        try {
          existing.source.disconnect()
        } catch {
          /* ignore */
        }
      }
      try {
        const source = ctx.createMediaStreamSource(stream)
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 512
        source.connect(analyser)
        const data = new Uint8Array(new ArrayBuffer(analyser.fftSize))
        nodes.set(p.id, { source, analyser, data, until: 0, stream })
      } catch {
        /* stream not analysable — skip */
      }
    }
    for (const [id, n] of nodes) {
      if (want.has(id)) continue
      try {
        n.source.disconnect()
      } catch {
        /* ignore */
      }
      nodes.delete(id)
    }
    // Park the audio engine when there's nothing to meter (e.g. solo + mic off) — keeps iOS's
    // audio session asleep so a gesture has nothing to re-activate (the click). The resume above
    // wakes it again the moment a live, audible source appears.
    if (nodes.size === 0) void ctx.suspend().catch(() => {})
  }, [participants])

  // Resume the context on the FIRST gesture (iOS autoplay policy), then stop listening — and resume
  // again when the tab becomes visible (recovers after backgrounding). We deliberately do NOT resume
  // on EVERY pointerdown: iOS auto-suspends this inaudible analyser context, and re-activating the
  // audio session on each gesture made it emit an audible CLICK every time you dragged the app.
  useEffect(() => {
    const resume = () => void ctxRef.current?.resume().catch(() => {})
    const onFirstPointer = () => {
      resume()
      document.removeEventListener('pointerdown', onFirstPointer)
    }
    document.addEventListener('pointerdown', onFirstPointer, { passive: true })
    // Suspend this (visual-only) context while the app is backgrounded; resume when it's visible.
    // Reduces what iOS has to re-activate on a gesture — a try at shaving the standalone drag click.
    const onVis = () => {
      const ctx = ctxRef.current
      if (!ctx) return
      if (document.visibilityState === 'hidden') void ctx.suspend().catch(() => {})
      else void ctx.resume().catch(() => {})
    }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      document.removeEventListener('pointerdown', onFirstPointer)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [])

  // Meter loop.
  useEffect(() => {
    let raf = 0
    const tick = () => {
      const nodes = nodesRef.current
      const now = performance.now()
      setSpeaking((prev) => {
        const next = new Set(prev)
        let changed = false
        for (const [id, n] of nodes) {
          n.analyser.getByteTimeDomainData(n.data)
          let sum = 0
          for (let i = 0; i < n.data.length; i++) {
            const v = (n.data[i] - 128) / 128
            sum += v * v
          }
          const rms = Math.sqrt(sum / n.data.length)
          if (rms > SPEAKING_RMS) n.until = now + HOLD_MS
          const on = now < n.until
          if (on && !next.has(id)) {
            next.add(id)
            changed = true
          } else if (!on && next.has(id)) {
            next.delete(id)
            changed = true
          }
        }
        for (const id of next) {
          if (!nodes.has(id)) {
            next.delete(id)
            changed = true
          }
        }
        return changed ? next : prev
      })
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  // Tear the audio graph down on unmount.
  useEffect(() => {
    return () => {
      for (const n of nodesRef.current.values()) {
        try {
          n.source.disconnect()
        } catch {
          /* ignore */
        }
      }
      nodesRef.current.clear()
      void ctxRef.current?.close().catch(() => {})
      ctxRef.current = null
    }
  }, [])

  return speaking
}
