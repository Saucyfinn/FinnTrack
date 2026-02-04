#!/bin/bash
# FinnTrack API Endpoint Test Suite
# Run these tests after deployment to verify all endpoints work

API_BASE="${API_BASE:-https://api.finntracker.org}"
RACE_ID="${RACE_ID:-AUSNATS-2026-R01}"

echo "=========================================="
echo "FinnTrack API Endpoint Tests"
echo "API Base: $API_BASE"
echo "Race ID: $RACE_ID"
echo "=========================================="
echo ""

# Color codes
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m' # No Color

pass() { echo -e "${GREEN}PASS${NC}: $1"; }
fail() { echo -e "${RED}FAIL${NC}: $1"; }

# Test 1: Health Check
echo "1. Testing /health..."
RESP=$(curl -sS "$API_BASE/health" 2>&1)
if echo "$RESP" | grep -q '"ok":true'; then
    pass "/health returns ok:true"
else
    fail "/health - Response: $RESP"
fi

# Test 2: Race List (new endpoint)
echo "2. Testing /race/list..."
RESP=$(curl -sS "$API_BASE/race/list" 2>&1)
if echo "$RESP" | grep -q '"races"'; then
    RACE_COUNT=$(echo "$RESP" | grep -o '"id":' | wc -l)
    pass "/race/list returns races array ($RACE_COUNT races)"
else
    fail "/race/list - Response: $RESP"
fi

# Test 3: Race List (legacy endpoint)
echo "3. Testing /races (legacy)..."
RESP=$(curl -sS "$API_BASE/races" 2>&1)
if echo "$RESP" | grep -q '"races"'; then
    pass "/races returns races array"
else
    fail "/races - Response: $RESP"
fi

# Test 4: Boats endpoint
echo "4. Testing /boats?raceId=$RACE_ID..."
RESP=$(curl -sS "$API_BASE/boats?raceId=$RACE_ID" 2>&1)
if echo "$RESP" | grep -q '"ok":true' || echo "$RESP" | grep -q '"boats"'; then
    pass "/boats returns valid response"
else
    fail "/boats - Response: $RESP"
fi

# Test 5: Update endpoint (POST)
echo "5. Testing POST /update..."
RESP=$(curl -sS -X POST \
    -H "Content-Type: application/json" \
    -d "{\"raceId\":\"$RACE_ID\",\"boatId\":\"TEST001\",\"lat\":-27.458,\"lon\":153.185,\"t\":$(date +%s)000}" \
    "$API_BASE/update" 2>&1)
if echo "$RESP" | grep -q 'OK' || echo "$RESP" | grep -q '"ok":true'; then
    pass "POST /update accepted"
else
    fail "POST /update - Response: $RESP"
fi

# Test 6: Verify boat appeared
echo "6. Verifying boat appeared in /boats..."
sleep 1
RESP=$(curl -sS "$API_BASE/boats?raceId=$RACE_ID" 2>&1)
if echo "$RESP" | grep -q 'TEST001'; then
    pass "Boat TEST001 appears in /boats"
else
    fail "Boat not found - Response: $RESP"
fi

# Test 7: OwnTracks ingestion
echo "7. Testing POST /ingest/owntracks..."
RESP=$(curl -sS -X POST \
    -H "Content-Type: application/json" \
    -u "OWNTRACK_TEST:" \
    -d '{"_type":"location","lat":-27.459,"lon":153.186,"tst":'"$(date +%s)"'}' \
    "$API_BASE/ingest/owntracks?raceId=$RACE_ID" 2>&1)
if echo "$RESP" | grep -q 'OK' || echo "$RESP" | grep -q '"ok":true' || echo "$RESP" | grep -q 'Missing'; then
    pass "POST /ingest/owntracks handled"
else
    fail "POST /ingest/owntracks - Response: $RESP"
fi

# Test 8: Join endpoint
echo "8. Testing POST /join..."
RESP=$(curl -sS -X POST \
    -H "Content-Type: application/json" \
    -d "{\"raceId\":\"$RACE_ID\",\"boatId\":\"JOIN_TEST\",\"boatName\":\"Test Boat\"}" \
    "$API_BASE/join" 2>&1)
if echo "$RESP" | grep -q '"ok":true' || echo "$RESP" | grep -q 'boatId'; then
    pass "POST /join accepted"
else
    fail "POST /join - Response: $RESP"
fi

# Test 9: Export GPX
echo "9. Testing /export/gpx..."
RESP=$(curl -sS -o /dev/null -w "%{http_code}" "$API_BASE/export/gpx?raceId=$RACE_ID" 2>&1)
if [ "$RESP" = "200" ]; then
    pass "/export/gpx returns 200"
else
    fail "/export/gpx - HTTP $RESP"
fi

# Test 10: Export KML
echo "10. Testing /export/kml..."
RESP=$(curl -sS -o /dev/null -w "%{http_code}" "$API_BASE/export/kml?raceId=$RACE_ID" 2>&1)
if [ "$RESP" = "200" ]; then
    pass "/export/kml returns 200"
else
    fail "/export/kml - HTTP $RESP"
fi

# Test 11: Autocourse
echo "11. Testing /autocourse..."
RESP=$(curl -sS "$API_BASE/autocourse?raceId=$RACE_ID" 2>&1)
if echo "$RESP" | grep -q 'startLine' || echo "$RESP" | grep -q 'marks'; then
    pass "/autocourse returns course data structure"
else
    fail "/autocourse - Response: $RESP"
fi

# Test 12: CORS Headers
echo "12. Testing CORS headers..."
RESP=$(curl -sS -I -X OPTIONS "$API_BASE/health" 2>&1)
if echo "$RESP" | grep -qi 'access-control-allow-origin'; then
    pass "CORS headers present"
else
    fail "CORS headers missing"
fi

echo ""
echo "=========================================="
echo "Test suite complete"
echo "=========================================="

# WebSocket test (manual)
echo ""
echo "MANUAL WebSocket Test:"
echo "Run: wscat -c 'wss://api.finntracker.org/live?raceId=$RACE_ID'"
echo "Expected: JSON message with type:'full' and boats object"
