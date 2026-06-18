# Security Policy

## Reporting a vulnerability

Please report security issues **privately** to **security@kibitz.chat** rather than opening a
public issue, and give us a reasonable chance to fix it before any public disclosure. Include
enough detail to reproduce (affected version/commit, steps, and impact). We aim to acknowledge
reports promptly and will credit reporters who want it.

Kibitz is **pre-1.0**; please report against the latest `main` / the deployed kibitz.chat.

## Scope & threat model

Kibitz is account-free and serverless: media and content go **end-to-end encrypted, directly
between browsers** — no server can decode or record a call. The full model (what the signaling
broker / TURN relay / room authority / LAN relay can and cannot see, and what is *not* protected)
is documented at:

- **<https://kibitz.chat/security>** — how calls work + the safety code.
- **<https://kibitz.chat/transparency>** — what's open, who sees what.
- **[docs/threat-model.md](docs/threat-model.md)** — the engineering threat model.

In scope: the engine, the widget/headless API, the verification gate + cert-binding, the
participant-capability layer, the Cloudflare Pages functions (`functions/api/*`), and the LAN
relay protocol. Out of scope: third-party providers (Google OIDC, Cloudflare), and the
deployment configuration of kibitz.chat itself (operational, not part of the redistributable build).

## What helps a report land

- Cert-binding / verification bypasses, MITM that the safety code wouldn't catch.
- Capability-gate escapes (a read-only agent receiving media or getting an act accepted).
- Admission-gate bypasses (an unverified/uninvited peer entering a `require` room's roster).
- Content reaching a party that shouldn't have it (a relay or authority seeing message content).
- Secret/identity leakage in the build or repo.
