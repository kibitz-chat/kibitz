# Kibitz — Privacy Policy

> Source: https://kibitz.chat/privacy · Effective June 17, 2026

Kibitz is built to need as little of your data as possible: no accounts, no sign-ups, and no server in the path of your call.

## The short version
- No accounts. No name or email required to make a call.
- Your audio, video, and chat are peer-to-peer and end-to-end encrypted. Kibitz never sees, hears, stores, or records them.
- No analytics, no advertising, no tracking cookies — so there is no cookie banner, because there is nothing to consent to.
- The servers only ever handle the minimum needed to introduce two browsers to each other.

## What stays on your device
Your display name, avatar, and preferences are saved in your browser's local storage. They never leave your device and are never sent to the servers.

## What the servers briefly handle
- **Signaling.** To introduce two browsers, a signaling server momentarily exchanges connection setup data — a temporary random peer ID, the room name contained in your link, and network "ICE candidates" (which include IP addresses). Used in the moment to establish the connection; not stored. If the signaling worker is briefly unavailable, the call retries the last-known-good self-hosted broker (or the default, `signal.kibitz.chat`) — it never uses a public broker; like any signaling service it sees only this connection metadata (the random peer ID, room id, and ICE candidates) — never your call's audio, video, or messages, which stay end-to-end encrypted.
- **TURN relay.** If your networks can't connect directly, your already-encrypted media is relayed so the call still works. The relay forwards encrypted packets and cannot decrypt them; it processes IP addresses and traffic volume only to route the call.
- **Hosting.** The kibitz.chat website is served by Cloudflare, which may keep standard server logs (IP address, timestamp, browser type) under its own policy.
- Kibitz does not record calls, build profiles, sell data, or serve ads.

## A note on IP addresses
Peer-to-peer calls work by browsers connecting directly, so participants' browsers can see one another's IP addresses. This is inherent to WebRTC, not specific to Kibitz. When a call is relayed (TURN), peers see the relay's address instead of each other's.

You can choose to hide your IP from other participants: turning on **"hide my IP" (relay-only)** routes your traffic through the TURN relay, so other participants see the relay's address instead of yours. It's a per-device choice you control (not a room setting), it may add a little latency, and it is fail-closed — if no relay is reachable, the call will not connect rather than expose your IP. The relay itself, and whoever is hosting the room, still see your IP; your audio, video, and chat stay end-to-end encrypted (the relay only forwards encrypted packets it cannot read). This holds even when another participant is on your same local network — a direct local connection would reveal your IP, so the call is relayed instead. (For a local-only call that stays on your network with no relay at all, use offline / same-Wi-Fi mode.)

## Service providers
On kibitz.chat, Cloudflare provides website hosting, DNS, signaling, and the TURN relay, processing the limited connection data above on Kibitz's behalf. No other third-party processors, analytics, or advertising networks are used on the site.

## Self-hosting note
Kibitz is open source. If you run the build on a host that does not provide its own signaling and TURN endpoints (`/api/signal` and `/api/turn`), it falls back to kibitz.chat's own signaling broker (`signal.kibitz.chat`) and Google's public STUN server; there is no public-TURN fallback, so a call that needs a relay won't connect unless you provide your own TURN endpoint. Like any signaling/STUN service, these see only connection metadata (IP addresses and ICE candidates); they never receive your call's audio, video, or messages, which stay end-to-end encrypted. kibitz.chat provides its own endpoints, so it does not use these; if you self-host, point those endpoints at infrastructure you control — or disclose this — for your users.

## Children
Kibitz is not directed to children under 13 and does not knowingly collect information from them — indeed it does not knowingly collect identifiable information from anyone.

## Changes
This policy may be updated; the effective date above will change, and significant changes will be noted.

## Who operates Kibitz & contact
Operated by "the Kibitz project." Privacy questions: privacy@kibitz.chat.
