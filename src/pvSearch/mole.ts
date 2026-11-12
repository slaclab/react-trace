// The archiver half of PV search: Mole's index through the SDK client,
// `GET /mole/v1/search` under the page's base (api/connection.ts),
// so it works behind a prefixed gateway path and with a per-trace archiver.
// Mole still contributes archived-only PVs that the channel catalog does not
// list.

import { searchPVs } from '@slaclab/canopy-client';
import { canopyConnection } from '../api/connection';

/**
 * The PV-name search behind every PV field (components/PvCombo.tsx): PV names
 * matching the user's text, best first; rejects on a failed search. One
 * signature, so a page can inject its own (tests do).
 */
export type PvSearch = (pattern: string, signal?: AbortSignal) => Promise<string[]>;

/** Mole's cap on one search; the catalog adds its own matches ahead of these. */
export const MOLE_SEARCH_LIMIT = 50;

/**
 * Mole's search is an anchored regex (the pattern must match the whole name),
 * so a plain fragment is wrapped as `.*x.*`; one that already has `.` or `*`
 * is the user's own pattern and passes as is.
 */
export function moleSearchPattern(text: string): string {
  const trimmed = text.trim();
  return trimmed.includes('.') || trimmed.includes('*') ? trimmed : `.*${trimmed}.*`;
}

/** A search of `archiver`'s index (the default archiver when unset). */
export function moleSearch(options: { archiver?: string; limit?: number } = {}): PvSearch {
  const { archiver, limit = MOLE_SEARCH_LIMIT } = options;
  return async (pattern, signal) => {
    const result = await searchPVs(
      canopyConnection,
      moleSearchPattern(pattern),
      { archiver, limit },
      signal
    );
    return result.pvs;
  };
}
