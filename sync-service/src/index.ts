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

  const coalescer = new EventCoalescer(
    config.coalesceWindowMs,
    async (events) => {
      await Promise.allSettled(events.map((e) => handleEvent(e)));
    },
  );

  replService.on('data', (lsn: string, log: unknown) => {
    const ack = (): void => {
      replService.acknowledge(lsn).catch((err: Error) =>
        logger.error({ err: err.message }, 'ack error'),
      );
    };

    // When stopping, drain in-flight items but don't queue new work
    if (stopping) { ack(); return; }

    const event = walMessageToSyncEvent(log);
    if (event) {
      // Data events: ACK is deferred until after the Typesense write succeeds inside the coalescer flush.
      // This gives true at-least-once delivery — if the process dies before the write completes,
      // the replication slot replays from the last acknowledged LSN on the next startup.
      coalescer.add(event, ack);
    } else {
      // Non-data WAL messages (begin, commit, relation, keepalive): ACK immediately.
      // These carry no data we need to sync; advancing past them is safe.
      ack();
    }
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

    // drain() flushes any buffered events, completes Typesense writes, then calls their ACKs.
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
