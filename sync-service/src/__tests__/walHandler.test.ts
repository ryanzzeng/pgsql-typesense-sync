import { walMessageToSyncEvent } from '../walHandler';

const LSN = '0/1234ABC';

const shipmentInsert = {
  tag: 'insert',
  relation: { name: 'shipments' },
  new: { id: 'ship-1', tracking_number: 'SHP-001' },
};

const shipmentUpdate = {
  tag: 'update',
  relation: { name: 'shipments' },
  new: { id: 'ship-1', status: 'in_transit' },
};

const shipmentDelete = {
  tag: 'delete',
  relation: { name: 'shipments' },
  key: { id: 'ship-1' },
};

const cargoInsert = {
  tag: 'insert',
  relation: { name: 'cargo' },
  new: { id: 'cargo-1', shipment_id: 'ship-1', description: 'Electronics' },
};

const cargoDeleteFull = {
  tag: 'delete',
  relation: { name: 'cargo' },
  old: { id: 'cargo-1', shipment_id: 'ship-1', description: 'Electronics' },
};

describe('walMessageToSyncEvent', () => {
  it('returns INSERT event for shipment insert', () => {
    const event = walMessageToSyncEvent(shipmentInsert, LSN);
    expect(event).toMatchObject({ table: 'shipments', operation: 'INSERT', id: 'ship-1', lsn: LSN });
    expect(event?.eventId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('returns UPDATE event for shipment update', () => {
    const event = walMessageToSyncEvent(shipmentUpdate, LSN);
    expect(event).toMatchObject({ table: 'shipments', operation: 'UPDATE', id: 'ship-1', lsn: LSN });
    expect(event?.eventId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('returns DELETE event for shipment delete (key)', () => {
    const event = walMessageToSyncEvent(shipmentDelete, LSN);
    expect(event).toMatchObject({ table: 'shipments', operation: 'DELETE', id: 'ship-1', lsn: LSN });
    expect(event?.eventId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('returns INSERT event for cargo insert with parent shipment_id', () => {
    const event = walMessageToSyncEvent(cargoInsert, LSN);
    expect(event).toMatchObject({ table: 'cargo', operation: 'INSERT', id: 'ship-1', lsn: LSN });
  });

  it('returns DELETE event for cargo delete with REPLICA IDENTITY FULL (old)', () => {
    const event = walMessageToSyncEvent(cargoDeleteFull, LSN);
    expect(event).toMatchObject({ table: 'cargo', operation: 'DELETE', id: 'ship-1', lsn: LSN });
  });

  it('generates a unique eventId per call', () => {
    const a = walMessageToSyncEvent(shipmentInsert, LSN);
    const b = walMessageToSyncEvent(shipmentInsert, LSN);
    expect(a?.eventId).not.toBe(b?.eventId);
  });

  it('returns null for an untracked table', () => {
    expect(walMessageToSyncEvent({ tag: 'insert', relation: { name: 'users' }, new: { id: '1' } }, LSN)).toBeNull();
  });

  it('returns null for a non-object input', () => {
    expect(walMessageToSyncEvent(null, LSN)).toBeNull();
    expect(walMessageToSyncEvent('string', LSN)).toBeNull();
    expect(walMessageToSyncEvent(42, LSN)).toBeNull();
  });

  it('returns null for a begin/commit message', () => {
    expect(walMessageToSyncEvent({ tag: 'begin' }, LSN)).toBeNull();
    expect(walMessageToSyncEvent({ tag: 'commit' }, LSN)).toBeNull();
  });

  it('returns null for insert with missing id', () => {
    expect(walMessageToSyncEvent({ tag: 'insert', relation: { name: 'shipments' }, new: {} }, LSN)).toBeNull();
  });
});
