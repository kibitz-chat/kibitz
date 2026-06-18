# Kibitz — Technical Documentation

The engineering docs for Kibitz: an account-free, serverless, peer-to-peer call +
collaboration engine (embeddable + headless).

| Doc | What it covers |
|-----|----------------|
| [architecture.md](./architecture.md) | The system overview — the room model, the three transport planes (signaling / E2E media / E2E data), the composable engine, edge infra. **Start here.** |
| [verification.md](./verification.md) | **Who gets into a room** — the link-is-the-verifier principle and every verification method (open · OIDC identity · signed invites · name list · join code · email code), with the security analysis. |
| [cert-binding.md](./cert-binding.md) | **Serverless, peer-to-peer verified identity** (the "Level 3" scheme) — how an OIDC token is stapled to the live DTLS certificate so it's non-replayable and verifiable with no server. |
| [agent-protocol.md](./agent-protocol.md) | The **agent wire/SDK protocol** — perception/action envelopes over the data channel, the two perception sources, the SDK surface. |
| [agent-platform.md](./agent-platform.md) | The **agent platform** — protocol → SDK → the three runtimes (Chromium / browserless Node / MCP server), live validation, quickstart. |
| [threat-model.md](./threat-model.md) | **What's protected and what isn't** — the trust model, scope boundaries, admission attacks, the agent surface. |
| [offline-mode.md](./offline-mode.md) | **Same-Wi-Fi / LAN rooms with no internet** — the tiny self-hosted LAN hub that replaces the internet broker so a call (or an embedded site) keeps working offline. |
| [wake-seam.md](./wake-seam.md) | **Ring an installed PWA into a room** — the identity-blind push seam an external wake provider drives. *Dev preview.* |

### The one-paragraph mental model

A room is a **link**. The first browser to open it coordinates **presence** (roster, lobby,
the verification gate); that role **migrates** if it leaves. **Media and data go directly
between browsers, end-to-end encrypted** — no server can decode or record a call. **Who may
enter** is decided by the link itself: it carries a *verifier*, never a secret, so any
authority can check a joiner's credential with no server and no stored state. **Agents** join
that same room as participants over the same channel — perceive and act through the SDK.
