# PostgreSQL → Typesense Real-Time Sync

A Node.js service that keeps a [Typesense](https://typesense.org) collection in sync with PostgreSQL in real time. It uses **PostgreSQL logical replication (WAL)** to capture every INSERT, UPDATE, and DELETE and reflect it in Typesense within milliseconds. A lightweight HTTP API lets you search and filter the indexed data directly.

Everything runs locally with a single `docker compose up` — including Prometheus, Loki, and Grafana for observability.

---

## How it works

```
PostgreSQL (shipments + cargo tables)
  └─ WAL logical replication slot (pgoutput)
       └─ sync-service (Node.js)
            ├─ on startup  → full backfill into Typesense
            ├─ streaming   → WAL events → coalesce → upsert / delete in Typesense
            └─ HTTP :3000  → search API backed by Typesense
```

- **WAL logical replication** — no polling, no triggers for change detection. The service consumes a replication slot using the built-in `pgoutput` decoder; no extra PostgreSQL extensions needed.
- **Event coalescing** — rapid-fire updates to the same shipment are deduplicated within a 50ms window before hitting Typesense. A DELETE always wins over any pending upsert for the same ID.
- **Denormalised documents** — each Typesense document contains the shipment plus all its cargo fields aggregated in (total weight, total volume, descriptions, hazardous flag). When any cargo row changes, the parent shipment document is re-indexed.
- **At-least-once delivery** — the LSN (log sequence number) is acknowledged to PostgreSQL only after the Typesense write succeeds. On restart, the slot replays any unacknowledged events.
- **Retry with dead-letter** — Typesense writes are retried with exponential backoff. Events that exhaust all retries are written to `sync_dead_letter` in PostgreSQL so nothing is silently lost. A replay endpoint lets you re-process them once the issue is resolved.
- **Collection alias** — Typesense collection is accessed via an alias (`shipments → shipments_v1`), enabling zero-downtime schema migrations via atomic alias swaps.

---

## Prerequisites

| Tool | Minimum version |
|---|---|
| Docker Desktop | 4.x |
| Docker Compose | v2 (`docker compose`) |
| curl | any |
| python3 | 3.x (used by the validation script) |

---

## Quick start

### 1. Clone and configure

```bash
git clone <repo-url>
cd pgsql-typesense-sync
cp .env.example .env
```

The defaults in `.env.example` work out of the box for local development — no changes needed.

### 2. Start all services

```bash
docker compose up --build
```

| Container | Image | Port | Purpose |
|---|---|---|---|
| `postgres` | postgres:16 | 5432 | Primary database |
| `typesense` | typesense/typesense:27.0 | 8108 | Search engine |
| `sync-service` | local build | 3000 | WAL consumer + HTTP API |
| `prometheus` | prom/prometheus:latest | 9090 | Metrics storage |
| `loki` | grafana/loki:3.0.0 | 3100 | Log storage |
| `promtail` | grafana/promtail:3.0.0 | — | Log collector |
| `grafana` | grafana/grafana:latest | 3001 | Dashboards |

On first start, PostgreSQL runs all migration scripts in `db/migrations/` in order:

| File | What it does |
|---|---|
| `001_create_tables.sql` | Creates `shipments` and `cargo` tables |
| `002_create_triggers.sql` | Adds `updated_at` auto-update triggers |
| `003_seed_data.sql` | Inserts 20 shipments and ~40 cargo rows |
| `004_wal_setup.sql` | Creates the WAL publication and replication slot |
| `005_dead_letter.sql` | Creates the `sync_dead_letter` table |

The sync-service startup sequence:
1. Waits for Typesense to be healthy
2. Creates the `shipments_v1` collection and `shipments` alias if they don't exist
3. Ensures the replication slot exists
4. Runs a **full backfill** — indexes all 20 seed shipments
5. Starts streaming WAL events

You'll see output like this when everything is ready:

```
sync-service  | {"level":"info","msg":"typesense ready"}
sync-service  | {"level":"info","msg":"typesense alias created","alias":"shipments","collection":"shipments_v1"}
sync-service  | {"level":"info","msg":"replication slot ready","slotName":"sync_slot"}
sync-service  | {"level":"info","msg":"initial sync complete","total":20}
sync-service  | {"level":"info","msg":"starting replication stream"}
sync-service  | {"level":"info","msg":"api server listening","port":3000}
```

### 3. Verify the service is healthy

```bash
curl http://localhost:3000/health
```

```json
{
  "status": "ok",
  "postgres": "connected",
  "typesense": "connected",
  "last_event_at": null
}
```

---

## HTTP API

All routes are rate-limited to 100 requests/minute per IP. If `API_KEY` is set, all `/shipments` and `/admin` routes require an `X-Api-Key` header.

### Search shipments

```bash
# Search everything
curl "http://localhost:3000/shipments?q=*"

# Full-text search
curl "http://localhost:3000/shipments?q=Maersk"
curl "http://localhost:3000/shipments?q=Shanghai"
curl "http://localhost:3000/shipments?q=electronics"

# Filter by status
curl "http://localhost:3000/shipments?q=*&filter_by=status:in_transit"

# Filter by hazardous cargo
curl "http://localhost:3000/shipments?q=*&filter_by=cargo_has_hazardous:true"

# Filter + sort
curl "http://localhost:3000/shipments?q=*&filter_by=status:pending&sort_by=estimated_arrival:asc"

# Pagination
curl "http://localhost:3000/shipments?q=*&per_page=5&page=2"
```

| Parameter | Default | Description |
|---|---|---|
| `q` | `*` | Full-text search query |
| `filter_by` | — | Typesense filter expression |
| `sort_by` | `estimated_arrival:asc` | Sort field and direction |
| `page` | `1` | Page number |
| `per_page` | `20` | Results per page (max 100) |

### Fetch a single shipment

```bash
curl "http://localhost:3000/shipments/00000000-0000-0000-0000-000000000001"
```

### Health check

```bash
curl "http://localhost:3000/health"
```

Returns `status: ok` or `status: degraded` with per-dependency connectivity. Result is cached for 5 seconds.

### Prometheus metrics

```bash
curl "http://localhost:3000/metrics"
```

### Replay dead-letter events

```bash
curl -X POST "http://localhost:3000/admin/replay"
```

Re-processes up to 100 unresolved dead-letter entries and marks them resolved on success.

```json
{ "total": 3, "replayed": 3, "failed": 0 }
```

---

## Testing real-time sync

Open a second terminal and connect to PostgreSQL:

```bash
docker exec -it pgsql-typesense-sync-postgres-1 psql -U sync_user -d sync_db
```

### INSERT — new shipment appears in Typesense

```sql
INSERT INTO shipments (tracking_number, status, carrier, origin_port, destination_port, estimated_arrival)
VALUES ('SHP-DEMO-001', 'pending', 'Maersk', 'Shanghai', 'Sydney', '2025-09-01')
RETURNING id;
```

Copy the returned UUID, then query Typesense (appears within ~50ms):

```bash
curl "http://localhost:3000/shipments/<UUID>"
```

### UPDATE — status change reflected immediately

```sql
UPDATE shipments SET status = 'in_transit' WHERE tracking_number = 'SHP-DEMO-001';
```

```bash
curl "http://localhost:3000/shipments/<UUID>"
# status field is now "in_transit"
```

### INSERT cargo — parent shipment re-indexed

```sql
INSERT INTO cargo (shipment_id, description, weight_kg, volume_m3, hazardous)
VALUES ('<UUID>', 'Lithium batteries', 800.00, 4.200, true);
```

```bash
curl "http://localhost:3000/shipments/<UUID>"
# cargo_descriptions now includes "Lithium batteries"
# cargo_has_hazardous is true
```

### DELETE — document removed from Typesense

```sql
DELETE FROM shipments WHERE tracking_number = 'SHP-DEMO-001';
```

```bash
curl "http://localhost:3000/shipments/<UUID>"
# Returns 404
```

### Burst update — event coalescing in action

```sql
-- 5 rapid updates to the same shipment — only 1 Typesense write is triggered
UPDATE shipments SET status = 'pending'    WHERE tracking_number = 'SHP-DEMO-001';
UPDATE shipments SET status = 'in_transit' WHERE tracking_number = 'SHP-DEMO-001';
UPDATE shipments SET status = 'arrived'    WHERE tracking_number = 'SHP-DEMO-001';
UPDATE shipments SET carrier = 'MSC'       WHERE tracking_number = 'SHP-DEMO-001';
UPDATE shipments SET status = 'delivered'  WHERE tracking_number = 'SHP-DEMO-001';
```

---

## Running the automated validation suite

With the stack running:

```bash
bash scripts/validate.sh
```

| # | Test |
|---|---|
| 1 | `GET /health` returns `ok` |
| 2 | All 20 seed shipments indexed after backfill |
| 3 | INSERT — new shipment appears in Typesense |
| 4 | UPDATE — status change reflected |
| 5 | Cargo INSERT — parent shipment re-indexed |
| 6 | Cargo UPDATE — parent shipment re-indexed |
| 7 | DELETE — document removed |
| 8 | HTTP API search, filter, and pagination |
| 9 | `/health` reports `postgres=connected` and `typesense=connected` |
| 10 | `/metrics` exposes Prometheus counters and histograms |
| 11 | Replication slot `sync_slot` exists in PostgreSQL |
| 12 | LSN advances after a write |

### Unit tests

```bash
cd sync-service
npm test
```

25 tests across 4 suites covering `walHandler`, `coalescer`, `retry`, and `sync.toDocument`.

---

## Observability

### Grafana dashboards

After `docker compose up`, Grafana is at **http://localhost:3001** (`admin` / `admin`). Navigate to **Dashboards → Sync Service**.

| UI | URL |
|---|---|
| Grafana | http://localhost:3001 |
| Prometheus | http://localhost:9090 |
| Loki | http://localhost:3100 |

**Metrics panels:**
- Events processed / sec (upsert + delete rates)
- Typesense request latency (p50 / p95 / p99)
- Dead-letter event count
- Last event processed timestamp
- Total / failed event counters

**Log panels:**
- All service logs — newest first
- Error logs only — filtered to `level="error"`

### Log querying (LogQL)

Promtail collects logs from the sync-service container and ships them to Loki with a `level` label extracted from pino's JSON output. Query in Grafana's Explore view or directly:

```
# All logs
{service="sync-service"}

# Errors only
{service="sync-service", level="error"}

# Logs for a specific shipment
{service="sync-service"} | json | shipmentId="<UUID>"

# All upsert operations
{service="sync-service"} | json | operation="upsert"
```

### Metrics (raw)

```bash
curl http://localhost:3000/metrics
```

| Metric | Type | Description |
|---|---|---|
| `sync_events_total` | Counter | WAL events processed, labelled `operation` + `status` |
| `sync_dead_letter_total` | Counter | Events written to the dead-letter table |
| `sync_typesense_request_duration_seconds` | Histogram | Typesense API call latency |
| `sync_last_event_timestamp` | Gauge | Unix timestamp of last successfully processed event |

### Structured logs

```bash
# Follow logs
docker compose logs -f sync-service

# Pretty-print
docker compose logs -f sync-service | npx pino-pretty
```

Log level is controlled by `LOG_LEVEL` (`trace` | `debug` | `info` | `warn` | `error`). Every log line includes structured fields like `shipmentId`, `operation`, `attempt`, and `requestId` (on API errors).

### Dead-letter table

```sql
-- View failed events
SELECT * FROM sync_dead_letter WHERE resolved_at IS NULL ORDER BY created_at DESC;

-- After fixing the root cause, replay via API
curl -X POST http://localhost:3000/admin/replay
```

---

## Security

### API key authentication

Set `API_KEY` in `.env` to protect all `/shipments` and `/admin` routes:

```env
API_KEY=your-secret-key
```

Then pass it with every request:

```bash
curl -H "X-Api-Key: your-secret-key" "http://localhost:3000/shipments?q=*"
```

`/health` and `/metrics` are intentionally unauthenticated (needed by k8s probes and Prometheus).

### Typesense scoped search key

By default the HTTP API uses the admin Typesense key. For production, create a search-only key and set it via `TYPESENSE_SEARCH_API_KEY`:

```bash
curl -X POST 'http://localhost:8108/keys' \
  -H 'X-TYPESENSE-API-KEY: local-dev-api-key' \
  -d '{"description":"Search-only","actions":["documents:search","documents:get"],"collections":["shipments"]}'
```

Then add the returned value to `.env`:

```env
TYPESENSE_SEARCH_API_KEY=<value>
```

The sync worker continues to use the admin key for writes. The HTTP API uses the scoped key — a leaked API key can only read, not write or delete.

---

## Resetting the local environment

```bash
# Tear down containers and wipe all data volumes
docker compose down -v

# Rebuild from scratch
docker compose up --build
```

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `POSTGRES_HOST` | `postgres` | PostgreSQL host |
| `POSTGRES_PORT` | `5432` | PostgreSQL port |
| `POSTGRES_DB` | `sync_db` | Database name |
| `POSTGRES_USER` | `sync_user` | Database user |
| `POSTGRES_PASSWORD` | `sync_pass` | Database password |
| `TYPESENSE_HOST` | `typesense` | Typesense host |
| `TYPESENSE_PORT` | `8108` | Typesense port |
| `TYPESENSE_API_KEY` | `local-dev-api-key` | Typesense admin key (for writes) |
| `TYPESENSE_SEARCH_API_KEY` | _(admin key)_ | Typesense search-only key for HTTP API |
| `TYPESENSE_COLLECTION` | `shipments` | Alias name (resolves to `shipments_v1`) |
| `PORT` | `3000` | HTTP server port |
| `INITIAL_SYNC_BATCH_SIZE` | `100` | Rows per batch during backfill |
| `REPLICATION_SLOT` | `sync_slot` | PostgreSQL replication slot name |
| `REPLICATION_PUBLICATION` | `sync_pub` | PostgreSQL publication name |
| `RETRY_MAX_ATTEMPTS` | `5` | Max Typesense write attempts before dead-letter |
| `RETRY_INITIAL_DELAY_MS` | `500` | Initial retry backoff (ms) |
| `RETRY_MAX_DELAY_MS` | `30000` | Maximum retry backoff (ms) |
| `LOG_LEVEL` | `info` | Pino log level |
| `API_KEY` | _(unset)_ | If set, HTTP API requires `X-Api-Key` header |
| `COALESCE_WINDOW_MS` | `50` | Event coalescing window (ms) |

---

## Project structure

```
pgsql-typesense-sync/
├── docker-compose.yml              # local dev stack
├── docker-compose.prod.yml         # production resource overrides
├── prometheus.yml                  # Prometheus scrape config
├── promtail-config.yml             # Promtail log collector config
├── grafana/
│   └── provisioning/
│       ├── datasources/            # auto-wires Prometheus + Loki
│       └── dashboards/             # pre-built Sync Service dashboard
├── .env.example
│
├── db/
│   └── migrations/
│       ├── 001_create_tables.sql
│       ├── 002_create_triggers.sql  # updated_at maintenance
│       ├── 003_seed_data.sql
│       ├── 004_wal_setup.sql        # WAL publication + replication slot
│       └── 005_dead_letter.sql
│
├── sync-service/
│   ├── Dockerfile                   # multi-stage build, non-root user, HEALTHCHECK
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts                 # startup + WAL streaming + graceful shutdown
│       ├── config.ts                # env var validation
│       ├── types.ts                 # shared TypeScript types
│       ├── logger.ts                # pino structured logger
│       ├── metrics.ts               # Prometheus metrics (prom-client)
│       ├── db.ts                    # pg pool + replication slot management
│       ├── typesenseClient.ts       # admin + search clients, alias bootstrap
│       ├── walHandler.ts            # pgoutput WAL message decoder
│       ├── initialSync.ts           # paginated full backfill on startup
│       ├── eventHandler.ts          # routes WAL events to upsert/delete
│       ├── coalescer.ts             # deduplicates burst events per shipment
│       ├── sync.ts                  # upsert/delete with retry + dead-letter
│       ├── retry.ts                 # exponential backoff with jitter
│       ├── deadLetter.ts            # writes exhausted events to DB
│       ├── gracefulShutdown.ts      # SIGTERM/SIGINT drain handler
│       ├── api.ts                   # Express HTTP API
│       └── __tests__/              # Jest unit tests (25 tests)
│
├── k8s/                             # Kubernetes manifests
│   ├── sync-worker-deployment.yaml  # singleton WAL consumer
│   ├── api-deployment.yaml          # horizontally scalable HTTP API
│   ├── service.yaml
│   ├── configmap.yaml
│   ├── secret.yaml
│   └── hpa.yaml
│
└── scripts/
    └── validate.sh                  # 12-test end-to-end validation
```
