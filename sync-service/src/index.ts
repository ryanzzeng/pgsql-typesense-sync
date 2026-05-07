import './config'; // validates env vars before anything else

import express, { Request, Response, NextFunction } from 'express';
import { LogicalReplicationService, PgoutputPlugin } from 'pg-logical-replication';
import { pool, ensureReplicationSlot } from './db';
import { ensureCollection } from './typesenseClient';
import { runInitialSync } from './initialSync';
import { handleEvent } from './eventHandler';
import { walMessageToSyncEvent } from './walHandler';
import { EventCoalescer } from './coalescer';
import { registerGracefulShutdown } from './gracefulShutdown';
import logger from './logger';
import api from './api';
import config from './config';

async function startReplication(
  service: LogicalReplicationService,
  getStopping: () => boolean,
): Promise<void> {
  const plugin = new PgoutputPlugin({
    protoVersion:     1,
    publicationNames: [config.replication.publicationName],
  });

  while (!getStopping()) {
    try {
      logger.info('starting replication stream');
      await service.subscribe(plugin, config.replication.slotName);
    } catch (err: unknown) {
      if (getStopping()) break;
      logger.error({ err: (err as Error).message }, 'replication stream ended — reconnecting in 5s');
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

async function main(): Promise<void> {
  logger.info('startup: config validated');

  await ensureCollection();
  await ensureReplicationSlot();
  await runInitialSync();

  const replService = new LogicalReplicationService(
    {
      host:     config.postgres.host,
      port:     config.postgres.port,
      database: config.postgres.database,
      user:     config.postgres.user,
      password: config.postgres.password,
    },
    { acknowledge: { auto: false, timeoutSeconds: 10 } },
  );

  let stopping = false;
  let inFlight = 0;
  let drainResolve: (() => void) | null = null;

  const coalescer = new EventCoalescer(
    config.coalesceWindowMs,
    async (events) => {
      await Promise.allSettled(events.map((e) => handleEvent(e)));
    },
  );

  replService.on('data', (lsn: string, log: unknown) => {
    // Always acknowledge the LSN immediately to keep the slot advancing.
    // At-least-once delivery is guaranteed by the startup backfill if the service restarts.
    const ack = (): void => {
      replService.acknowledge(lsn).catch((err: Error) =>
        logger.error({ err: err.message }, 'ack error'),
      );
    };

    if (stopping) { ack(); return; }

    inFlight++;
    const event = walMessageToSyncEvent(log);
    if (event) coalescer.add(event);

    Promise.resolve()
      .then(() => { ack(); })
      .finally(() => {
        inFlight--;
        if (inFlight === 0 && drainResolve) drainResolve();
      });
  });

  replService.on('error', (err: Error) => {
    logger.error({ err: err.message }, 'replication client error');
  });

  startReplication(replService, () => stopping).catch((err: Error) => {
    logger.error({ err: err.message }, 'replication fatal error');
    process.exit(1);
  });

  registerGracefulShutdown(async () => {
    stopping = true;
    replService.stop();

    if (inFlight > 0) {
      logger.info({ inFlight }, 'waiting for in-flight acks to drain');
      await new Promise<void>((resolve) => { drainResolve = resolve; });
    }

    await coalescer.drain();
    await pool.end();
    logger.info('db pool closed — shutdown complete');
  });

  const app = express();
  app.use(express.json());
  app.use('/', api);

  app.use((err: Error & { httpStatus?: number }, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.httpStatus ?? 500;
    logger.error({ err: err.message, status, requestId: res.locals.requestId as string }, 'api error');
    res.status(status).json({ error: err.message });
  });

  app.listen(config.port, () => {
    logger.info({ port: config.port }, 'api server listening');
  });
}

main().catch((err: Error) => {
  logger.error({ err: err.message }, 'startup fatal error');
  process.exit(1);
});
