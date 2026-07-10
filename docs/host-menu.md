# Host-menu seam — a brand-injected, agent-enabled in-call menu

A generic way for an **agent** to surface a **brand-owned** menu inside a Kibitz call (e.g. "Rate the
agent"). Kibitz stays agnostic: it only frames a page on a **build-fixed origin** and passes non-secret
call context. The page is the brand's own origin, so it talks to the brand's backend directly. Rating is
the first consumer; the mechanism is general (tip, survey, notes, …).

## Why this shape
The agent must NOT be in the menu's data path — for rating, the agent is the rated party and never holds
the user's wallet/coupon. So the menu is the **brand's** page (its own origin → its own storage + backend),
and the agent can only **turn it on**. Kibitz locks the origin so a malicious agent can't point the frame
at a phishing site.

## 1. Agent enables it (in its `agent-actions@1` manifest)
The agent already publishes `registerSchema('agent-actions', …)`. Add a `hostMenu`:

```jsonc
{
  "kind": "agent-actions@1",
  "agent": "Expert 🧐",
  "actions": [ /* … normal agent actions … */ ],
  "hostMenu": {
    "path": "rate",            // relative path on the brand origin (required)
    "label": "Rate the agent", // button text (≤40 chars)
    "placement": "controls",   // controls | stage | tile | chat  (default: chat)
    "agent": "kibitzer"        // the agent's OWN marketplace id → passed to the page as ?agent=
  }
}
```

## 2. Build configures the allowed origin
`menuOrigin` — the ONLY origin Kibitz will frame. Via the composable mount (`Kibitz.mount({ menuOrigin })`)
or the `Widget` `menuOrigin` prop. Must be `https:`. Unset → host menus are **disabled** (default; kibitz.chat
unaffected). A rebrand can later source it from `VITE_BRAND_MENU_ORIGIN`.

## 3. Kibitz renders + frames it (`src/widget/hostMenu.ts`, `HostMenuBar.tsx`)
- A button (`label`) appears at `placement` for each present agent that enabled one.
- Click → opens `\${menuOrigin}/\${path}?room=<roomId>&rater=<selfId>&agent=<agent>` in a sandboxed `<iframe>`
  (`allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox`). `rater` is the
  clicking participant's **in-call self id** — so the brand page can submit a **presence-based** rating with no
  coupon (any participant rates; the backend takes the median per call). Non-secret call context, like `room`.
- **Origin lock:** `path` is resolved *relative* to `menuOrigin`; if it escapes the origin (protocol-relative
  `//host`, absolute URL, scheme, off-origin `..`) the menu is **rejected**. The agent can never choose the origin.

## 4. The brand page does the rest (on its own origin)
It reads its own storage (e.g. the coupon) and calls its own backend — Kibitz never sees any of it. For
rating, the page `POST`s `{ roomId, agentId, coupon, stars }` to its control plane.

## 5. The page can close itself
`window.parent.postMessage({ type: 'kibitz:hostmenu', action: 'close' }, '<the page's own origin>')` dismisses
the panel (e.g. after submitting). Kibitz only honors messages whose `event.origin` is the locked `menuOrigin`.
Escape and a backdrop click also close it.

## Other uses
Nothing here is rating-specific — Kibitz only frames a trusted page and passes `room`/`agent`. The same seam
fits a **tip jar**, a **post-call survey**, a **shared notes/CRM panel**, a **booking/upsell** step, etc. The
brand owns the page and the logic; Kibitz owns only the origin lock and the frame.

## Security summary
- **Origin-locked** — the frame's origin is the build's `menuOrigin`, never anything the agent supplies.
- **Sandboxed iframe** — `allow-same-origin` lets the *brand* page reach its *own* storage/backend; it does
  not grant access to the host page's data (the page runs as its own origin).
- **PostMessage is origin-checked** — only messages from `menuOrigin` can close the panel.
- **No secrets through Kibitz** — the coupon/credential lives in the brand page's own origin; Kibitz only
  ever sees `room`, the participant's in-call `rater` id, and the opaque `agent` id — all non-secret call context.

## Where it lives
`src/widget/hostMenu.ts` (pure parse + origin-lock; tests in `hostMenu.test.ts`), `HostMenuBar.tsx` (the
trigger + iframe panel), the `Widget`/`mount` `menuOrigin` option, and `brand.menuOrigin`
(`VITE_BRAND_MENU_ORIGIN`). Off by default — a build with no `menuOrigin` has no host menus.
