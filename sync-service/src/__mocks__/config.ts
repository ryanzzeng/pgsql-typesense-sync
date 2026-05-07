// Shared mock config used by all unit tests — avoids loading real env vars
const config = {
  postgres:    { host: 'localhost', port: 5432, database: 'test', user: 'test', password: 'test' },
  typesense:   { host: 'localhost', port: 8108, apiKey: 'test-key', searchApiKey: 'test-key', collection: 'shipments' },
  replication: { slotName: 'sync_slot', publicationName: 'sync_pub' },
  retry:       { maxAttempts: 3, initialDelayMs: 10, maxDelayMs: 100 },
  port:             3000,
  syncBatchSize:    100,
  logLevel:         'silent',
  apiKey:           undefined,
  coalesceWindowMs: 50,
};

export default config;
