# Kibitz — Offline mode: same-Wi-Fi rooms (beta)

> Source: https://kibitz.chat/relay

Everyone on the same Wi-Fi, together — with no internet at all.

For a plane, a cabin, an event with dead cell, or an office with no guest internet: one device runs a tiny LAN hub; everyone else opens Kibitz on the same Wi-Fi and you're in a room together. No accounts, no internet.

It's one download on one always-on-ish device (a laptop, a Mac, a Raspberry Pi), then everyone scans a QR once. The LAN hub is open source; the downloads and a short step-by-step setup live on GitHub.

**What the LAN hub sees:** like the internet broker, the LAN hub is a **coordination point** — it sees *who's* in the room (presence/roster) and carries the connection handshakes, but your **content — video, voice, chat — goes peer-to-peer between the browsers, not through the hub**, so it can't read it. And it's a box *you* run on *your own* Wi-Fi: nothing leaves your network.

(This is unrelated to the **TURN relay**: TURN forwards an *internet* call's encrypted media when a direct connection is blocked; the LAN hub replaces the internet entirely.)

**Tip:** for a Wi-Fi with truly no internet (the hub's own hotspot, a dead-zone cabin), open kibitz.chat once on real internet first — it caches itself (it's a PWA) so it loads offline later.
