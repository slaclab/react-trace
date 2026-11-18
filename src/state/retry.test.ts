import { describe, expect, it } from 'vitest';
import * as archive from './archiveStore';
import * as formula from './formulaStore';
import { RETRY_DELAYS_MS, retryDelayMs } from './retry';

describe('retryDelayMs', () => {
  it('steps through the schedule, one step per consecutive failure', () => {
    expect([1, 2, 3, 4, 5].map(retryDelayMs)).toEqual([1_000, 2_000, 4_000, 8_000, 15_000]);
  });

  it('repeats the last step', () => {
    expect(retryDelayMs(6)).toBe(15_000);
    expect(retryDelayMs(100)).toBe(15_000);
  });

  it('counts anything below one attempt as the first', () => {
    expect(retryDelayMs(0)).toBe(1_000);
    expect(retryDelayMs(-3)).toBe(1_000);
  });

  it('is the schedule the archive and formula stores retry on', () => {
    expect(archive.RETRY_DELAYS_MS).toBe(RETRY_DELAYS_MS);
    expect(archive.retryDelayMs).toBe(retryDelayMs);
    expect(formula.RETRY_DELAYS_MS).toBe(RETRY_DELAYS_MS);
    expect(formula.retryDelayMs).toBe(retryDelayMs);
  });
});
