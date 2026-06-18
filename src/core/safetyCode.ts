/**
 * Safety code (SAS) — let two people detect a man-in-the-middle on their call.
 *
 * WebRTC media is end-to-end encrypted (DTLS-SRTP), but the certificate
 * fingerprints that pin the keys are exchanged over the SIGNALING channel — so a
 * malicious or compromised signaling server could swap them and sit in the middle.
 * This derives a short, human-comparable code from the two ACTUAL DTLS certificates
 * (yours + the one you truly handshook with). Two honest peers compute the SAME
 * code; a MITM is forced to use a different cert on each leg (it can't present your
 * peer's cert without their private key), so the codes differ and the humans notice.
 *
 * CRUCIAL: the remote fingerprint comes from the negotiated cert
 * (`RTCDtlsTransport.getRemoteCertificates()`), NOT the SDP `a=fingerprint` — the
 * latter is exactly what a malicious signaling server controls, so it would detect
 * nothing. Your own fingerprint comes from your local SDP (it's your own cert;
 * signaling can't change which cert YOU present).
 */

// 32 single-grapheme, visually-distinct emoji (5 bits each) — meant to be compared
// at a glance ("do we both see these four?"), not necessarily said aloud.
export const SAFETY_ALPHABET = [
  '🦊', '🐢', '🐙', '🦉', '🦋', '🐝', '🐬', '🦄',
  '🌊', '🌙', '🌈', '🔥', '🌵', '🍄', '🍀', '🌻',
  '🍋', '🍉', '🍓', '🔑', '🎈', '🚀', '💎', '🎯',
  '🎸', '🧭', '🧩', '🪁', '🎺', '🐳', '🍒', '🐡',
] as const

const enc = new TextEncoder()

async function sha256(bytes: ArrayBuffer | Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))
}

/**
 * Pure: an N-emoji code from two cert fingerprints, ORDER-INDEPENDENT (both peers
 * pass {mine, theirs} in opposite order yet get the same code). Default 4 symbols
 * ≈ 20 bits — a MITM has ~1-in-a-million chance of matching by luck.
 */
export async function safetyCode(fpA: string, fpB: string, symbols = 4): Promise<string> {
  const pair = [fpA.trim().toLowerCase(), fpB.trim().toLowerCase()].sort().join('|')
  const digest = await sha256(enc.encode(pair))
  return Array.from({ length: symbols }, (_, i) => SAFETY_ALPHABET[digest[i] & 31]).join(' ')
}

/** SHA-256 fingerprint (colon-hex) of a DER certificate. */
async function fingerprintOfDer(der: ArrayBuffer): Promise<string> {
  const d = await sha256(der)
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join(':')
}

interface DtlsLike {
  getRemoteCertificates?: () => ArrayBuffer[]
}
interface PcLike {
  sctp?: { transport?: DtlsLike } | null
  getSenders?: () => { transport?: DtlsLike | null }[]
  getReceivers?: () => { transport?: DtlsLike | null }[]
  localDescription?: { sdp?: string } | null
}

/**
 * Extract {local, remote} ACTUAL DTLS fingerprints from a connected peer
 * connection, or null when the browser doesn't expose the negotiated remote cert
 * (then there's no honest code to show — feature-detected, not faked).
 */
export async function pcFingerprints(pc: PcLike): Promise<{ local: string; remote: string } | null> {
  try {
    const dtls: DtlsLike | undefined =
      pc.sctp?.transport ??
      pc.getSenders?.().find((s) => s.transport)?.transport ??
      pc.getReceivers?.().find((r) => r.transport)?.transport ??
      undefined
    const remoteCerts = dtls?.getRemoteCertificates?.()
    if (!remoteCerts || !remoteCerts.length) return null
    const remote = await fingerprintOfDer(remoteCerts[0])

    const m = /a=fingerprint:sha-256 ([0-9A-Fa-f:]+)/.exec(pc.localDescription?.sdp ?? '')
    if (!m) return null
    return { local: m[1].toLowerCase(), remote }
  } catch {
    return null
  }
}

/** The safety code for a connected peer connection, or null if unavailable. */
export async function computeSafetyCode(pc: PcLike): Promise<string | null> {
  const fps = await pcFingerprints(pc)
  return fps ? safetyCode(fps.local, fps.remote) : null
}

/** A peer's safety reading: the emoji code to compare aloud, plus the remote DTLS
 *  fingerprint it was derived from — the latter lets the UI notice when a peer
 *  reconnects with different key material (prior verification no longer holds). */
export interface SafetyInfo {
  code: string
  /** Remote cert fingerprint — stable per live peer connection (a change = a new
   *  remote identity / reconnect, worth surfacing). */
  remoteFp: string
}

/** {code, remoteFp} for a connected peer connection, or null if unavailable
 *  (no negotiated remote cert exposed, or not yet connected). */
export async function safetyInfo(pc: PcLike): Promise<SafetyInfo | null> {
  const fps = await pcFingerprints(pc)
  return fps ? { code: await safetyCode(fps.local, fps.remote), remoteFp: fps.remote } : null
}
