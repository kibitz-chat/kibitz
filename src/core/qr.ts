import qrcode from 'qrcode-generator'

/**
 * Render `text` as a self-contained, scalable QR <svg> string — generated locally,
 * with NO network and NO third-party image service, so a room link never leaks to
 * anyone (the whole point of Kibitz). Error-correction 'M' stays scannable with a
 * little blur/glare; typeNumber 0 auto-sizes to the data; `scalable` uses a viewBox
 * so CSS controls the on-screen size. The dark modules are transparent-on-nothing —
 * render it on a white box (the quiet zone needs light behind it to scan).
 */
export function qrSvg(text: string): string {
  const qr = qrcode(0, 'M')
  qr.addData(text)
  qr.make()
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true })
}
