import Typesense from 'typesense';
import type { CollectionCreateSchema } from 'typesense/lib/Typesense/Collections';
import config from './config';
import logger from './logger';

// Admin client — used for writes and collection management
export const client = new Typesense.Client({
  nodes: [{ host: config.typesense.host, port: config.typesense.port, protocol: 'http' }],
  apiKey: config.typesense.apiKey,
  connectionTimeoutSeconds: 10,
});

// Search client — uses a scoped read-only key if TYPESENSE_SEARCH_API_KEY is set,
// otherwise falls back to the admin client
export const searchClient =
  config.typesense.searchApiKey !== config.typesense.apiKey
    ? new Typesense.Client({
        nodes: [{ host: config.typesense.host, port: config.typesense.port, protocol: 'http' }],
        apiKey: config.typesense.searchApiKey,
        connectionTimeoutSeconds: 10,
      })
    : client;

const collectionSchema: CollectionCreateSchema = {
  name: config.typesense.collection,
  fields: [
    { name: 'id',                    type: 'string'   },
    { name: 'tracking_number',       type: 'string'   },
    { name: 'status',                type: 'string',  facet: true },
    { name: 'carrier',               type: 'string',  facet: true },
    { name: 'origin_port',           type: 'string',  facet: true },
    { name: 'destination_port',      type: 'string',  facet: true },
    { name: 'estimated_arrival',     type: 'int64'    },
    { name: 'cargo_descriptions',    type: 'string[]' },
    { name: 'cargo_total_weight_kg', type: 'float'    },
    { name: 'cargo_total_volume_m3', type: 'float'    },
    { name: 'cargo_has_hazardous',   type: 'bool',    facet: true },
    { name: 'created_at',            type: 'int64'    },
    { name: 'updated_at',            type: 'int64'    },
  ],
  default_sorting_field: 'estimated_arrival',
};

async function waitForTypesense(retries = 20, delayMs = 3000): Promise<void> {
  for (let i = 1; i <= retries; i++) {
    try {
      await client.health.retrieve();
      logger.info('typesense ready');
      return;
    } catch {
      logger.info({ attempt: i, retries, delayMs }, 'typesense not ready yet — retrying');
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error('Typesense did not become ready in time');
}

export async function ensureCollection(): Promise<void> {
  await waitForTypesense();

  const alias = config.typesense.collection;
  const versionedName = `${alias}_v1`;

  // 1. Alias already exists — collection is already set up with the alias pattern
  try {
    await client.aliases(alias).retrieve();
    logger.info({ alias }, 'typesense collection alias ready');
    if (config.typesense.searchApiKey === config.typesense.apiKey) {
      logger.warn('TYPESENSE_SEARCH_API_KEY not set — HTTP API is using the admin key; set a search-only key for production');
    }
    return;
  } catch (err) {
    if ((err as { httpStatus?: number }).httpStatus !== 404) throw err;
  }

  // 2. Plain collection exists (legacy setup without alias) — use it as-is
  try {
    await client.collections(alias).retrieve();
    logger.warn({ collection: alias }, 'collection exists without alias — using directly; run a migration to adopt the alias pattern for zero-downtime schema changes');
    return;
  } catch (err) {
    if ((err as { httpStatus?: number }).httpStatus !== 404) throw err;
  }

  // 3. Fresh install — create versioned collection + alias
  try {
    await client.collections(versionedName).retrieve();
    logger.info({ collection: versionedName }, 'versioned collection already exists');
  } catch (err) {
    if ((err as { httpStatus?: number }).httpStatus === 404) {
      await client.collections().create({ ...collectionSchema, name: versionedName });
      logger.info({ collection: versionedName }, 'typesense collection created');
    } else {
      throw err;
    }
  }

  await client.aliases().upsert(alias, { collection_name: versionedName });
  logger.info({ alias, collection: versionedName }, 'typesense alias created');
}
