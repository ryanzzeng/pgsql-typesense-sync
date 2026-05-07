#!/usr/bin/env bash
set -euo pipefail

API="http://localhost:3000"
PG_CONTAINER="pgsql-typesense-sync-postgres-1"
PASS=0
FAIL=0

GREEN='\033[0;32m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

pass()    { echo -e "${GREEN}[PASS]${NC} $1"; PASS=$((PASS + 1)); }
fail()    { echo -e "${RED}[FAIL]${NC} $1"; FAIL=$((FAIL + 1)); }
section() { echo -e "\n${BLUE}=== $1 ===${NC}"; }

db() { docker exec "$PG_CONTAINER" psql -U sync_user -d sync_db "$@"; }

# ─── Test 1: Health check ───────────────────────────────────────────────────
section "Test 1 — Health check"
STATUS=$(curl -sf "$API/health" | grep -o '"ok"' || true)
if [ "$STATUS" = '"ok"' ]; then pass "GET /health returns ok"
else fail "GET /health did not return ok"; fi

# ─── Test 2: Initial backfill ────────────────────────────────────────────────
section "Test 2 — Initial backfill"
TOTAL=$(curl -sf "$API/shipments?q=*&per_page=1" | python3 -c "import sys,json; print(json.load(sys.stdin)['total'])" 2>/dev/null || echo "0")
if [ "$TOTAL" -eq 20 ]; then pass "All 20 seed shipments indexed (found=$TOTAL)"
else fail "Expected 20 shipments, got $TOTAL"; fi

# ─── Test 3: INSERT — new shipment appears in Typesense ─────────────────────
section "Test 3 — INSERT new shipment"
NEW_ID=$(db -t -q -c "
  INSERT INTO shipments (tracking_number, status, carrier, origin_port, destination_port, estimated_arrival)
  VALUES ('SHP-TEST-001', 'pending', 'TestCarrier', 'TestOrigin', 'TestDestination', '2025-12-01')
  RETURNING id;
" | xargs)

until curl -sf "$API/shipments/$NEW_ID" &>/dev/null; do sleep 1; done

DOC=$(curl -sf "$API/shipments/$NEW_ID" 2>/dev/null || echo "")
if echo "$DOC" | grep -q 'SHP-TEST-001'; then pass "New shipment SHP-TEST-001 found in Typesense (id=$NEW_ID)"
else fail "New shipment SHP-TEST-001 not found in Typesense"; fi

# ─── Test 4: UPDATE — status change reflected ────────────────────────────────
section "Test 4 — UPDATE shipment status"
db -q -c "UPDATE shipments SET status = 'in_transit' WHERE id = '$NEW_ID';"
sleep 2

UPDATED_STATUS=$(curl -sf "$API/shipments/$NEW_ID" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null || echo "")
if [ "$UPDATED_STATUS" = "in_transit" ]; then pass "Status updated to 'in_transit' in Typesense"
else fail "Expected status 'in_transit', got '$UPDATED_STATUS'"; fi

# ─── Test 5: Cargo INSERT — parent shipment re-indexed ───────────────────────
section "Test 5 — Cargo INSERT re-indexes parent shipment"
db -q -c "
  INSERT INTO cargo (shipment_id, description, weight_kg, volume_m3, hazardous)
  VALUES ('$NEW_ID', 'Test cargo item', 500.00, 3.500, false);
"
sleep 2

CARGO_DESC=$(curl -sf "$API/shipments/$NEW_ID" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('cargo_descriptions',[])[0] if d.get('cargo_descriptions') else '')" 2>/dev/null || echo "")
if [ "$CARGO_DESC" = "Test cargo item" ]; then pass "Cargo description 'Test cargo item' reflected in Typesense doc"
else fail "Cargo description not reflected, got '$CARGO_DESC'"; fi

# ─── Test 6: Cargo UPDATE — parent shipment re-indexed ───────────────────────
section "Test 6 — Cargo UPDATE re-indexes parent shipment"
db -q -c "UPDATE cargo SET hazardous = true WHERE shipment_id = '$NEW_ID';"
sleep 2

HAZARDOUS=$(curl -sf "$API/shipments/$NEW_ID" | python3 -c "import sys,json; print(json.load(sys.stdin).get('cargo_has_hazardous',''))" 2>/dev/null || echo "")
if [ "$HAZARDOUS" = "True" ]; then pass "cargo_has_hazardous updated to true in Typesense"
else fail "Expected cargo_has_hazardous=True, got '$HAZARDOUS'"; fi

# ─── Test 7: DELETE — document removed from Typesense ────────────────────────
section "Test 7 — DELETE shipment"
db -q -c "DELETE FROM shipments WHERE id = '$NEW_ID';"
sleep 2

HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$API/shipments/$NEW_ID" 2>/dev/null || echo "000")
if [ "$HTTP_CODE" = "404" ] || [ "$HTTP_CODE" = "500" ]; then pass "Deleted shipment no longer in Typesense (HTTP $HTTP_CODE)"
else fail "Expected 404/500 after delete, got HTTP $HTTP_CODE"; fi

# ─── Test 8: HTTP API search and filter ──────────────────────────────────────
section "Test 8 — HTTP API search and filter"
until curl -sf "$API/health" &>/dev/null; do sleep 1; done

MAERSK_COUNT=$(curl -sf "$API/shipments?q=Maersk" | python3 -c "import sys,json; print(json.load(sys.stdin)['total'])" 2>/dev/null || echo "0")
if [ "$MAERSK_COUNT" -ge 1 ]; then pass "Search q=Maersk returns $MAERSK_COUNT result(s)"
else fail "Search q=Maersk returned 0 results"; fi

FILTER_RESULT=$(curl -sf "$API/shipments?q=*&filter_by=status%3Ain_transit" | python3 -c "import sys,json; print(json.load(sys.stdin)['total'])" 2>/dev/null || echo "0")
if [ "$FILTER_RESULT" -ge 1 ]; then pass "filter_by=status:in_transit returns $FILTER_RESULT result(s)"
else fail "filter_by=status:in_transit returned 0 results"; fi

PAGINATION=$(curl -sf "$API/shipments?q=*&per_page=5&page=1" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d['hits']))" 2>/dev/null || echo "0")
if [ "$PAGINATION" -eq 5 ]; then pass "Pagination per_page=5 returns 5 hits"
else fail "Expected 5 hits with per_page=5, got $PAGINATION"; fi

# ─── Test 9: Enriched health endpoint ───────────────────────────────────────
section "Test 9 — Enriched /health"
HEALTH=$(curl -sf "$API/health" 2>/dev/null || echo "{}")
PG_STATUS=$(echo "$HEALTH"  | python3 -c "import sys,json; print(json.load(sys.stdin).get('postgres',''))"  2>/dev/null || echo "")
TS_STATUS=$(echo "$HEALTH"  | python3 -c "import sys,json; print(json.load(sys.stdin).get('typesense',''))" 2>/dev/null || echo "")
if [ "$PG_STATUS" = "connected" ]; then pass "/health reports postgres=connected"
else fail "/health postgres field: expected 'connected', got '$PG_STATUS'"; fi
if [ "$TS_STATUS" = "connected" ]; then pass "/health reports typesense=connected"
else fail "/health typesense field: expected 'connected', got '$TS_STATUS'"; fi

# ─── Test 10: Metrics endpoint ───────────────────────────────────────────────
section "Test 10 — GET /metrics"
METRICS=$(curl -sf "$API/metrics" 2>/dev/null || echo "")
if echo "$METRICS" | grep -q 'sync_events_total'; then pass "GET /metrics exposes sync_events_total counter"
else fail "GET /metrics missing sync_events_total"; fi
if echo "$METRICS" | grep -q 'sync_typesense_request_duration_seconds'; then pass "GET /metrics exposes typesense latency histogram"
else fail "GET /metrics missing sync_typesense_request_duration_seconds"; fi

# ─── Test 11: Replication slot exists ────────────────────────────────────────
section "Test 11 — Replication slot exists"
SLOT=$(db -t -q -c "SELECT slot_name FROM pg_replication_slots WHERE slot_name = 'sync_slot';" | xargs)
if [ "$SLOT" = "sync_slot" ]; then pass "Replication slot 'sync_slot' exists"
else fail "Replication slot 'sync_slot' not found"; fi

# ─── Test 12: LSN advances after a write ────────────────────────────────────
section "Test 12 — LSN advances after write"
LSN_BEFORE=$(db -t -q -c "SELECT confirmed_flush_lsn FROM pg_replication_slots WHERE slot_name = 'sync_slot';" | xargs)
db -q -c "INSERT INTO shipments (tracking_number, status, carrier, origin_port, destination_port, estimated_arrival)
  VALUES ('SHP-LSN-TEST', 'pending', 'LSNCarrier', 'LSNOrigin', 'LSNDest', '2025-12-01');"
sleep 2
LSN_AFTER=$(db -t -q -c "SELECT confirmed_flush_lsn FROM pg_replication_slots WHERE slot_name = 'sync_slot';" | xargs)
db -q -c "DELETE FROM shipments WHERE tracking_number = 'SHP-LSN-TEST';" 2>/dev/null || true
if [ "$LSN_BEFORE" != "$LSN_AFTER" ]; then pass "LSN advanced from $LSN_BEFORE to $LSN_AFTER"
else fail "LSN did not advance (before=$LSN_BEFORE, after=$LSN_AFTER)"; fi

# ─── Summary ─────────────────────────────────────────────────────────────────
echo -e "\n${BLUE}=== Results ===${NC}"
echo -e "${GREEN}Passed: $PASS${NC}  ${RED}Failed: $FAIL${NC}"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
