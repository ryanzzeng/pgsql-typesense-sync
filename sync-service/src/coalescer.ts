import { SyncEvent } from './types';
import logger from './logger';

export class EventCoalescer {
  private readonly buffer = new Map<string, SyncEvent>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly windowMs: number;
  private readonly onFlush: (events: SyncEvent[]) => Promise<void>;

  constructor(windowMs: number, onFlush: (events: SyncEvent[]) => Promise<void>) {
    this.windowMs = windowMs;
    this.onFlush = onFlush;
  }

  add(event: SyncEvent): void {
    const existing = this.buffer.get(event.id);
    // A shipment DELETE supersedes any pending upsert for the same ID — once deleted, no point upserting
    if (existing?.operation === 'DELETE' && existing.table === 'shipments') return;
    this.buffer.set(event.id, event);
    if (!this.timer) {
      this.timer = setTimeout(() => { void this.flush(); }, this.windowMs);
    }
  }

  async flush(): Promise<void> {
    this.timer = null;
    if (this.buffer.size === 0) return;
    const events = [...this.buffer.values()];
    this.buffer.clear();
    logger.debug({ count: events.length }, 'coalescer flush');
    await this.onFlush(events);
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
