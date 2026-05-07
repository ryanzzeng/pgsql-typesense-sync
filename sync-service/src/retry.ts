import logger from './logger';
import config from './config';

export async function withRetry<T>(
  fn: () => Promise<T>,
  context: Record<string, unknown> = {},
): Promise<T> {
  const { maxAttempts, initialDelayMs, maxDelayMs } = config.retry;
  let lastErr!: Error;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err as Error;
      if (attempt === maxAttempts) break;
      // Exponential backoff with full jitter
      const base = Math.min(initialDelayMs * 2 ** (attempt - 1), maxDelayMs);
      const delay = Math.random() * base;
      logger.warn({ ...context, attempt, nextDelayMs: Math.round(delay), err: lastErr.message }, 'retrying after failure');
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  throw lastErr;
}
