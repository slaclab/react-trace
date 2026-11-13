import { useEffect, useState } from 'react';
import { searchPVs } from '@slaclab/canopy-client';
import { useCanopyConnection } from '@slaclab/canopy-react';
import { errorInfo } from '../api/errorInfo';

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
  const conn = useCanopyConnection();
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
          const dto = await searchPVs(conn, wildcard, { archiver, limit }, controller.signal);
          if (controller.signal.aborted) return;
          setResult({ status: 'ready', pvs: dto.pvs });
        } catch (err) {
          if ((err as { name?: string }).name === 'AbortError') return;
          const { code, detail } = errorInfo(err);
          setResult({ status: 'error', pvs: [], error: { code, detail } });
        }
      })();
    }, debounceMs);

    return () => {
      controller.abort();
      clearTimeout(handle);
    };
  }, [conn, pattern, archiver, debounceMs, limit]);

  return result;
}
