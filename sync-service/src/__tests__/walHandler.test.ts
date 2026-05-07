import { walMessageToSyncEvent } from '../walHandler';

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
    expect(walMessageToSyncEvent(shipmentInsert)).toEqual({
      table: 'shipments', operation: 'INSERT', id: 'ship-1',
    });
  });

  it('returns UPDATE event for shipment update', () => {
    expect(walMessageToSyncEvent(shipmentUpdate)).toEqual({
      table: 'shipments', operation: 'UPDATE', id: 'ship-1',
    });
  });

  it('returns DELETE event for shipment delete (key)', () => {
    expect(walMessageToSyncEvent(shipmentDelete)).toEqual({
      table: 'shipments', operation: 'DELETE', id: 'ship-1',
    });
  });

  it('returns INSERT event for cargo insert with parent shipment_id', () => {
    expect(walMessageToSyncEvent(cargoInsert)).toEqual({
      table: 'cargo', operation: 'INSERT', id: 'ship-1',
    });
  });

  it('returns DELETE event for cargo delete with REPLICA IDENTITY FULL (old)', () => {
    expect(walMessageToSyncEvent(cargoDeleteFull)).toEqual({
      table: 'cargo', operation: 'DELETE', id: 'ship-1',
    });
  });

  it('returns null for an untracked table', () => {
    expect(walMessageToSyncEvent({ tag: 'insert', relation: { name: 'users' }, new: { id: '1' } })).toBeNull();
  });

  it('returns null for a non-object input', () => {
    expect(walMessageToSyncEvent(null)).toBeNull();
    expect(walMessageToSyncEvent('string')).toBeNull();
    expect(walMessageToSyncEvent(42)).toBeNull();
  });

  it('returns null for a begin/commit message', () => {
    expect(walMessageToSyncEvent({ tag: 'begin' })).toBeNull();
    expect(walMessageToSyncEvent({ tag: 'commit' })).toBeNull();
  });

  it('returns null for insert with missing id', () => {
    expect(walMessageToSyncEvent({ tag: 'insert', relation: { name: 'shipments' }, new: {} })).toBeNull();
  });
});
