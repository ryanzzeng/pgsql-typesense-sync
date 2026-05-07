import { Pool } from 'pg';
import config from './config';
import logger from './logger';

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
