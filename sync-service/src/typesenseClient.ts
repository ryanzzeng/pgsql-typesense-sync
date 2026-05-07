import Typesense from 'typesense';
import type { CollectionCreateSchema } from 'typesense/lib/Typesense/Collections';
import config from './config';
import logger from './logger';

export const client = new Typesense.Client({
  nodes: [{ host: config.typesense.host, port: config.typesense.port, protocol: 'http' }],
  apiKey: config.typesense.apiKey,
  connectionTimeoutSeconds: 10,
});

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
  try {
    await client.collections(config.typesense.collection).retrieve();
    logger.info({ collection: config.typesense.collection }, 'typesense collection already exists');
  } catch (err: unknown) {
    if ((err as { httpStatus?: number }).httpStatus === 404) {
      await client.collections().create(collectionSchema);
      logger.info({ collection: config.typesense.collection }, 'typesense collection created');
    } else {
      throw err;
    }
  }
}
