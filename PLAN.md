# PostgreSQL → Typesense Real-Time Sync — MVP Plan

## Overview

A Node.js service that keeps a Typesense collection in sync with PostgreSQL in real time, using PostgreSQL `LISTEN/NOTIFY` triggers. Includes a lightweight HTTP API to query Typesense. Fully containerised with Docker Compose for local development.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Docker Compose                        │
│                                                             │
│  ┌──────────────┐    NOTIFY     ┌─────────────────────┐    │
│  │  PostgreSQL  │ ────────────► │    sync-service      │    │
│  │              │               │    (Node.js)         │    │
│  │  shipments   │   on startup  │                      │    │
│  │  cargo       │ ◄──────────── │  1. initial backfill │    │
│  └──────────────┘  full scan    │  2. LISTEN loop      │    │
│                                 │  3. HTTP API         │    │
│                                 └────────┬────────────┘    │
│                                          │ upsert / delete  │
│                                 ┌────────▼────────────┐    │
│                                 │     Typesense        │    │
│                                 │  collection:         │    │
│                                 │  "shipments"         │    │
│                                 └─────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

---

## Sync Strategy

**PostgreSQL `LISTEN/NOTIFY` + Triggers** — chosen for MVP simplicity:
- No WAL plugin or replication slot configuration required
- Works out of the box with the standard `postgres:16` Docker image
- Near real-time (millisecond lag after commit)
- On service startup, a full backfill runs to ensure Typesense is consistent

### Sync Flow

```
DB write (INSERT / UPDATE / DELETE)
  → trigger fires on shipments or cargo table
    → pg_notify('table_changes', JSON payload)
      → sync-service LISTEN receives event
        → joins shipment + cargo rows
          → upserts or deletes document in Typesense
```

---

## Data Models

### PostgreSQL Tables

#### `shipments`
| Column             | Type        | Notes                                      |
|--------------------|-------------|--------------------------------------------|
| id                 | UUID PK     | gen_random_uuid()                          |
| tracking_number    | TEXT UNIQUE | e.g. "SHP-20240501-001"                    |
| status             | TEXT        | pending / in_transit / arrived / delivered |
| carrier            | TEXT        | e.g. "Maersk", "MSC"                       |
| origin_port        | TEXT        | e.g. "Shanghai"                            |
| destination_port   | TEXT        | e.g. "Sydney"                              |
| estimated_arrival  | DATE        |                                            |
| created_at         | TIMESTAMPTZ | default now()                              |
| updated_at         | TIMESTAMPTZ | default now()                              |

#### `cargo`
| Column      | Type        | Notes                         |
|-------------|-------------|-------------------------------|
| id          | UUID PK     | gen_random_uuid()             |
| shipment_id | UUID FK     | references shipments(id)      |
| description | TEXT        | e.g. "Electronic components"  |
| weight_kg   | NUMERIC     |                               |
| volume_m3   | NUMERIC     |                               |
| hazardous   | BOOLEAN     | default false                 |
| created_at  | TIMESTAMPTZ | default now()                 |
| updated_at  | TIMESTAMPTZ | default now()                 |

### Typesense Collection: `shipments`

One denormalised document per shipment, with cargo fields flattened in.

| Field                  | Type    | Searchable | Filterable |
|------------------------|---------|------------|------------|
| id                     | string  | yes        | yes        |
| tracking_number        | string  | yes        | yes        |
| status                 | string  | yes        | yes        |
| carrier                | string  | yes        | yes        |
| origin_port            | string  | yes        | yes        |
| destination_port       | string  | yes        | yes        |
| estimated_arrival      | int64   | no         | yes        |
| cargo_descriptions     | string[]| yes        | no         |
| cargo_total_weight_kg  | float   | no         | yes        |
| cargo_total_volume_m3  | float   | no         | yes        |
| cargo_has_hazardous    | bool    | no         | yes        |
| created_at             | int64   | no         | yes        |
| updated_at             | int64   | no         | yes        |

> Cargo is aggregated into the parent shipment document. When any cargo row changes, the parent shipment document is re-fetched and re-indexed.

---

## Project Structure

```
pgsql-typesense-sync/
├── docker-compose.yml
├── .env                          # local env vars (gitignored)
├── .env.example
│
├── db/
│   └── migrations/
│       ├── 001_create_tables.sql    # shipments + cargo DDL
│       ├── 002_create_triggers.sql  # NOTIFY triggers on both tables
│       └── 003_seed_data.sql        # ~20 shipments, ~40 cargo rows
│
└── sync-service/
    ├── Dockerfile
    ├── package.json
    └── src/
        ├── index.js          # entry point — wires everything together
        ├── config.js         # env var validation
        ├── db.js             # pg pool + LISTEN channel setup
        ├── typesenseClient.js # Typesense client + collection bootstrap
        ├── initialSync.js    # full backfill on startup
        ├── eventHandler.js   # processes NOTIFY payloads
        ├── sync.js           # upsert / delete logic
        └── api.js            # HTTP API (Express) to query Typesense
```

---

## Services

| Service      | Image                      | Port | Notes                              |
|--------------|----------------------------|------|------------------------------------|
| postgres     | postgres:16                | 5432 | with health check                  |
| typesense    | typesense/typesense:27.0   | 8108 | data volume mounted                |
| sync-service | local build                | 3000 | depends on both, restarts on error |

---

## HTTP API Endpoints

All endpoints query Typesense directly (not PostgreSQL).

| Method | Path              | Description                                          |
|--------|-------------------|------------------------------------------------------|
| GET    | /health           | Service health check                                 |
| GET    | /shipments        | Search shipments — supports `q`, `filter_by`, `sort_by`, `page`, `per_page` query params |
| GET    | /shipments/:id    | Fetch a single shipment document by ID               |

### Example request

```
GET /shipments?q=shanghai&filter_by=status:in_transit&sort_by=estimated_arrival:asc&page=1&per_page=10
```

---

## Seed Data (dummy)

~20 shipments across statuses: `pending`, `in_transit`, `arrived`, `delivered`

Carriers: Maersk, MSC, Evergreen, COSCO, Hapag-Lloyd

Routes: Shanghai→Sydney, Shenzhen→Melbourne, Singapore→Auckland, Hamburg→Sydney, Rotterdam→Brisbane

Each shipment has 1–3 cargo items (electronics, clothing, machinery, chemicals marked hazardous).

---

## Implementation Phases

### Phase 1 — Infrastructure ✅
- [x] `docker-compose.yml` with postgres, typesense, sync-service
- [x] `.env.example` with all required variables
- [x] Postgres health check and init script wiring

### Phase 2 — Database ✅
- [x] `001_create_tables.sql` — shipments + cargo DDL
- [x] `002_create_triggers.sql` — `table_changes` NOTIFY triggers for both tables
- [x] `003_seed_data.sql` — dummy shipments and cargo

### Phase 3 — Sync Service ✅
- [x] `config.js` — validate env vars on startup
- [x] `db.js` — pg connection pool + `LISTEN table_changes`
- [x] `typesenseClient.js` — client init + create collection if not exists
- [x] `initialSync.js` — paginated full backfill (shipments JOIN cargo)
- [x] `eventHandler.js` — parse NOTIFY payload, route to upsert or delete
- [x] `sync.js` — join shipment+cargo, build document, upsert/delete in Typesense
- [x] `api.js` — Express routes for `/health`, `/shipments`, `/shipments/:id`
- [x] `index.js` — startup sequence: backfill → listen → start HTTP server

### Phase 4 — Validation ✅
- [x] Verify initial backfill populates all documents
- [x] Test INSERT: new shipment appears in Typesense
- [x] Test UPDATE: shipment status change reflected immediately
- [x] Test DELETE: document removed from Typesense
- [x] Test cargo change: parent shipment document re-indexed
- [x] Test HTTP API search and filter

### Phase 5 — TypeScript Migration ✅

Migrate all `sync-service` source files from JavaScript to TypeScript. No behaviour changes — this is a pure type-safety and developer-experience upgrade, and the foundation for Phase 6 (WAL) and Phase 7 (production hardening) where strong types pay off most.

#### Why TypeScript first

- WAL event decoding (Phase 6) deals with raw binary protocol buffers and complex union types — TypeScript catches mismatches at compile time instead of at runtime in production
- Production hardening (Phase 7) introduces retry wrappers, metrics, and graceful shutdown — typed interfaces make the boundaries between modules explicit
- Strict mode surfaces existing implicit `any` paths in the current JS (e.g. `pg` query rows, Typesense documents) before new complexity is added

#### New dependencies

| Package | Role |
|---|---|
| `typescript` | Compiler |
| `@types/node` | Node.js built-in types |
| `@types/express` | Express types |
| `@types/pg` | pg Pool / Client types |
| `tsx` | Dev runner — executes `.ts` files directly without a compile step |

> `typesense` ships its own types. No `@types/typesense` needed.

#### `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

#### Key types to define (`src/types.ts`)

```ts
// Typesense document shape
export interface ShipmentDocument {
  id: string;
  tracking_number: string;
  status: 'pending' | 'in_transit' | 'arrived' | 'delivered';
  carrier: string;
  origin_port: string;
  destination_port: string;
  estimated_arrival: number;      // unix seconds
  cargo_descriptions: string[];
  cargo_total_weight_kg: number;
  cargo_total_volume_m3: number;
  cargo_has_hazardous: boolean;
  created_at: number;             // unix seconds
  updated_at: number;             // unix seconds
}

// PostgreSQL JOIN result row
export interface ShipmentRow {
  id: string;
  tracking_number: string;
  status: string;
  carrier: string;
  origin_port: string;
  destination_port: string;
  estimated_arrival: Date;
  created_at: Date;
  updated_at: Date;
  cargo_descriptions: string[];
  cargo_total_weight_kg: string;  // pg returns NUMERIC as string
  cargo_total_volume_m3: string;
  cargo_has_hazardous: boolean;
}

// NOTIFY event payload
export interface SyncEvent {
  table: 'shipments' | 'cargo';
  operation: 'INSERT' | 'UPDATE' | 'DELETE';
  id: string;
}

// Typed config
export interface AppConfig {
  postgres: { host: string; port: number; database: string; user: string; password: string };
  typesense: { host: string; port: number; apiKey: string; collection: string };
  port: number;
  syncBatchSize: number;
}
```

#### File renames and changes

| From | To | Notable type additions |
|---|---|---|
| `src/config.js` | `src/config.ts` | Returns `AppConfig`; env vars cast to typed fields |
| `src/db.js` | `src/db.ts` | `createListenClient` callback typed as `(payload: string) => void` |
| `src/typesenseClient.js` | `src/typesenseClient.ts` | `ensureCollection` return type `Promise<void>` |
| `src/sync.js` | `src/sync.ts` | `toDocument(row: ShipmentRow): ShipmentDocument`; strict return types |
| `src/initialSync.js` | `src/initialSync.ts` | Typed batch query result |
| `src/eventHandler.js` | `src/eventHandler.ts` | `handleNotify(payload: string): Promise<void>`; parses to `SyncEvent` |
| `src/api.js` | `src/api.ts` | Request/response types for Express routes |
| `src/index.js` | `src/index.ts` | Top-level wiring unchanged in structure |
| _(new)_ | `src/types.ts` | Central type definitions (see above) |

#### `package.json` script changes

```json
{
  "scripts": {
    "build": "tsc --noEmit false",
    "start": "node dist/index.js",
    "dev":   "tsx watch src/index.ts",
    "typecheck": "tsc --noEmit"
  }
}
```

#### Dockerfile changes (multi-stage build)

```dockerfile
# Stage 1 — compile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install
COPY src/ ./src/
RUN npm run build

# Stage 2 — runtime (no dev dependencies, no source files)
FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY --from=builder /app/dist ./dist
CMD ["node", "dist/index.js"]
```

#### Phase 5 checklist
- [x] Add TypeScript dependencies to `package.json`
- [x] Create `tsconfig.json` with strict mode
- [x] Create `src/types.ts` — `ShipmentDocument`, `ShipmentRow`, `SyncEvent`, `AppConfig`
- [x] Rename and type `config.js` → `config.ts`
- [x] Rename and type `db.js` → `db.ts`
- [x] Rename and type `typesenseClient.js` → `typesenseClient.ts`
- [x] Rename and type `sync.js` → `sync.ts`
- [x] Rename and type `initialSync.js` → `initialSync.ts`
- [x] Rename and type `eventHandler.js` → `eventHandler.ts`
- [x] Rename and type `api.js` → `api.ts`
- [x] Rename and type `index.js` → `index.ts`
- [x] Update `Dockerfile` to multi-stage build (compile → runtime)
- [x] Run `npm run typecheck` — zero errors required
- [x] Run `docker compose up --build` — confirm service starts correctly
- [x] Re-run `scripts/validate.sh` — all 10 tests still pass

---

## Environment Variables

```env
# PostgreSQL
POSTGRES_HOST=postgres
POSTGRES_PORT=5432
POSTGRES_DB=sync_db
POSTGRES_USER=sync_user
POSTGRES_PASSWORD=sync_pass

# Typesense
TYPESENSE_HOST=typesense
TYPESENSE_PORT=8108
TYPESENSE_API_KEY=local-dev-api-key
TYPESENSE_COLLECTION=shipments

# Sync Service
PORT=3000
INITIAL_SYNC_BATCH_SIZE=100
```

---

## Key Design Decisions

| Decision | Choice | Reason |
|---|---|---|
| Sync mechanism | LISTEN/NOTIFY (MVP) → WAL logical replication (prod) | NOTIFY is zero-config; WAL is durable and scalable |
| Typesense document shape | Denormalised (shipment + cargo merged) | Single-collection search; simpler queries |
| Cargo change handling | Re-index parent shipment | Keeps document consistent; cargo volume is low |
| HTTP API target | Typesense (not PG) | Offloads search to the search engine |
| Startup backfill | Full paginated scan | Ensures consistency if service was down |

---

## LISTEN/NOTIFY vs WAL — Comparison

| Concern | LISTEN/NOTIFY (current MVP) | WAL Logical Replication (production) |
|---|---|---|
| **Durability** | Events lost if service is down at time of commit | Events buffered in replication slot — never lost |
| **Resume on restart** | Full backfill required every restart | Resumes from last acknowledged LSN |
| **Throughput** | Limited; each NOTIFY is a separate round-trip | Streaming binary protocol; handles bulk writes efficiently |
| **Payload size** | 8 KB NOTIFY limit | Full row data; no size limit |
| **PostgreSQL config** | None (works with stock image) | `wal_level=logical`, replication slot, publication required |
| **Ordering guarantee** | No ordering — two events can interleave | WAL events are strictly ordered by LSN |
| **Delivery semantics** | At-most-once (drop if consumer is offline) | At-least-once (slot holds position until acknowledged) |
| **Complexity** | Low | Medium |
| **Idempotency required** | Yes (full backfill compensates) | Yes (WAL may re-deliver on restart before ACK) |

---

## Production Roadmap

### Phase 6 — WAL-based CDC (Logical Replication)

Replace LISTEN/NOTIFY triggers with PostgreSQL logical replication. The sync-service subscribes to a replication slot using the built-in `pgoutput` plugin — no extra PostgreSQL extensions needed.

#### What changes

**PostgreSQL (docker-compose + migrations)**

```yaml
# docker-compose.yml — postgres service
command: >
  postgres
  -c wal_level=logical
  -c max_replication_slots=5
  -c max_wal_senders=5
```

```sql
-- 004_wal_setup.sql
CREATE USER sync_replication_user REPLICATION LOGIN PASSWORD 'replication_pass';
GRANT SELECT ON shipments, cargo TO sync_replication_user;

CREATE PUBLICATION sync_pub FOR TABLE shipments, cargo;

-- Slot created by the application on first start (not in migration, to avoid duplicate slot errors)
```

> Triggers in `002_create_triggers.sql` can be dropped once WAL is live. Keep them as a fallback during the migration period.

**New npm dependency**
```
pg-logical-replication  — logical replication client with pgoutput plugin support
```

**New / changed source files**

| File | Change |
|---|---|
| `src/db.js` | Remove `createListenClient`; add `createReplicationClient` |
| `src/walHandler.js` | New — decodes pgoutput WAL messages (Relation, Insert, Update, Delete) |
| `src/eventHandler.js` | Updated — receives structured WAL events instead of JSON NOTIFY strings |
| `src/index.js` | Updated — startup sequence now: backfill (first run only) → start replication stream |

**WAL sync flow**

```
DB write (INSERT / UPDATE / DELETE)
  → PostgreSQL WAL
    → Replication slot 'sync_slot' (pgoutput decoder)
      → sync-service replication client (streaming)
        → walHandler decodes: Relation / Insert / Update / Delete message
          → eventHandler routes to upsertShipment or deleteShipment
            → Typesense upsert / delete
              → pg_replication_slot_advance(LSN)  ← acknowledges to PostgreSQL
```

**Key behaviour differences from LISTEN/NOTIFY**
- No full backfill on restart — slot preserves position across restarts
- Initial backfill still runs once (first-time setup, slot has no prior state)
- LSN is acknowledged **after** Typesense write succeeds — ensures at-least-once delivery
- If Typesense write fails and retries are exhausted, event goes to dead-letter table and LSN is **not** advanced until resolved

**New env vars**
```env
POSTGRES_REPLICATION_USER=sync_replication_user
POSTGRES_REPLICATION_PASSWORD=replication_pass
REPLICATION_SLOT=sync_slot
REPLICATION_PUBLICATION=sync_pub
```

#### Phase 6 checklist
- [ ] Update `docker-compose.yml` — add postgres WAL config flags
- [ ] `004_wal_setup.sql` — replication user, publication
- [ ] Install `pg-logical-replication` dependency
- [ ] `src/walHandler.ts` — decode pgoutput Relation/Insert/Update/Delete messages
- [ ] Update `src/db.ts` — add `createReplicationClient`, manage slot creation
- [ ] Update `src/eventHandler.ts` — consume structured WAL events
- [ ] Update `src/index.ts` — conditional backfill (first-run only via slot state check)
- [ ] Remove `002_create_triggers.sql` dependency (drop triggers)
- [ ] Update `.env.example` with new replication env vars
- [ ] Extend `scripts/validate.sh` — verify slot exists and LSN advances after writes

---

### Phase 7 — Production Hardening

Make the service deployable, observable, and resilient under failure.

#### 7.1 — Retry & Error Resilience

Every Typesense API call wrapped in exponential backoff retry logic. Persistently failing events written to a dead-letter table in PostgreSQL so they can be inspected and replayed without losing WAL position.

**New dependency**: `p-retry`

**New / changed files**

| File | Change |
|---|---|
| `src/retry.js` | Exponential backoff wrapper around Typesense calls |
| `src/deadLetter.js` | Write failed events to `sync_dead_letter` DB table |
| `sync.js` | Wrap `upsertShipment` / `deleteShipment` with retry, then dead-letter on exhaustion |

```sql
-- 005_dead_letter.sql
CREATE TABLE sync_dead_letter (
  id          BIGSERIAL PRIMARY KEY,
  table_name  TEXT        NOT NULL,
  operation   TEXT        NOT NULL,
  record_id   UUID        NOT NULL,
  payload     JSONB,
  error       TEXT,
  attempts    INT         NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
```

**Retry config (env vars)**
```env
RETRY_MAX_ATTEMPTS=5
RETRY_INITIAL_DELAY_MS=500
RETRY_MAX_DELAY_MS=30000
```

**Retry behaviour**
- Attempts: 5
- Backoff: exponential with jitter (`500ms → 1s → 2s → 4s → 8s`)
- On exhaustion: write to `sync_dead_letter`, advance LSN (do not block the stream)
- Dead-letter entries can be replayed via a future `/admin/replay` endpoint

#### 7.2 — Structured Logging

Replace `console.log` with `pino` — JSON structured logs with level filtering, timestamps, and correlation fields.

**New dependency**: `pino`

**New file**: `src/logger.js`

```js
// every log line includes: level, time, service, msg, plus structured context
logger.info({ shipmentId, operation }, 'document upserted');
logger.error({ err, shipmentId }, 'upsert failed after max retries');
```

**New env var**
```env
LOG_LEVEL=info   # trace | debug | info | warn | error
```

#### 7.3 — Observability (Metrics)

Prometheus-compatible `/metrics` endpoint exposing:

| Metric | Type | Description |
|---|---|---|
| `sync_events_total` | Counter | Events processed, labelled by `operation` (insert/update/delete) and `status` (success/failed) |
| `sync_dead_letter_total` | Counter | Events written to dead-letter table |
| `sync_replication_lag_bytes` | Gauge | WAL bytes between write LSN and flush LSN (Phase 5 only) |
| `sync_typesense_request_duration_seconds` | Histogram | Typesense API call latency |
| `sync_last_event_timestamp` | Gauge | Unix timestamp of last successfully processed event |

**New dependency**: `prom-client`

**New file**: `src/metrics.js`

**New API route**: `GET /metrics` (Prometheus text format)

**Updated** `GET /health` — returns structured JSON including:
- PostgreSQL connectivity
- Typesense connectivity
- Replication slot lag (Phase 5)
- Last event processed timestamp

```json
{
  "status": "ok",
  "postgres": "connected",
  "typesense": "connected",
  "replication_lag_bytes": 0,
  "last_event_at": "2024-05-01T12:00:00Z"
}
```

#### 7.4 — Graceful Shutdown

On `SIGTERM` / `SIGINT`:
1. Stop accepting new replication messages
2. Drain in-flight Typesense writes (wait up to 30s)
3. Acknowledge processed LSN to PostgreSQL
4. Close DB pool and replication client
5. Exit 0

**New file**: `src/gracefulShutdown.js`

#### 7.5 — Service Split (Sync Worker vs API)

The sync worker must be a **singleton** (only one consumer per replication slot). The HTTP API can scale horizontally. Split into two separate deployable units:

```
sync-worker   — replication consumer, singleton, no public port
api-service   — Express HTTP server, horizontally scalable, port 3000
```

Both read from the same PostgreSQL and Typesense instances.

**Updated project structure**

```
pgsql-typesense-sync/
├── docker-compose.yml
├── docker-compose.prod.yml        # production overrides
├── .env / .env.example
│
├── db/
│   └── migrations/
│       ├── 001_create_tables.sql
│       ├── 002_create_triggers.sql   # kept for rollback; drop after WAL migration
│       ├── 003_seed_data.sql
│       ├── 004_wal_setup.sql         # Phase 5: replication user + publication
│       └── 005_dead_letter.sql       # Phase 6: dead-letter table
│
├── sync-service/
│   ├── Dockerfile
│   ├── package.json
│   └── src/
│       ├── index.js                  # entry: starts worker + API
│       ├── config.js
│       ├── logger.js                 # Phase 6: pino structured logging
│       ├── metrics.js                # Phase 6: Prometheus metrics
│       ├── db.js                     # pg pool + replication client (Phase 5)
│       ├── walHandler.js             # Phase 5: pgoutput WAL decoder
│       ├── typesenseClient.js
│       ├── initialSync.js
│       ├── eventHandler.js
│       ├── sync.js
│       ├── retry.js                  # Phase 6: exponential backoff
│       ├── deadLetter.js             # Phase 6: dead-letter writes
│       ├── gracefulShutdown.js       # Phase 6: SIGTERM handler
│       └── api.js
│
└── k8s/                             # Phase 6: Kubernetes manifests
    ├── sync-worker-deployment.yaml  # replica: 1 (singleton)
    ├── api-deployment.yaml          # replica: 2+, HPA enabled
    ├── service.yaml
    ├── configmap.yaml
    ├── secret.yaml                  # base64 credentials
    └── hpa.yaml
```

#### 7.6 — Docker & Container Hardening

- Run as non-root user in Dockerfile (`USER node`)
- Add `HEALTHCHECK` instruction to Dockerfile
- Add `docker-compose.prod.yml` with resource limits and no dev mounts
- Use multi-stage build to keep image lean

```dockerfile
# production Dockerfile additions
RUN addgroup -S app && adduser -S app -G app
USER app
HEALTHCHECK --interval=10s --timeout=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:${PORT}/health', r => process.exit(r.statusCode === 200 ? 0 : 1))"
```

#### 7.7 — Security

| Concern | Action |
|---|---|
| DB credentials | Move to secrets manager (AWS Secrets Manager / Vault) in production |
| Replication user | Dedicated role with only `REPLICATION` + `SELECT` privileges |
| Typesense API key | Rotate via admin API key; provide scoped search-only key for API service |
| TLS | Enable `sslmode=require` for PostgreSQL connections in production |
| Docker | Non-root user; read-only filesystem where possible |
| Rate limiting | Add `express-rate-limit` to API routes |

#### Phase 7 checklist
- [ ] `src/retry.ts` — exponential backoff with jitter
- [ ] `005_dead_letter.sql` — dead-letter table migration
- [ ] `src/deadLetter.ts` — write and retrieve dead-letter events
- [ ] Update `src/sync.ts` — wrap calls in retry + dead-letter fallback
- [ ] `src/logger.ts` — pino structured logger, replace all console calls
- [ ] `src/metrics.ts` — prom-client metrics registry
- [ ] `src/gracefulShutdown.ts` — SIGTERM drain and clean exit
- [ ] Update `src/api.ts` — add `GET /metrics`, enrich `GET /health`
- [ ] Update `Dockerfile` — non-root user, HEALTHCHECK instruction
- [ ] `docker-compose.prod.yml` — resource limits, no volume mounts for src
- [ ] `k8s/` — Deployment (worker singleton + API), Service, ConfigMap, Secret, HPA
- [ ] Add `express-rate-limit` to API routes
- [ ] Update `.env.example` with all new env vars
- [ ] Update `scripts/validate.sh` — test `/metrics` and enriched `/health`

---

## Updated Environment Variables (full production set)

```env
# PostgreSQL — application user
POSTGRES_HOST=postgres
POSTGRES_PORT=5432
POSTGRES_DB=sync_db
POSTGRES_USER=sync_user
POSTGRES_PASSWORD=sync_pass

# PostgreSQL — replication user (Phase 5)
POSTGRES_REPLICATION_USER=sync_replication_user
POSTGRES_REPLICATION_PASSWORD=replication_pass
REPLICATION_SLOT=sync_slot
REPLICATION_PUBLICATION=sync_pub

# Typesense
TYPESENSE_HOST=typesense
TYPESENSE_PORT=8108
TYPESENSE_API_KEY=local-dev-api-key
TYPESENSE_COLLECTION=shipments

# Sync Service
PORT=3000
INITIAL_SYNC_BATCH_SIZE=100

# Retry (Phase 6)
RETRY_MAX_ATTEMPTS=5
RETRY_INITIAL_DELAY_MS=500
RETRY_MAX_DELAY_MS=30000

# Observability (Phase 6)
LOG_LEVEL=info
```
