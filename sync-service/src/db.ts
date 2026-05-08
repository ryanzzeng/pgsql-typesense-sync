import { Pool } from 'pg';
import config from './config';
import logger from './logger';
import { syncReplicationLagBytes } from './metrics';

export const pool = new Pool(config.postgres);

pool.on('error', (err: Error) => {
  logger.error({ err: err.message }, 'pg idle client error');
});

export async function ensureReplicationSlot(): Promise<void> {
  const { rows } = await pool.query<{ slot_name: string }>(
    `SELECT slot_name FROM pg_replication_slots WHERE slot_name = $1`,
    [config.replication.slotName],
  );

  if (rows.length === 0) {
    await pool.query(
      `SELECT pg_create_logical_replication_slot($1, 'pgoutput')`,
      [config.replication.slotName],
    );
    logger.info({ slotName: config.replication.slotName }, 'replication slot created');
  } else {
    logger.info({ slotName: config.replication.slotName }, 'replication slot ready');
  }
}

/**
 * Polls pg_replication_slots every `intervalMs` and updates the
 * sync_replication_lag_bytes gauge. Returns a stop function.
 *
 * pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn) gives the
 * number of WAL bytes the slot has not yet acknowledged. A value of 0
 * means the service is fully caught up; a growing value means it is
 * falling behind.
 */
export function startLagPoller(intervalMs: number): () => void {
  const timer = setInterval(async () => {
    try {
      const { rows } = await pool.query<{ lag_bytes: string }>(
        `SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn)::bigint AS lag_bytes
         FROM pg_replication_slots
         WHERE slot_name = $1`,
        [config.replication.slotName],
      );
      if (rows.length > 0) {
        syncReplicationLagBytes.set(parseInt(rows[0].lag_bytes, 10));
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'lag poller query failed');
    }
  }, intervalMs);

  return () => clearInterval(timer);
}
