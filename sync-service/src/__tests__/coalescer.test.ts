import { EventCoalescer } from '../coalescer';
import { SyncEvent } from '../types';

jest.mock('../logger');

const noop = (): void => {};

const upsert = (id: string, table: 'shipments' | 'cargo' = 'shipments'): SyncEvent =>
  ({ table, operation: 'INSERT', id });

const del = (id: string): SyncEvent =>
  ({ table: 'shipments', operation: 'DELETE', id });

describe('EventCoalescer', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('flushes a single event after the window', async () => {
    const onFlush = jest.fn().mockResolvedValue(undefined);
    const c = new EventCoalescer(50, onFlush);

    c.add(upsert('ship-1'), noop);
    expect(onFlush).not.toHaveBeenCalled();

    await jest.runAllTimersAsync();
    expect(onFlush).toHaveBeenCalledWith([upsert('ship-1')]);
  });

  it('deduplicates multiple upserts for the same shipment — keeps last', async () => {
    const onFlush = jest.fn().mockResolvedValue(undefined);
    const c = new EventCoalescer(50, onFlush);

    const e1: SyncEvent = { table: 'shipments', operation: 'INSERT', id: 'ship-1' };
    const e2: SyncEvent = { table: 'shipments', operation: 'UPDATE', id: 'ship-1' };
    c.add(e1, noop);
    c.add(e2, noop);

    await jest.runAllTimersAsync();
    expect(onFlush).toHaveBeenCalledWith([e2]);
  });

  it('DELETE supersedes a pending upsert for the same shipment', async () => {
    const onFlush = jest.fn().mockResolvedValue(undefined);
    const c = new EventCoalescer(50, onFlush);

    c.add(upsert('ship-1'), noop);
    c.add(del('ship-1'), noop);

    await jest.runAllTimersAsync();
    expect(onFlush).toHaveBeenCalledWith([del('ship-1')]);
  });

  it('DELETE is not overwritten by a subsequent upsert', async () => {
    const onFlush = jest.fn().mockResolvedValue(undefined);
    const c = new EventCoalescer(50, onFlush);

    c.add(del('ship-1'), noop);
    c.add(upsert('ship-1'), noop);  // should be ignored

    await jest.runAllTimersAsync();
    expect(onFlush).toHaveBeenCalledWith([del('ship-1')]);
  });

  it('keeps events for different shipments separate', async () => {
    const onFlush = jest.fn().mockResolvedValue(undefined);
    const c = new EventCoalescer(50, onFlush);

    c.add(upsert('ship-1'), noop);
    c.add(upsert('ship-2'), noop);

    await jest.runAllTimersAsync();
    const flushed = onFlush.mock.calls[0][0] as SyncEvent[];
    expect(flushed).toHaveLength(2);
    expect(flushed.map((e) => e.id).sort()).toEqual(['ship-1', 'ship-2']);
  });

  it('drain() flushes immediately without waiting for the timer', async () => {
    const onFlush = jest.fn().mockResolvedValue(undefined);
    const c = new EventCoalescer(50, onFlush);

    c.add(upsert('ship-1'), noop);
    await c.drain();

    expect(onFlush).toHaveBeenCalledWith([upsert('ship-1')]);
  });

  it('drain() on empty buffer does nothing', async () => {
    const onFlush = jest.fn().mockResolvedValue(undefined);
    const c = new EventCoalescer(50, onFlush);
    await c.drain();
    expect(onFlush).not.toHaveBeenCalled();
  });

  it('calls ack for each event only after onFlush resolves', async () => {
    let flushResolve!: () => void;
    const onFlush = jest.fn().mockReturnValue(new Promise<void>((r) => { flushResolve = r; }));
    const ack1 = jest.fn();
    const ack2 = jest.fn();
    const c = new EventCoalescer(50, onFlush);

    c.add(upsert('ship-1'), ack1);
    c.add(upsert('ship-2'), ack2);

    // Start flush (timer fires) but don't resolve it yet
    jest.runAllTimers();

    // ACKs must not have been called while flush is still in progress
    expect(ack1).not.toHaveBeenCalled();
    expect(ack2).not.toHaveBeenCalled();

    flushResolve();
    await Promise.resolve(); // let microtasks settle

    expect(ack1).toHaveBeenCalledTimes(1);
    expect(ack2).toHaveBeenCalledTimes(1);
  });

  it('calls ack for superseded events too (DELETE win case)', async () => {
    const onFlush = jest.fn().mockResolvedValue(undefined);
    const ackUpsert = jest.fn();
    const ackDelete = jest.fn();
    const c = new EventCoalescer(50, onFlush);

    c.add(upsert('ship-1'), ackUpsert);  // will be superseded by DELETE
    c.add(del('ship-1'),    ackDelete);

    await jest.runAllTimersAsync();

    // Both LSNs must be ACKed even though only the DELETE event was flushed
    expect(ackUpsert).toHaveBeenCalledTimes(1);
    expect(ackDelete).toHaveBeenCalledTimes(1);
  });
});
