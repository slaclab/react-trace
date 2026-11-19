import { useEffect, useState } from 'react';
import { errorInfo } from '../api/errorInfo';
import type { PvSearch } from './mole';

export type PVSearchStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface PVSearchResult {
  status: PVSearchStatus;
  pvs: string[];
  /**
   * The search returned `limit` names or more, so there may be others. Only
   * present when the caller passes a `limit`.
   */
  truncated?: boolean;
  error?: { code: string; detail: string };
}

export interface PVSearchOptions {
  /**
   * The cap the search applies (the Search PVs dialog's). A result of that many
   * names or more, counted before duplicates are dropped, reports `truncated`.
   */
  limit?: number;
  /**
   * Keep the previous matches listed while the next search with the same
   * `search` is in flight, so the list doesn't flash empty between keystrokes.
   * Off by default: the result then reads empty while a search runs.
   */
  keepPrevious?: boolean;
}

const EMPTY: PVSearchResult = { status: 'idle', pvs: [] };
const LOADING: PVSearchResult = { status: 'loading', pvs: [] };

// A result and the search it came from. Matches are reported only for that
// search: when a field or a dialog switches to another archiver (a new
// `search`), the user must not be shown, and act on, PVs that exist only on
// the previous one.
interface Stored {
  search: PvSearch;
  result: PVSearchResult;
}

/** `result` with its `truncated` flag when the caller passed a `limit`, as is otherwise. */
function shaped(result: PVSearchResult, limit: number | undefined, truncated = false) {
  return limit === undefined ? result : { ...result, truncated };
}

/**
 * `search` of `pattern`, debounced; idle while the pattern is blank. A pattern
 * that changes mid-flight aborts the request in flight. Each PV is listed once,
 * even when the archiver repeats it. A new `search` (another archiver) drops
 * the previous matches at once. The error carries the backend's code (the
 * SDK's and the local client's `CanopyError` both have one) or `unknown_error`.
 */
export function usePVSearch(
  pattern: string,
  search: PvSearch,
  debounceMs = 300,
  options: PVSearchOptions = {}
): PVSearchResult {
  const { limit, keepPrevious = false } = options;
  const [stored, setStored] = useState<Stored>(() => ({ search, result: shaped(EMPTY, limit) }));

  useEffect(() => {
    const trimmed = pattern.trim();
    if (trimmed.length < 1) {
      // Reset to empty when there's no query; already empty for this search,
      // keep the stored object so the field doesn't render again.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setStored((prev) =>
        prev.search === search && prev.result.status === 'idle'
          ? prev
          : { search, result: shaped(EMPTY, limit) }
      );
      return;
    }

    const controller = new AbortController();
    const handle = setTimeout(() => {
      setStored((prev) => {
        const pvs = keepPrevious && prev.search === search ? prev.result.pvs : [];
        return { search, result: shaped({ status: 'loading', pvs }, limit) };
      });
      void (async () => {
        try {
          const raw = await search(trimmed, controller.signal);
          if (controller.signal.aborted) return;
          // An appliance cluster can report the same PV once per appliance;
          // callers key rows by name, so list each PV once.
          const truncated = limit !== undefined && raw.length >= limit;
          setStored({
            search,
            result: shaped({ status: 'ready', pvs: [...new Set(raw)] }, limit, truncated),
          });
        } catch (err) {
          if (controller.signal.aborted || (err as { name?: string }).name === 'AbortError') return;
          const { code, detail } = errorInfo(err);
          const result: PVSearchResult = { status: 'error', pvs: [], error: { code, detail } };
          setStored({ search, result: shaped(result, limit) });
        }
      })();
    }, debounceMs);

    return () => {
      controller.abort();
      clearTimeout(handle);
    };
  }, [pattern, search, debounceMs, limit, keepPrevious]);

  // A blank pattern has nothing to show, even before the effect above resets.
  if (pattern.trim().length < 1) return shaped(EMPTY, limit);
  // Until the effect above has run for a new search, the stored matches
  // belong to the previous one: report an empty search in flight.
  if (stored.search !== search && stored.result.status !== 'idle') return shaped(LOADING, limit);
  return stored.result;
}
