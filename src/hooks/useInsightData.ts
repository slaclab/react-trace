import { useCallback, useEffect, useState } from 'react';
import { fetchData, fetchMetadata } from '../api/mole';
import { CanopyError } from '../api/client';
import type { AlarmSeverity, ArchiverDataDTO } from '../api/types';
import type { TimeWindowNs } from '../api/time';

export interface InsightRow {
  tsNs: number;
  value: number | string | boolean | null;
  severity: AlarmSeverity | '';
  source: 'Archive' | 'Live';
}

export interface InsightMeta {
  pv: string;
  units: string | null;
  description: string | null;
}

export type InsightStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface InsightData {
  rows: InsightRow[];
  meta: InsightMeta | null;
  status: InsightStatus;
  error?: string;
  // True when the archiver decimated the raw result (too many points for the
  // window). The table then shows representative rather than every sample.
  decimated: boolean;
  refetch: () => void;
}

function toRows(data: ArchiverDataDTO): InsightRow[] {
  if (data.mode === 'raw') {
    return data.samples.map((s) => ({
      tsNs: s.tsNs,
      value: s.value,
      severity: s.severity,
      source: 'Archive' as const,
    }));
  }
  // Binned fallback — shouldn't occur without a binning param, but stay safe.
  return data.points.map((p) => ({
    tsNs: p.tsNs,
    value: p.mean,
    severity: p.severity,
    source: 'Archive' as const,
  }));
}

/**
 * Fetches raw archive samples (+ unit/description metadata) for a single PV over
 * a time window — the data layer for the Data Insight Tool. Omits binning so the
 * archiver returns un-optimized samples (matching the Python DIT). Live-sample
 * merging is intentionally out of v1 (see docs/data-insight-tool.md).
 */
export function useInsightData(
  pv: string | undefined,
  archiver: string | undefined,
  window: TimeWindowNs | undefined
): InsightData {
  const [rows, setRows] = useState<InsightRow[]>([]);
  const [meta, setMeta] = useState<InsightMeta | null>(null);
  const [status, setStatus] = useState<InsightStatus>('idle');
  const [error, setError] = useState<string>();
  const [decimated, setDecimated] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const refetch = useCallback(() => setRefreshKey((k) => k + 1), []);

  const fromNs = window?.fromNs;
  const toNs = window?.toNs;

  useEffect(() => {
    // Synchronous status/reset transitions before the async fetch are the
    // standard data-fetching pattern; the cascading-render guard doesn't apply.
    /* eslint-disable react-hooks/set-state-in-effect */
    if (!pv || fromNs === undefined) {
      setStatus('idle');
      setRows([]);
      setMeta(null);
      return;
    }
    const controller = new AbortController();
    setStatus('loading');
    setError(undefined);
    /* eslint-enable react-hooks/set-state-in-effect */

    void (async () => {
      try {
        const [data, metadata] = await Promise.all([
          fetchData(pv, { fromNs, toNs, archiver }, controller.signal),
          // Metadata is best-effort; a missing/erroring metadata endpoint
          // shouldn't fail the whole table.
          fetchMetadata(pv, archiver, controller.signal).catch(() => null),
        ]);
        if (controller.signal.aborted) return;
        setRows(toRows(data));
        setDecimated(data.mode === 'raw' ? data.decimated : false);
        setMeta({ pv, units: metadata?.units ?? null, description: metadata?.description ?? null });
        setStatus('ready');
      } catch (err) {
        if ((err as { name?: string }).name === 'AbortError') return;
        setError(err instanceof CanopyError ? err.detail : (err as Error).message);
        setStatus('error');
      }
    })();

    return () => controller.abort();
  }, [pv, archiver, fromNs, toNs, refreshKey]);

  return { rows, meta, status, error, decimated, refetch };
}
