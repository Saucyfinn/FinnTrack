# FinnTrack API Worker

Cloudflare Worker API for the FinnTrack sailing race tracking system.

## Endpoints

- `GET /` - API health and endpoint list
- `GET /races` - List of active races
- `GET /boats?raceId=...` - Get boats for a specific race
- `GET /ws/live?raceId=...` - WebSocket live feed
- `POST /join` - Join a race roster
- `POST /update` - Update boat position (FinnTrack app)
- `POST /traccar` - Accept Traccar Client position updates

## Authentication

- **FinnTrack app**: Bearer token in Authorization header
- **Traccar clients**: Query parameter `?key=...`
- **Supported tokens**: `DEVICE_API_KEY`, `SHARE` environment variables

## Testing Commands

### Basic Health Check
```bash
curl https://api.finntracker.org/
```

### FinnTrack App Update
```bash
curl -X POST https://api.finntracker.org/update \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "raceId": "test2025",
    "boatId": "boat123",
    "boatName": "Test Boat",
    "lat": -36.8485,
    "lon": 174.7633,
    "sog": 5.2,
    "cog": 180
  }'
```

### Traccar Client Update
```bash
curl -X POST "https://api.finntracker.org/traccar?key=YOUR_TOKEN" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "id=device001&lat=-36.8485&lon=174.7633&speed=5.2&bearing=180&accuracy=10&timestamp=$(date +%s)000"
```

### Get Boats for Race
```bash
curl "https://api.finntracker.org/boats?raceId=test2025"
curl "https://api.finntracker.org/boats?raceId=traccar"
```

### Get Help for Endpoints
```bash
curl https://api.finntracker.org/update
curl https://api.finntracker.org/traccar
```

## Local Development

```bash
# Install dependencies
npm install

# Start local dev server
npx wrangler dev

# Test locally
curl http://localhost:8787/
curl -X POST "http://localhost:8787/traccar?key=finn123" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "id=dev001&lat=-36.8485&lon=174.7633"
```

## Deployment

```bash
# Deploy to Cloudflare
npx wrangler deploy

# Set secrets (if needed)
npx wrangler secret put DEVICE_API_KEY
npx wrangler secret put SHARE
```

## Configuration

The worker is configured to handle:
- Route: `api.finntracker.org/*`
- Default API key: `finn123` (dev mode)
- Traccar devices automatically use race ID "traccar"
- All data stored in Durable Objects with real-time WebSocket updates