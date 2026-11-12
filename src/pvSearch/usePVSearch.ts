import { useEffect, useState } from 'react';
import type { PvSearch } from './mole';

export type PVSearchStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface PVSearchResult {
  status: PVSearchStatus;
  pvs: string[];
  error?: { code: string; detail: string };
}

const EMPTY: PVSearchResult = { status: 'idle', pvs: [] };

/**
 * `search` of `pattern`, debounced; idle while the pattern is blank. A pattern
 * that changes mid-flight aborts the request in flight. The error carries the
 * backend's code (the SDK's and the local client's `CanopyError` both have
 * one) or `unknown_error`.
 */
export function usePVSearch(pattern: string, search: PvSearch, debounceMs = 300): PVSearchResult {
  const [result, setResult] = useState<PVSearchResult>(EMPTY);

  useEffect(() => {
    const trimmed = pattern.trim();
    if (trimmed.length < 1) {
      // Reset to empty when there's no query.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setResult(EMPTY);
      return;
    }

    const controller = new AbortController();
    const handle = setTimeout(() => {
      setResult({ status: 'loading', pvs: [] });
      void (async () => {
        try {
          const pvs = await search(trimmed, controller.signal);
          if (controller.signal.aborted) return;
          setResult({ status: 'ready', pvs });
        } catch (err) {
          if (controller.signal.aborted || (err as { name?: string }).name === 'AbortError') return;
          const { code, detail, message } = err as {
            code?: unknown;
            detail?: unknown;
            message?: unknown;
          };
          setResult({
            status: 'error',
            pvs: [],
            error: {
              code: typeof code === 'string' ? code : 'unknown_error',
              detail: typeof detail === 'string' ? detail : String(message ?? err),
            },
          });
        }
      })();
    }, debounceMs);

    return () => {
      controller.abort();
      clearTimeout(handle);
    };
  }, [pattern, search, debounceMs]);

  return result;
}
