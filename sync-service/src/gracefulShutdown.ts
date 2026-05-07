import logger from './logger';

const DRAIN_TIMEOUT_MS = 30_000;

export function registerGracefulShutdown(cleanup: () => Promise<void>): void {
  let stopping = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'shutdown signal received — draining in-flight events');

    const timer = new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error('graceful shutdown timed out after 30s')), DRAIN_TIMEOUT_MS),
    );

    try {
      await Promise.race([cleanup(), timer]);
      logger.info('graceful shutdown complete');
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'error during graceful shutdown');
    }

    process.exit(0);
  };

  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT',  () => { void shutdown('SIGINT'); });
}
