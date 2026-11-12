/**
 * Archive error codes that mean the archiver does not hold the PV, as opposed
 * to "the archive could not be asked" (down, timed out, auth):
 *
 * - `pv_not_found_in_archiver`: Mole's 404 for a PV its archiver does not hold;
 * - `pv_not_found`: the PV is not archived at all;
 * - `archiver_not_configured`: no archiver is configured for the PV.
 *
 * Such a failure belongs to the (PV, archiver) pair, not to the time window,
 * so the archive store remembers it instead of retrying. Every consumer (the
 * store, the plot's notice, the curve's row and Archive status) reads this
 * one table, so a code the backend adds lands everywhere at once.
 */
const NOT_ARCHIVED_NOTICES: Readonly<Record<string, string>> = {
  pv_not_found_in_archiver: 'Not archived',
  pv_not_found: 'Not archived',
  archiver_not_configured: 'No archiver',
};

export const NOT_ARCHIVED_CODES: ReadonlySet<string> = new Set(Object.keys(NOT_ARCHIVED_NOTICES));

/** What the UI says for a PV the archiver does not hold, by code; none for any other code. */
export function archiveErrorNotice(code: string | undefined): string | undefined {
  return code !== undefined && Object.hasOwn(NOT_ARCHIVED_NOTICES, code)
    ? NOT_ARCHIVED_NOTICES[code]
    : undefined;
}
