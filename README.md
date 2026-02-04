# FinnTrack (Cloudflare Workers + Durable Objects + KV + R2)

A live + replay fleet tracker designed for 100–200 boats.

## What you get
- Live WebSocket feed (`/live?raceId=...`)
- Replay (`/replay-multi?raceId=...`)
- Auto course detection (`/autocourse?raceId=...`)
- GPX/KML export (`/export/gpx`, `/export/kml`)
- R2 archives (`/archive/save`, `/archive/load`)
- Static web UI served from Workers Static Assets (`/finntrack.html`)

## Install / Run / Deploy

### 1) Install deps
```bash
npm install
```

### 2) Login
```bash
npx wrangler login
```

### 3) Create KV namespaces (prod + preview)
```bash
npx wrangler kv namespace create HISTORY
npx wrangler kv namespace create HISTORY --preview
```

Copy the IDs into `wrangler.jsonc`:
- `kv_namespaces[0].id`
- `kv_namespaces[0].preview_id`

### 4) Create the R2 bucket
```bash
npx wrangler r2 bucket create finntrack-races
```

### 5) Build
```bash
npm run build
```

### 6) Run locally
```bash
npm run dev
```

Open:
- http://localhost:8787/finntrack.html

### 7) Deploy
```bash
npm run deploy
```

## POST telemetry (from RaceQuantifier or device)
```http
POST /update
Content-Type: application/json
```

```json
{
  "raceId": "RACE1",
  "boatId": "NZL21",
  "lat": -43.612345,
  "lng": 172.781234,
  "speed": 4.8,
  "heading": 212,
  "timestamp": 1737612890
}
```

The backend also accepts alternate field names for device compatibility:
- `lon` (alias for `lng`)
- `sog` (alias for `speed` - speed over ground)
- `cog` (alias for `heading` - course over ground)
- `ts` (alias for `timestamp`)

---

## Test Plan

### Base URL (Production)
```
https://finntrack-api.hvrdfbj65m.workers.dev
```

### 1) Test Race List Endpoint
```bash
curl -s https://finntrack-api.hvrdfbj65m.workers.dev/race/list | head -c 500
```
Expected: JSON with `{"races":[...]}` containing race objects with `raceId`, `title`, `series`, etc.

### 2) Test Update Endpoint
```bash
curl -X POST https://finntrack-api.hvrdfbj65m.workers.dev/update \
  -H "Content-Type: application/json" \
  -d '{
    "raceId": "AUSNATS-2026-R01",
    "boatId": "TEST-001",
    "lat": -27.458,
    "lon": 153.185,
    "sog": 5.5,
    "cog": 180,
    "ts": '"$(date +%s)"'
  }'
```
Expected: `OK`

### 3) Test WebSocket Connection
```bash
# Using websocat (install: brew install websocat)
websocat "wss://finntrack-api.hvrdfbj65m.workers.dev/live?raceId=AUSNATS-2026-R01"
```
Expected: Receives JSON message `{"type":"full","boats":{...}}` on connect.

### 4) Open Viewer Page
```
https://finntrack-api.hvrdfbj65m.workers.dev/
```
- Verify map loads centered on Moreton Bay
- Verify race dropdown populates with races
- Select a race and click "Load" - should connect WebSocket
- Verify "Join from this device" link is visible

### 5) Open Join Page
```
https://finntrack-api.hvrdfbj65m.workers.dev/join.html
```
- Verify race dropdown populates
- Enter a Boat ID (e.g., "TEST-001")
- Click "Start Tracking"
- Allow GPS permission when prompted
- Verify status shows "GPS: Active" and "Tracking: Active"
- Verify "Updates Sent" counter increments every 2 seconds

### 6) Verify Live Updates
1. Open viewer in one browser tab, select a race, click Load
2. Open join page in another tab (or on mobile), join same race
3. Start tracking on join page
4. Verify boat marker appears on viewer map in real-time

### 7) Test CORS (from external origin)
```bash
curl -I -X OPTIONS https://finntrack-api.hvrdfbj65m.workers.dev/update \
  -H "Origin: https://example.com" \
  -H "Access-Control-Request-Method: POST"
```
Expected: `Access-Control-Allow-Origin: *` header present.

---

## URLs Summary

| Page | URL |
|------|-----|
| Live Viewer | https://finntrack-api.hvrdfbj65m.workers.dev/ |
| Device Join | https://finntrack-api.hvrdfbj65m.workers.dev/join.html |

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/race/list` | GET | List available races |
| `/update` | POST | Send boat position update |
| `/live?raceId=X` | WS | WebSocket live feed |
| `/boats?raceId=X` | GET | Current boat positions |
| `/replay-multi?raceId=X` | GET | Replay data for all boats |
| `/autocourse?raceId=X` | GET | Auto-detected course features |
| `/export/gpx?raceId=X` | GET | Export as GPX |
| `/export/kml?raceId=X` | GET | Export as KML |
# FinnTrack
