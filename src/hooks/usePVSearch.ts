import { useEffect, useState } from 'react';
import { searchPVs } from '../api/mole';
import { CanopyError } from '../api/client';

export type PVSearchStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface PVSearchResult {
  status: PVSearchStatus;
  pvs: string[];
  error?: { code: string; detail: string };
}

const EMPTY: PVSearchResult = { status: 'idle', pvs: [] };

export function usePVSearch(
  pattern: string,
  archiver: string | undefined,
  debounceMs = 300,
  limit = 50
): PVSearchResult {
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
          const wildcard =
            trimmed.includes('.') || trimmed.includes('*') ? trimmed : `.*${trimmed}.*`;
          const dto = await searchPVs(wildcard, { archiver, limit }, controller.signal);
          if (controller.signal.aborted) return;
          setResult({ status: 'ready', pvs: dto.pvs });
        } catch (err) {
          if ((err as { name?: string }).name === 'AbortError') return;
          const code = err instanceof CanopyError ? err.code : 'unknown_error';
          const detail = err instanceof CanopyError ? err.detail : (err as Error).message;
          setResult({ status: 'error', pvs: [], error: { code, detail } });
        }
      })();
    }, debounceMs);

    return () => {
      controller.abort();
      clearTimeout(handle);
    };
  }, [pattern, archiver, debounceMs, limit]);

  return result;
}
