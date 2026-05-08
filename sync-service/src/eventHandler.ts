import { upsertShipment, deleteShipment } from './sync';
import { recordLastEvent } from './metrics';
import { SyncEvent } from './types';
import logger from './logger';

export async function handleEvent(event: SyncEvent): Promise<void> {
  const { table, operation, id, eventId, lsn } = event;
  const ctx = { eventId, lsn, shipmentId: id, table, operation };

  logger.debug(ctx, 'processing WAL event');

  if (operation === 'DELETE' && table === 'shipments') {
    await deleteShipment(id, eventId);
  } else {
    await upsertShipment(id, eventId);
  }

  recordLastEvent();
  logger.debug(ctx, 'WAL event processed');
}
