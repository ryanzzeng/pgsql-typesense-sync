import { pool } from './db';
import { client as tsClient } from './typesenseClient';
import config from './config';
import logger from './logger';
import { withRetry } from './retry';
import { writeDeadLetter } from './deadLetter';
import { syncTypesenseRequestDuration, recordEvent } from './metrics';
import { ShipmentDocument, ShipmentRow } from './types';

const QUERY = `
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
  WHERE s.id = $1
  GROUP BY s.id
`;

export function toDocument(row: ShipmentRow): ShipmentDocument {
  return {
    id:                    row.id,
    tracking_number:       row.tracking_number,
    status:                row.status as ShipmentDocument['status'],
    carrier:               row.carrier,
    origin_port:           row.origin_port,
    destination_port:      row.destination_port,
    estimated_arrival:     Math.floor(new Date(row.estimated_arrival).getTime() / 1000),
    cargo_descriptions:    row.cargo_descriptions,
    cargo_total_weight_kg: parseFloat(row.cargo_total_weight_kg),
    cargo_total_volume_m3: parseFloat(row.cargo_total_volume_m3),
    cargo_has_hazardous:   row.cargo_has_hazardous,
    created_at:            Math.floor(new Date(row.created_at).getTime() / 1000),
    updated_at:            Math.floor(new Date(row.updated_at).getTime() / 1000),
  };
}

export async function upsertShipment(id: string): Promise<void> {
  const ctx = { shipmentId: id, operation: 'upsert' };

  try {
    await withRetry(async () => {
      const { rows } = await pool.query<ShipmentRow>(QUERY, [id]);
      if (rows.length === 0) return;
      const doc = toDocument(rows[0]);

      const end = syncTypesenseRequestDuration.startTimer();
      await tsClient.collections(config.typesense.collection).documents().upsert(doc);
      end();

      logger.info({ shipmentId: id, trackingNumber: doc.tracking_number }, 'document upserted');
    }, ctx);

    recordEvent('upsert', true);
  } catch (err) {
    recordEvent('upsert', false);
    await writeDeadLetter({
      tableName: 'shipments',
      operation: 'UPSERT',
      recordId:  id,
      error:     (err as Error).message,
      attempts:  config.retry.maxAttempts,
    });
  }
}

export async function deleteShipment(id: string): Promise<void> {
  const ctx = { shipmentId: id, operation: 'delete' };

  try {
    await withRetry(async () => {
      const end = syncTypesenseRequestDuration.startTimer();
      try {
        await tsClient.collections(config.typesense.collection).documents(id).delete();
      } catch (err: unknown) {
        if ((err as { httpStatus?: number }).httpStatus === 404) return;
        throw err;
      } finally {
        end();
      }
      logger.info({ shipmentId: id }, 'document deleted');
    }, ctx);

    recordEvent('delete', true);
  } catch (err) {
    recordEvent('delete', false);
    await writeDeadLetter({
      tableName: 'shipments',
      operation: 'DELETE',
      recordId:  id,
      error:     (err as Error).message,
      attempts:  config.retry.maxAttempts,
    });
  }
}
