import { Router, Request, Response, NextFunction } from 'express';
import type { SearchParams } from 'typesense/lib/Typesense/Documents';
import rateLimit from 'express-rate-limit';
import { client as tsClient } from './typesenseClient';
import { pool } from './db';
import { register, getLastEventTs } from './metrics';
import config from './config';

const router = Router();

const limiter = rateLimit({ windowMs: 60_000, max: 100, standardHeaders: true, legacyHeaders: false });
router.use(limiter);

router.get('/health', async (_req: Request, res: Response) => {
  const pgOk  = await pool.query('SELECT 1').then(() => true).catch(() => false);
  const tsOk  = await tsClient.health.retrieve().then(() => true).catch(() => false);
  const lastTs = getLastEventTs();

  res.status(pgOk && tsOk ? 200 : 503).json({
    status:        pgOk && tsOk ? 'ok' : 'degraded',
    postgres:      pgOk  ? 'connected' : 'error',
    typesense:     tsOk  ? 'connected' : 'error',
    last_event_at: lastTs > 0 ? new Date(lastTs * 1000).toISOString() : null,
  });
});

router.get('/metrics', async (_req: Request, res: Response) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

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

    const result = await tsClient
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
    const doc = await tsClient
      .collections(config.typesense.collection)
      .documents(req.params.id)
      .retrieve();
    res.json(doc);
  } catch (err) {
    next(err);
  }
});

export default router;
