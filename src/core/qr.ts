import qrcode from 'qrcode-generator'

/**
 * Render `text` as a self-contained, scalable QR <svg> string — generated locally,
 * with NO network and NO third-party image service, so a room link never leaks to
 * anyone (the whole point of Kibitz). Error-correction 'L' (~7%) keeps a long link as
 * SPARSE as possible — an on-screen QR scanned at close range is a clean, high-contrast
 * source, so the extra recovery of 'M' only buys density (a denser code for a long
 * agent-room invite is HARDER to scan, not easier). typeNumber 0 auto-sizes to the data;
 * `scalable` uses a viewBox so CSS controls the on-screen size. The dark modules are
 * transparent-on-nothing — render on a white box (the quiet zone needs light to scan).
 */
export function qrSvg(text: string): string {
  const qr = qrcode(0, 'L')
  qr.addData(text)
  qr.make()
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true })
}
