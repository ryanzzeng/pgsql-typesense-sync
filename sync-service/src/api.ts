import { randomUUID } from 'crypto';
import { Router, Request, Response, NextFunction } from 'express';
import type { SearchParams } from 'typesense/lib/Typesense/Documents';
import rateLimit from 'express-rate-limit';
import { searchClient } from './typesenseClient';
import { pool } from './db';
import { register, getLastEventTs } from './metrics';
import { upsertShipment, deleteShipment } from './sync';
import logger from './logger';
import config from './config';

const router = Router();

// ─── Correlation ID + access logging ─────────────────────────────────────────
// Assigns a requestId to every request, echoes it in the response header,
// and emits one structured log line per response (method, path, status, ms).
router.use((req: Request, res: Response, next: NextFunction) => {
  const id = (req.headers['x-request-id'] as string | undefined) ?? randomUUID();
  res.setHeader('x-request-id', id);
  res.locals.requestId = id;
  const startMs = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - startMs;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    logger[level](
      { method: req.method, path: req.path, status: res.statusCode, ms, requestId: id },
      'request',
    );
  });
  next();
});

// ─── Rate limiting ────────────────────────────────────────────────────────────
const limiter = rateLimit({ windowMs: 60_000, max: 100, standardHeaders: true, legacyHeaders: false });
router.use(limiter);

// ─── Optional API key auth ────────────────────────────────────────────────────
// Enabled only when API_KEY env var is set. All routes below this middleware are protected.
// /health and /metrics are intentionally excluded (checked before this middleware fires).
router.use('/shipments', (req: Request, res: Response, next: NextFunction): void => {
  if (!config.apiKey) { next(); return; }
  if (req.headers['x-api-key'] === config.apiKey) { next(); return; }
  res.status(401).json({ error: 'Unauthorized' });
});

router.use('/admin', (req: Request, res: Response, next: NextFunction): void => {
  if (!config.apiKey) { next(); return; }
  if (req.headers['x-api-key'] === config.apiKey) { next(); return; }
  res.status(401).json({ error: 'Unauthorized' });
});

// ─── Health (cached) ──────────────────────────────────────────────────────────
interface HealthResult { status: string; postgres: string; typesense: string; last_event_at: string | null }
let healthCache: { result: HealthResult; ts: number } | null = null;
const HEALTH_TTL_MS = 5_000;

router.get('/health', async (_req: Request, res: Response) => {
  const now = Date.now();
  if (!healthCache || now - healthCache.ts > HEALTH_TTL_MS) {
    const pgOk = await pool.query('SELECT 1').then(() => true).catch(() => false);
    const tsOk = await searchClient.health.retrieve().then(() => true).catch(() => false);
    const lastTs = getLastEventTs();
    healthCache = {
      result: {
        status:        pgOk && tsOk ? 'ok' : 'degraded',
        postgres:      pgOk ? 'connected' : 'error',
        typesense:     tsOk ? 'connected' : 'error',
        last_event_at: lastTs > 0 ? new Date(lastTs * 1000).toISOString() : null,
      },
      ts: now,
    };
  }
  const { result } = healthCache;
  res.status(result.status === 'ok' ? 200 : 503).json(result);
});

// ─── Metrics ──────────────────────────────────────────────────────────────────
router.get('/metrics', async (_req: Request, res: Response) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

// ─── Search ───────────────────────────────────────────────────────────────────
router.get('/shipments', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const {
      q         = '*',
      filter_by = '',
      sort_by   = 'estimated_arrival:asc',
      page      = '1',
      per_page  = '20',
    } = req.query as Record<string, string>;

    const perPage = Math.min(parseInt(per_page, 10), 100);

    const searchParams: SearchParams = {
      q,
      query_by: 'tracking_number,status,carrier,origin_port,destination_port,cargo_descriptions',
      sort_by,
      page:     parseInt(page, 10),
      per_page: perPage,
      ...(filter_by ? { filter_by } : {}),
    };

    const result = await searchClient
      .collections(config.typesense.collection)
      .documents()
      .search(searchParams);

    res.json({
      total:    result.found,
      page:     result.page,
      per_page: perPage,
      hits:     result.hits?.map((h) => h.document) ?? [],
    });
  } catch (err) {
    next(err);
  }
});

router.get('/shipments/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const doc = await searchClient
      .collections(config.typesense.collection)
      .documents(req.params.id)
      .retrieve();
    res.json(doc);
  } catch (err) {
    next(err);
  }
});

// ─── Dead-letter replay ───────────────────────────────────────────────────────
router.post('/admin/replay', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { rows } = await pool.query<{
      id: string; table_name: string; operation: string; record_id: string;
    }>(`SELECT id, table_name, operation, record_id
        FROM sync_dead_letter
        WHERE resolved_at IS NULL
        ORDER BY created_at
        LIMIT 100`);

    let replayed = 0;
    let failed   = 0;

    for (const row of rows) {
      try {
        if (row.operation === 'DELETE' && row.table_name === 'shipments') {
          await deleteShipment(row.record_id);
        } else {
          await upsertShipment(row.record_id);
        }
        await pool.query(
          `UPDATE sync_dead_letter SET resolved_at = now() WHERE id = $1`,
          [row.id],
        );
        replayed++;
        logger.info({ id: row.id, recordId: row.record_id }, 'dead-letter event replayed');
      } catch (err) {
        failed++;
        logger.error({ id: row.id, recordId: row.record_id, err: (err as Error).message }, 'dead-letter replay failed');
      }
    }

    res.json({ total: rows.length, replayed, failed });
  } catch (err) {
    next(err);
  }
});

export default router;
