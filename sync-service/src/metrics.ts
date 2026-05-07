import { register, Counter, Histogram, Gauge } from 'prom-client';

export const syncEventsTotal = new Counter({
  name:       'sync_events_total',
  help:       'Total WAL events processed, by operation and status',
  labelNames: ['operation', 'status'] as const,
});

export const syncDeadLetterTotal = new Counter({
  name: 'sync_dead_letter_total',
  help: 'Total events written to the dead-letter table',
});

export const syncTypesenseRequestDuration = new Histogram({
  name:    'sync_typesense_request_duration_seconds',
  help:    'Typesense API call latency',
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
});

export const syncLastEventTimestamp = new Gauge({
  name: 'sync_last_event_timestamp',
  help: 'Unix timestamp of the last successfully processed WAL event',
});

let _lastEventTs = 0;

export function recordEvent(operation: string, success: boolean): void {
  syncEventsTotal.inc({ operation: operation.toLowerCase(), status: success ? 'success' : 'failed' });
}

export function recordLastEvent(): void {
  _lastEventTs = Math.floor(Date.now() / 1000);
  syncLastEventTimestamp.set(_lastEventTs);
}

export function getLastEventTs(): number {
  return _lastEventTs;
}

export { register };
