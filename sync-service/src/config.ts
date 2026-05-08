import { AppConfig } from './types';

const required = [
  'POSTGRES_HOST',
  'POSTGRES_PORT',
  'POSTGRES_DB',
  'POSTGRES_USER',
  'POSTGRES_PASSWORD',
  'TYPESENSE_HOST',
  'TYPESENSE_PORT',
  'TYPESENSE_API_KEY',
  'TYPESENSE_COLLECTION',
  'PORT',
] as const;


for (const key of required) {
  if (!process.env[key]) throw new Error(`Missing required env var: ${key}`);
}

const config: AppConfig = {
  postgres: {
    host:                    process.env.POSTGRES_HOST!,
    port:                    parseInt(process.env.POSTGRES_PORT!, 10),
    database:                process.env.POSTGRES_DB!,
    user:                    process.env.POSTGRES_USER!,
    password:                process.env.POSTGRES_PASSWORD!,
    max:                     parseInt(process.env.PG_POOL_MAX                  ?? '10',    10),
    idleTimeoutMillis:       parseInt(process.env.PG_POOL_IDLE_TIMEOUT_MS      ?? '10000', 10),
    connectionTimeoutMillis: parseInt(process.env.PG_POOL_CONNECTION_TIMEOUT_MS ?? '5000', 10),
  },
  typesense: {
    host:         process.env.TYPESENSE_HOST!,
    port:         parseInt(process.env.TYPESENSE_PORT!, 10),
    apiKey:       process.env.TYPESENSE_API_KEY!,
    searchApiKey: process.env.TYPESENSE_SEARCH_API_KEY ?? process.env.TYPESENSE_API_KEY!,
    collection:   process.env.TYPESENSE_COLLECTION!,
  },
  replication: {
    slotName:        process.env.REPLICATION_SLOT        ?? 'sync_slot',
    publicationName: process.env.REPLICATION_PUBLICATION ?? 'sync_pub',
  },
  retry: {
    maxAttempts:    parseInt(process.env.RETRY_MAX_ATTEMPTS    ?? '5',     10),
    initialDelayMs: parseInt(process.env.RETRY_INITIAL_DELAY_MS ?? '500', 10),
    maxDelayMs:     parseInt(process.env.RETRY_MAX_DELAY_MS    ?? '30000', 10),
  },
  port:             parseInt(process.env.PORT!, 10),
  syncBatchSize:    parseInt(process.env.INITIAL_SYNC_BATCH_SIZE ?? '100', 10),
  logLevel:         process.env.LOG_LEVEL ?? 'info',
  apiKey:           process.env.API_KEY || undefined,
  coalesceWindowMs: parseInt(process.env.COALESCE_WINDOW_MS ?? '50', 10),
};

export default config;
