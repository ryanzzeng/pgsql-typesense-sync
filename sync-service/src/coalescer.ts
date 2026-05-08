import { SyncEvent } from './types';
import logger from './logger';

interface BufferedEntry {
  event: SyncEvent;
  acks:  Array<() => void>;
}

export class EventCoalescer {
  private readonly buffer = new Map<string, BufferedEntry>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> | null = null;
  private readonly windowMs: number;
  private readonly onFlush: (events: SyncEvent[]) => Promise<void>;

  constructor(windowMs: number, onFlush: (events: SyncEvent[]) => Promise<void>) {
    this.windowMs = windowMs;
    this.onFlush = onFlush;
  }

  add(event: SyncEvent, ack: () => void): void {
    const existing = this.buffer.get(event.id);
    if (existing) {
      existing.acks.push(ack);
      // A shipment DELETE supersedes any pending upsert — collect the ack but keep DELETE
      if (existing.event.operation === 'DELETE' && existing.event.table === 'shipments') return;
      existing.event = event;
    } else {
      this.buffer.set(event.id, { event, acks: [ack] });
    }
    if (!this.timer) {
      this.timer = setTimeout(() => { void this.flush(); }, this.windowMs);
    }
  }

  async flush(): Promise<void> {
    // Prevent concurrent flushes: if one is already running, wait for it then return
    if (this.flushing) {
      await this.flushing;
      return;
    }

    this.timer = null;
    if (this.buffer.size === 0) return;

    const entries = [...this.buffer.values()];
    this.buffer.clear();

    const events = entries.map((e) => e.event);
    logger.debug({ count: events.length }, 'coalescer flush');

    this.flushing = this.onFlush(events)
      .then(() => {
        // ACK every WAL LSN in this batch only after Typesense writes succeed
        for (const { acks } of entries) {
          for (const ack of acks) ack();
        }
      })
      .finally(() => {
        this.flushing = null;
      });

    await this.flushing;
  }

  // Flush immediately — called during graceful shutdown to drain buffered events
  async drain(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.flush();
  }
}
