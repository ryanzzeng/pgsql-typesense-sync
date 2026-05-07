# PostgreSQL → Typesense Real-Time Sync

A Node.js service that keeps a [Typesense](https://typesense.org) collection in sync with PostgreSQL in real time. It uses **PostgreSQL logical replication (WAL)** to capture every INSERT, UPDATE, and DELETE and reflect it in Typesense within milliseconds. A lightweight HTTP API lets you query the indexed data directly.

Everything runs locally with a single `docker compose up`.

---

## How it works

```
PostgreSQL (shipments + cargo tables)
  └─ WAL logical replication slot (pgoutput)
       └─ sync-service (Node.js)
            ├─ on startup  → full backfill into Typesense
            ├─ streaming   → WAL events → upsert / delete in Typesense
            └─ HTTP :3000  → search API backed by Typesense
```

- **WAL logical replication** — no polling, no triggers for change detection. The service consumes a replication slot using the built-in `pgoutput` decoder, so no extra PostgreSQL extensions are needed.
- **Denormalised documents** — each Typesense document contains the shipment plus all its cargo fields aggregated in (total weight, total volume, descriptions, hazardous flag). When any cargo row changes, the parent shipment document is re-indexed.
- **At-least-once delivery** — the LSN (log sequence number) is acknowledged to PostgreSQL only after the Typesense write succeeds. On restart, the slot replays any unacknowledged events.
- **Dead-letter table** — if a Typesense write fails after all retry attempts, the event is written to `sync_dead_letter` in PostgreSQL so nothing is silently lost.

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

This starts three containers:

| Container | Image | Port |
|---|---|---|
| `postgres` | postgres:16 | 5432 |
| `typesense` | typesense/typesense:27.0 | 8108 |
| `sync-service` | local build | 3000 |

On first start, PostgreSQL runs all migration scripts in `db/migrations/` in order:

| File | What it does |
|---|---|
| `001_create_tables.sql` | Creates `shipments` and `cargo` tables |
| `002_create_triggers.sql` | Adds `updated_at` auto-update triggers |
| `003_seed_data.sql` | Inserts 20 shipments and ~40 cargo rows |
| `004_wal_setup.sql` | Creates the publication and replication slot |
| `005_dead_letter.sql` | Creates the `sync_dead_letter` table |

The sync-service startup sequence:
1. Waits for Typesense to be healthy
2. Creates the `shipments` collection if it doesn't exist
3. Ensures the replication slot exists
4. Runs a **full backfill** — indexes all 20 seed shipments into Typesense
5. Starts streaming WAL events

You'll see output like this when everything is ready:

```
sync-service  | {"level":"info","msg":"typesense ready"}
sync-service  | {"level":"info","msg":"replication slot ready","slotName":"sync_slot"}
sync-service  | {"level":"info","msg":"initial sync complete","total":20}
sync-service  | {"level":"info","msg":"starting replication stream"}
sync-service  | {"level":"info","msg":"api server listening","port":3000}
```

### 3. Verify the service is healthy

```bash
curl http://localhost:3000/health
```

Expected response:

```json
{
  "status": "ok",
  "postgres": "connected",
  "typesense": "connected",
  "last_event_at": null
}
```

---

## Exploring the data

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

# Filter + sort
curl "http://localhost:3000/shipments?q=*&filter_by=status:pending&sort_by=estimated_arrival:asc"

# Pagination
curl "http://localhost:3000/shipments?q=*&per_page=5&page=2"

# Combined
curl "http://localhost:3000/shipments?q=Shanghai&filter_by=status:in_transit&sort_by=estimated_arrival:asc&per_page=5"
```

### Fetch a single shipment by ID

```bash
curl "http://localhost:3000/shipments/00000000-0000-0000-0000-000000000001"
```

### Available query parameters

| Parameter | Default | Description |
|---|---|---|
| `q` | `*` | Full-text search query (`*` matches everything) |
| `filter_by` | — | Typesense filter expression, e.g. `status:in_transit` or `cargo_has_hazardous:true` |
| `sort_by` | `estimated_arrival:asc` | Sort field and direction |
| `page` | `1` | Page number |
| `per_page` | `20` | Results per page (max 100) |

### Filterable fields

`status`, `carrier`, `origin_port`, `destination_port`, `estimated_arrival`, `cargo_total_weight_kg`, `cargo_total_volume_m3`, `cargo_has_hazardous`, `created_at`, `updated_at`

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

Copy the returned UUID, then immediately query Typesense:

```bash
curl "http://localhost:3000/shipments/<UUID>"
```

The document appears within a few hundred milliseconds.

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
# cargo_total_weight_kg is updated
```

### UPDATE cargo — re-indexes parent shipment

```sql
UPDATE cargo SET hazardous = false WHERE shipment_id = '<UUID>';
```

```bash
curl "http://localhost:3000/shipments/<UUID>"
# cargo_has_hazardous is now false
```

### DELETE — document removed from Typesense

```sql
DELETE FROM shipments WHERE tracking_number = 'SHP-DEMO-001';
```

```bash
curl "http://localhost:3000/shipments/<UUID>"
# Returns 404 — document is gone
```

---

## Running the automated validation suite

With the stack running, execute all 12 tests in one command:

```bash
bash scripts/validate.sh
```

The suite covers:

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
| 12 | LSN advances after a write (confirms WAL consumption) |

Expected output:

```
=== Test 1 — Health check ===
[PASS] GET /health returns ok

=== Test 2 — Initial backfill ===
[PASS] All 20 seed shipments indexed (found=20)
...
=== Results ===
Passed: 14  Failed: 0
```

---

## Observability

### Metrics (Prometheus)

```bash
curl http://localhost:3000/metrics
```

Key metrics:

| Metric | Type | Description |
|---|---|---|
| `sync_events_total` | Counter | WAL events processed, labelled by `operation` and `status` |
| `sync_dead_letter_total` | Counter | Events written to the dead-letter table |
| `sync_typesense_request_duration_seconds` | Histogram | Typesense API call latency |
| `sync_last_event_timestamp` | Gauge | Unix timestamp of the last successfully processed event |

### Logs

The service emits structured JSON logs via [pino](https://getpino.io). Log level is controlled by the `LOG_LEVEL` env var (`trace` | `debug` | `info` | `warn` | `error`).

```bash
# Follow logs
docker compose logs -f sync-service

# Pretty-print with pino-pretty (if installed globally)
docker compose logs -f sync-service | npx pino-pretty
```

### Dead-letter table

If a Typesense write fails after all retry attempts, the event is preserved here:

```sql
SELECT * FROM sync_dead_letter ORDER BY created_at DESC;
```

---

## Resetting the local environment

```bash
# Tear down containers and wipe all data volumes
docker compose down -v

# Rebuild from scratch
docker compose up --build
```

This re-runs all migrations and re-seeds the database. The sync-service performs a fresh backfill on startup.

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
| `TYPESENSE_API_KEY` | `local-dev-api-key` | Typesense API key |
| `TYPESENSE_COLLECTION` | `shipments` | Collection name |
| `PORT` | `3000` | HTTP server port |
| `INITIAL_SYNC_BATCH_SIZE` | `100` | Rows per batch during backfill |
| `REPLICATION_SLOT` | `sync_slot` | PostgreSQL replication slot name |
| `REPLICATION_PUBLICATION` | `sync_pub` | PostgreSQL publication name |
| `RETRY_MAX_ATTEMPTS` | `5` | Max Typesense write attempts before dead-letter |
| `RETRY_INITIAL_DELAY_MS` | `500` | Initial retry backoff delay |
| `RETRY_MAX_DELAY_MS` | `30000` | Maximum retry backoff delay |
| `LOG_LEVEL` | `info` | Pino log level |

---

## Project structure

```
pgsql-typesense-sync/
├── docker-compose.yml          # local dev stack
├── docker-compose.prod.yml     # production resource overrides
├── .env.example                # copy to .env for local dev
│
├── db/
│   └── migrations/
│       ├── 001_create_tables.sql
│       ├── 002_create_triggers.sql   # updated_at maintenance
│       ├── 003_seed_data.sql
│       ├── 004_wal_setup.sql         # replication publication + slot
│       └── 005_dead_letter.sql
│
├── sync-service/
│   ├── Dockerfile                    # multi-stage build, non-root user
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts                  # startup + WAL streaming + graceful shutdown
│       ├── config.ts                 # env var validation
│       ├── types.ts                  # shared TypeScript types
│       ├── logger.ts                 # pino structured logger
│       ├── metrics.ts                # Prometheus metrics (prom-client)
│       ├── db.ts                     # pg pool + replication slot management
│       ├── typesenseClient.ts        # Typesense client + collection bootstrap
│       ├── walHandler.ts             # pgoutput WAL message decoder
│       ├── initialSync.ts            # paginated full backfill on startup
│       ├── eventHandler.ts           # routes WAL events to upsert/delete
│       ├── sync.ts                   # upsert/delete logic with retry
│       ├── retry.ts                  # exponential backoff with jitter
│       ├── deadLetter.ts             # writes exhausted events to DB
│       ├── gracefulShutdown.ts       # SIGTERM/SIGINT drain handler
│       └── api.ts                    # Express HTTP API
│
├── k8s/                              # Kubernetes manifests
│   ├── sync-worker-deployment.yaml   # singleton WAL consumer
│   ├── api-deployment.yaml           # horizontally scalable API
│   ├── service.yaml
│   ├── configmap.yaml
│   ├── secret.yaml
│   └── hpa.yaml
│
└── scripts/
    └── validate.sh                   # 12-test end-to-end validation
```
