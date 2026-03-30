# Telephone — CLAUDE.md

## What this is
A proximity friction tool. One host enters a secret message. Participants connect from their laptops on the same Wi-Fi. Each browser reports its geolocation via the Geolocation API. If everyone is equidistant from the host, the message is clear. If not, it scrambles proportionally. The friction is intentional: Wi-Fi triangulation was never designed to distinguish people 3 feet apart.

## Stack
- Node.js + Express + Socket.io (server)
- Vanilla HTML/CSS/JS (no frameworks, no build tools)
- Google Fonts: Space Mono

## Key files
- `server.js` — Express server, Socket.io logic, scramble math
- `public/index.html` — All views in one page, toggled by JS
- `public/style.css` — Maximalist palette, viewport-filling type
- `public/client.js` — Role selection, geolocation watch, message rendering

## Scramble logic
- Coefficient of variation (stdDev / mean of haversine distances to host)
- Clamped to [0, 1]
- At 0: perfect clarity. At 1: full glitch Unicode
- Re-randomized on every server emission so garbled chars flicker

## Running
```bash
cd telephone && npm install && node server.js
```
Open `http://localhost:3000` for host. Share the Network URL with participants.

## Geolocation note
Chrome blocks geolocation on plain `http://` for non-localhost. If participants can't get location over local IP, you need HTTPS. Quick workaround: use `mkcert` or a reverse proxy with a self-signed cert.
