# Widget security model

Kibitz widgets come in two tiers. This documents the **bounded tier** (the one that's built) — its real
residual attack surface and the mitigations — and the requirements any future **open tier** must meet.

## The two tiers

- **Bounded (built).** The agent sends a typed payload `{kind, data}`; a *first-party* renderer
  (`src/widget/widgets/*`) draws it after a sanitizer validates the data at the receive boundary. **No
  third-party code runs.** Kinds: `table`, `doc`, `media`, `chart`, `diagram`, `form`.
- **Open (NOT built).** A third-party MCP server returns HTML/JS/a URL rendered in a sandboxed iframe over a
  `postMessage` bridge (MCP Apps UI / mcp-ui; the dormant host-menu seam, `VITE_BRAND_MENU_ORIGIN`). Its value
  (run any UI) is its risk (run any code). Reserved for the long tail; see "Open tier requirements" below.

## Bounded-tier residual surface + mitigations

No agent code runs, so the surface is small — but not zero. Ranked:

1. **Diagram (Mermaid) — dependency-trust.** Agent `source` → Mermaid parser → SVG via
   `dangerouslySetInnerHTML`. Run in `securityLevel:'strict'`; Mermaid has XSS CVE history.
   *Mitigations:* strict mode **+** a 2nd-layer DOM walk (`sanitizeHtml.ts`, `stripDangerousHtml`) that drops
   `script`/`iframe`/`foreignObject`/`on*`/`javascript:`/url-bearing `<style>` from the output; **pinned**
   version (`mermaid 11.15.0`) so a CVE is a tracked bump, not a floating `^`.
2. **Chart (Vega) — engine trust + spec completeness.** `chart.ts` deep-strips every `url`/`loader` key
   (kills `data.url`, dataset/topojson feeds, the image-mark url channel → no SSRF) and caps depth/nodes/bytes.
   Residual: trusting Vega's expression interpreter (sandboxed; no DOM/network) and that url/loader are the
   complete fetch set. **Pinned** `vega-embed 7.1.0`; `actions:false`.
3. **Doc (Markdown) — our renderer's correctness.** Hand-rolled subset (`doc.ts`): all text escaped *first*,
   only known-safe tags wrapped, links http(s)-only. *Mitigations:* line-count cap (DoS), the same
   `stripDangerousHtml` 2nd layer, and **link-destination transparency** — an external link shows its real host
   (`kw-doc-host`) so `[click here](https://evil)` can't hide where it goes.

Cross-cutting (applies to all kinds, including Table/Media/Form which are otherwise ~zero):

4. **Malicious content, not code.** Sanitizers stop execution, not *intent* — a Doc can still carry a phishing
   link, a Form a deceptive label, a Table false data, and native rendering looks more trustworthy than chat.
   *Mitigations:* link-host transparency (Doc); roster-derived attribution on every widget; **secrets/identity
   prompts are never rendered by a widget** — the host owns those.
5. **Who-can-post / staging.** See the policy below.
6. **Second-order injection.** Form submissions ride `wevt` back to the agent. A consumer (the brain, another
   renderer) must treat submitted values as untrusted input. Not yet wired to the agent brain — when it is, it
   must sanitize before use as LLM input / tool args.
7. **Lower-order.** Media trusts allowlisted hosts that may carry attacker-*uploaded* content (Wikimedia) — fine
   for images, thin codec vector for video; vega/mermaid add a supply-chain + per-peer CPU/mem-DoS surface
   (bounded by size caps). Media is `<img>/<video>/<audio src=allowlisted>` only (no SVG-as-document).

## Staging / who-can-post policy (explicit)

- **Delivery = chat.** A posted widget is delivered to every peer (like a chat message). Delivery is not gated
  beyond the room's existing roster/capability layer.
- **Stage = collaborative, attributed, reversible.** Putting a widget on the shared stage uses the same
  newest-wins roster pointer as screen-presenting; **any** participant may also take **any** widget *off* the
  stage (moderation). Every staged widget shows **roster-derived** attribution (`staged by X` / the poster's
  name) — unspoofable, taken from the roster, not the wire.
- **Local dismiss.** Any recipient can remove a widget from **their own** view (`🚫 Dismiss`) — anti-spam /
  anti-phishing, independent of the shared stage.
- **No secret prompts.** Widgets never render credential/identity prompts; those stay host-owned.

## Open tier — the `kbz.app` skeleton (built, DORMANT)

A minimal, secure skeleton now exists (`widgets/app.ts` + `AppWidget.tsx`) and is **off by default**:

- **Author-allowlisted + off by default.** `sanitizeApp` accepts a `url` only if its host is in
  `VITE_WIDGET_APP_ORIGINS` (https only, subdomains ok, suffix-spoofs rejected), and raw `html` only if
  `VITE_WIDGET_APP_ALLOW_HTML=1`. With neither set it returns `null` and the kind is **not even registered**
  (`appTierEnabled()` is false) — an unconfigured build doesn't know `kbz.app` exists.
- **Sandboxed, opaque origin.** `sandbox="allow-scripts allow-popups allow-forms"` — no `allow-same-origin`
  (so the frame can't reach the parent), no `allow-top-navigation` (can't hijack the tab), no modals/downloads.
- **Narrow validated bridge.** The host accepts a postMessage only when `event.source` is this iframe's window
  AND `event.origin === 'null'` (the sandbox's opaque origin), and only the shapes `{__kbzApp, t:'resize',
  height}` (clamped) and `{t:'event', payload}` (JSON-reduced, ≤8KB, rides `wevt` like a form submit). There is
  **no** tool-call / chat / init-context capability — the app can resize itself and emit an opaque event, nothing
  more.
- **Visual attribution.** Renders with a `🔒 … sandboxed` bar so it's never mistaken for first-party chrome.

Verified: gating unit tests (default-off, allowlist, https-only, suffix-spoof) + an e2e bridge test (resize +
event flow through a real sandboxed frame). **Not wired to any agent tool** — exposing it to a marketplace
agent is a separate, deliberate step. What it still needs before real use is below.

## Open-tier requirements (gate before exposing)

Before this is enabled for real (allowlisted authors + an agent tool), it must add: a **distinct opaque origin**
+ `sandbox` without `allow-same-origin` (done);
strict CSP (`connect-src`/`script-src` pinned, no remote script); a **narrow, schema-validated** postMessage
bridge with `origin`+`source` checks and a capability allowlist (never "call any tool" / "send chat as user");
**author-allowlisted** (origin-locked, off by default); clear visual attribution; shared-aware (only the owner
stages it, interactions don't auto-run as host actions, each peer sandboxes independently); and resource
**pinning** (hash the payload, forbid remote scripts). Prefer a constrained remote-DOM/component model over raw
HTML. It is **off and unbuilt** until that surface is reviewed and greenlit.
