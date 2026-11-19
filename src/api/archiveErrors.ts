/**
 * The archive error codes the UI knows, what it calls each, and how the
 * archive store retries it. Every consumer (the store, the plot's notice, the
 * curve's row and its Status lines) reads these tables, so a code the backend
 * adds lands everywhere at once.
 *
 * Two codes mean the archiver does not hold the PV, as opposed to "the archive
 * could not be asked" (down, timed out, auth). Such a failure belongs to the
 * (PV, archiver) pair, not to the time window, so the store remembers it
 * instead of retrying:
 *
 * - `archiver_not_configured`: no archiver is configured for the PV. It comes
 *   from Canopy's archiver registry, which only changes when Canopy restarts,
 *   so it is never asked again by itself (`never`).
 * - `pv_not_found_in_archiver`: Mole's answer for a PV its archiver does not
 *   hold. Canopy also raises it for other Appliance 400/404s, so it is asked
 *   again when the time range's span or the archiver changes (`onChange`).
 *
 * Every other code is retried on the shared backoff schedule (`backoff`).
 */
const NOT_ARCHIVED_NOTICES: Readonly<Record<string, string>> = {
  pv_not_found_in_archiver: 'Not archived',
  archiver_not_configured: 'No archiver',
};

/**
 * Short names for archive error codes, as the Layers rows used to show them.
 * A code missing here has none; callers fall back to the code itself.
 */
const ARCHIVE_ERROR_LABELS: Readonly<Record<string, string>> = {
  archiver_unavailable: 'Archiver down',
  archiver_timeout: 'Timeout',
  archiver_bad_response: 'Bad response',
  invalid_api_key: 'Auth error',
  insufficient_read_access: 'Auth error',
  network_error: 'Offline',
  ...NOT_ARCHIVED_NOTICES,
};

export const NOT_ARCHIVED_CODES: ReadonlySet<string> = new Set(Object.keys(NOT_ARCHIVED_NOTICES));

/** How the archive store asks again after a failure with this code. */
export type ArchiveRetry = 'never' | 'onChange' | 'backoff';

const ARCHIVE_RETRY: Readonly<Record<string, ArchiveRetry>> = {
  archiver_not_configured: 'never',
  pv_not_found_in_archiver: 'onChange',
};

function lookup<V>(table: Readonly<Record<string, V>>, code: string | undefined): V | undefined {
  return code !== undefined && Object.hasOwn(table, code) ? table[code] : undefined;
}

/** What the UI says for a PV the archiver does not hold, by code; none for any other code. */
export function archiveErrorNotice(code: string | undefined): string | undefined {
  return lookup(NOT_ARCHIVED_NOTICES, code);
}

/** The short name of an archive error code ("Archiver down", "Timeout"…); none for an unknown code. */
export function archiveErrorLabel(code: string | undefined): string | undefined {
  return lookup(ARCHIVE_ERROR_LABELS, code);
}

/** How a failure with `code` is asked again: never, on a span or archiver change, or on backoff. */
export function archiveRetry(code: string | undefined): ArchiveRetry {
  return lookup(ARCHIVE_RETRY, code) ?? 'backoff';
}
