# Large-transfer — device-test runbook (the gate before any flag defaults on)

The large-transfer stack (`docs/large-transfer.md`) is **fully unit-tested but integration-untested**: the
pure logic has hundreds of vitest cases, but the live wire — PeerJS binary delivery, iOS OPFS, the resume reconnect —
has no in-process double (content rides the media data mesh; kibitz vitest is node-only). So **two real devices
are the gate** before any `kbz.xfer*` flag defaults on. This is that test, made turnkey.

## Flags — now DEFAULT-ON
All four are **on by default** (the product owner flipped them). You don't need to enable anything — just open
the app on two devices. To **disable** one on a device (the regression row, or to kill a misbehaving path), set
its key to `'0'` and reload:
```js
localStorage.setItem('kbz.largeXfer','0')   // stream >50MB to disk (OPFS / FSA)
localStorage.setItem('kbz.xferV2','0')      // binary chunk frames (no base64)
localStorage.setItem('kbz.xferHash','0')    // SHA-256 integrity
localStorage.setItem('kbz.xferResume','0')  // resume a stalled/reloaded transfer
```
Features are still negotiated (both peers must have a flag on for it to engage — they are, by default).

## The matrix

| # | Flag(s) | Setup | Do | PASS = |
|---|---|---|---|---|
| 1 | largeXfer | Desktop↔Desktop (Chrome) | Send a ~200 MB file | Arrives; **heap stays flat** in DevTools Memory on both ends (not +200 MB); chip shows progress → done; bytes **hash-identical** to source |
| 2 | largeXfer | Desktop→**iPhone** (Safari PWA) | Send ~200 MB | **Arrives** (OPFS engaged) — vs. silently capped at 50 MB (createWritable fell back to MemSink). This answers the make-or-break iOS question |
| 3 | largeXfer+xferV2 | D↔D | Send an image + a file | Renders/saves correctly; agent log / no errors → **PeerJS delivered the Uint8Array as binary** (the v2 unknown) |
| 4 | +xferHash | D↔D | Send a file; **also** test a corrupt path if possible | Good file = done; a corrupted transfer = "transfer failed" (not silently delivered) |
| 5 | +xferResume (same-session) | D↔D, send ~500 MB, mid-transfer **kill Wi-Fi ~10 s then restore** | Transfer **continues** from where it paused (chip resumes), completes hash-identical — not restarts/fails |
| 6 | +xferResume (cross-reload) | D→D salted room, send ~500 MB, mid-transfer **reload the RECEIVER tab** | On reload the receiver shows a **resuming** chip and **completes** the download (continues from the OPFS partial) |
| 7 | largeXfer+xferDl (FSA) | D↔D (Chrome) | Send a **>1 GB** file | Receiver sees **"Accept & save"** → picks a location → streams to that file → **"✓ Saved to disk"**, byte-identical |
| 8 | regression (all flags **OFF** via `='0'`) | any pair | Send a small image | Identical to today (inline, no chips/handshake) |

## Verify byte-identity
`shasum -a 256 source` on the sender vs the saved/downloaded file on the receiver — must match. (Row 4 already
checks this over the wire; rows 1/2/7 check it end-to-end to disk.)

## Watch for (the known risks)
- **Row 2 (iOS):** if a 200 MB file *fails* or caps at 50 MB → iOS Safari lacks `createWritable`; we need the
  OPFS **Worker + `createSyncAccessHandle`** path (deferred). If it *works*, that path is unnecessary.
- **Row 3 (binary):** if files arrive corrupt/empty with `xferV2` on but fine with it off → PeerJS isn't
  round-tripping binary; keep `xfer.v2` off until fixed.
- **Rows 5/6 (resume):** if a drop *fails* instead of resuming → the mesh isn't re-establishing the
  `DataConnection`, or the sender's `activeSend` didn't survive; capture timing.
- **Memory (rows 1/5):** the whole point — heap must NOT grow by the file size. If it does, the lazy
  slice / disk sink isn't engaging (check the flag + OPFS support).

## ⚠️ Status: flags are DEFAULT-ON but NOT YET device-validated
The flags were flipped default-on at the product owner's direction **before** this runbook was run. That means
**a deploy of the shared kibitz branch ships these paths live to kibitz.chat + branded siblings for everyone at
once.** So: **do not deploy this branch until this runbook passes.** If a row fails on-device, either fix it or
set that flag's default back to off (in `xferFlagOn`/the per-flag fn in `src/react/useCall.ts`) before any
deploy. A failing path can be killed per-device immediately with `localStorage['kbz.<flag>']='0'`.
