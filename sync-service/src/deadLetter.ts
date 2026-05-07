import { pool } from './db';
import logger from './logger';
import { syncDeadLetterTotal } from './metrics';

export async function writeDeadLetter(opts: {
  tableName: string;
  operation: string;
  recordId:  string;
  payload?:  unknown;
  error:     string;
  attempts:  number;
}): Promise<void> {
  const { tableName, operation, recordId, payload, error, attempts } = opts;

  await pool.query(
    `INSERT INTO sync_dead_letter (table_name, operation, record_id, payload, error, attempts)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [tableName, operation, recordId, payload != null ? JSON.stringify(payload) : null, error, attempts],
  );

  syncDeadLetterTotal.inc();
  logger.error({ tableName, operation, recordId, attempts, error }, 'event written to dead-letter table');
}
