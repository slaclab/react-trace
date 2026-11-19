// Retry schedule for transient failures in the archive and formula stores and
// the Data Insight Tool's fetch; the last step repeats. Matches the live
// connection's reconnect backoff (canopy-client's default).
export const RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 15_000];

// The wait before retrying after `attempts` consecutive failures (1 for the
// first; anything lower counts as 1).
export function retryDelayMs(attempts: number): number {
  return RETRY_DELAYS_MS[Math.min(Math.max(attempts, 1), RETRY_DELAYS_MS.length) - 1];
}
