import { upsertShipment, deleteShipment } from './sync';
import { recordLastEvent } from './metrics';
import { SyncEvent } from './types';

export async function handleEvent(event: SyncEvent): Promise<void> {
  const { table, operation, id } = event;

  if (operation === 'DELETE' && table === 'shipments') {
    await deleteShipment(id);
  } else {
    await upsertShipment(id);
  }

  recordLastEvent();
}
