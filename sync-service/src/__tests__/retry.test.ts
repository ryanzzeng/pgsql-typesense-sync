import { withRetry } from '../retry';

jest.mock('../logger');

// mock config has maxAttempts=3, initialDelayMs=10 — fast enough for real timers

describe('withRetry', () => {
  afterEach(() => jest.clearAllMocks());

  it('returns the result immediately when the operation succeeds', async () => {
    const fn = jest.fn().mockResolvedValue('ok');
    expect(await withRetry(fn)).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on failure and returns the result on a later attempt', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue('recovered');
    expect(await withRetry(fn)).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws the last error after all attempts are exhausted', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('permanent'));
    await expect(withRetry(fn)).rejects.toThrow('permanent');
    expect(fn).toHaveBeenCalledTimes(3); // maxAttempts=3 from mock config
  });

  it('passes context to the logger on each failed attempt', async () => {
    const { default: logger } = await import('../logger');
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValue('ok');

    await withRetry(fn, { shipmentId: 'ship-1' });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ shipmentId: 'ship-1', attempt: 1 }),
      'retrying after failure',
    );
  });
});
