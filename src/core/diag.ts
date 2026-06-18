/**
 * A tiny global diagnostic line, surfaced in the widget's ?debug overlay so
 * WebRTC/broker failures are visible ON A PHONE (where there's no console). The
 * data/media transports write the latest notable event here (peer errors,
 * connection phase, give-up reason); the overlay reads it on each render.
 */
let line = ''

export function setDiag(s: string): void {
  line = s
}

export function getDiag(): string {
  return line
}
