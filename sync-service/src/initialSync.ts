import { pool } from './db';
import { client as tsClient } from './typesenseClient';
import { toDocument } from './sync';
import config from './config';
import logger from './logger';
import { ShipmentRow } from './types';
import { SHIPMENT_PAGE_QUERY } from './queries';

export async function runInitialSync(): Promise<void> {
  logger.info('starting full backfill');

  const batchSize = config.syncBatchSize;
  let offset = 0;
  let total = 0;

  while (true) {
    const { rows } = await pool.query<ShipmentRow>(SHIPMENT_PAGE_QUERY, [batchSize, offset]);
    if (rows.length === 0) break;

    const documents = rows.map(toDocument);

    await tsClient
      .collections(config.typesense.collection)
      .documents()
      .import(documents, { action: 'upsert' });

    total += documents.length;
    logger.info({ total }, 'backfill progress');

    if (rows.length < batchSize) break;
    offset += batchSize;
  }

  logger.info({ total }, 'initial sync complete');
}
