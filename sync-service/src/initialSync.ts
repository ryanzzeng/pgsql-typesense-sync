import { pool } from './db';
import { client as tsClient } from './typesenseClient';
import { toDocument } from './sync';
import config from './config';
import logger from './logger';
import { ShipmentRow } from './types';

const BATCH_QUERY = `
  SELECT
    s.id,
    s.tracking_number,
    s.status,
    s.carrier,
    s.origin_port,
    s.destination_port,
    s.estimated_arrival,
    s.created_at,
    s.updated_at,
    COALESCE(array_agg(c.description) FILTER (WHERE c.id IS NOT NULL), '{}') AS cargo_descriptions,
    COALESCE(SUM(c.weight_kg), 0)         AS cargo_total_weight_kg,
    COALESCE(SUM(c.volume_m3), 0)         AS cargo_total_volume_m3,
    COALESCE(BOOL_OR(c.hazardous), false) AS cargo_has_hazardous
  FROM shipments s
  LEFT JOIN cargo c ON c.shipment_id = s.id
  GROUP BY s.id
  ORDER BY s.created_at
  LIMIT $1 OFFSET $2
`;

export async function runInitialSync(): Promise<void> {
  logger.info('starting full backfill');

  const batchSize = config.syncBatchSize;
  let offset = 0;
  let total = 0;

  while (true) {
    const { rows } = await pool.query<ShipmentRow>(BATCH_QUERY, [batchSize, offset]);
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
