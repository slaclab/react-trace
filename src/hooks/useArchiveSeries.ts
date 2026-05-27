import { useEffect, useState } from 'react';
import { fetchData } from '../api/mole';
import { CanopyError } from '../api/client';
import type { ArchiverDataDTO, BinnedPointDTO, SampleDTO } from '../api/types';
import { rangeToWindowNs, nsToMs } from '../api/time';
import type { PVTrace } from '../types';

export const DEFAULT_OPTIMIZED_BINS = 5000;

export type ArchiveSeriesStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface ArchivePlotPoint {
  time: number;
  value: number;
}

export interface ArchiveBandPoint {
  time: number;
  min: number;
  max: number;
}

export interface ArchiveSeriesResult {
  status: ArchiveSeriesStatus;
  mode?: 'raw' | 'binned';
  mean: ArchivePlotPoint[];
  band: ArchiveBandPoint[];
  decimated?: boolean;
  archiver?: string;
  error?: { code: string; detail: string };
}

const EMPTY_RESULT: ArchiveSeriesResult = { status: 'idle', mean: [], band: [] };

function keyOf(trace: PVTrace, archiver: string | undefined, bins: number): string {
  return JSON.stringify({
    pv: trace.pvName,
    range: trace.archiveTimeRange,
    archiver: archiver ?? null,
    bins,
  });
}

function pickArchiver(trace: PVTrace, globalArchiver: string | undefined): string | undefined {
  return trace.archiver ?? globalArchiver;
}

function pickBins(trace: PVTrace): number {
  return trace.optimizedDataBins && trace.optimizedDataBins > 0
    ? trace.optimizedDataBins
    : DEFAULT_OPTIMIZED_BINS;
}

function dtoToResult(dto: ArchiverDataDTO): ArchiveSeriesResult {
  if (dto.mode === 'raw') {
    const mean = dto.samples
      .filter((s: SampleDTO) => typeof s.value === 'number')
      .map((s: SampleDTO) => ({ time: nsToMs(s.tsNs), value: s.value as number }));
    return {
      status: 'ready',
      mode: 'raw',
      mean,
      band: [],
      decimated: dto.decimated,
      archiver: dto.archiver,
    };
  }
  const mean: ArchivePlotPoint[] = [];
  const band: ArchiveBandPoint[] = [];
  for (const p of dto.points as BinnedPointDTO[]) {
    const t = nsToMs(p.tsNs);
    mean.push({ time: t, value: p.mean });
    band.push({ time: t, min: p.min, max: p.max });
  }
  return { status: 'ready', mode: 'binned', mean, band, archiver: dto.archiver };
}

export function useArchiveSeries(
  traces: PVTrace[],
  globalArchiver: string | undefined
): Map<string, ArchiveSeriesResult> {
  const [results, setResults] = useState<Map<string, ArchiveSeriesResult>>(() => new Map());

  // Build a stable signature of the inputs that should trigger a refetch.
  // Touching this string on any trace's archive-relevant field re-runs the effect.
  const signature = traces
    .map((t) => {
      if (!t.useArchive) return `${t.id}:off`;
      const archiver = pickArchiver(t, globalArchiver);
      const bins = pickBins(t);
      return `${t.id}:${keyOf(t, archiver, bins)}`;
    })
    .join('|');

  useEffect(() => {
    const controller = new AbortController();

    const archiveTraces = traces.filter((t) => t.useArchive);

    // Drop stale entries and mark active ones as loading; this is a synchronization
    // step at the start of a fetch cycle, exactly the case React allows setState in
    // an effect for. The lint rule flags it generically.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setResults((prev) => {
      const next = new Map(prev);
      const wanted = new Set(archiveTraces.map((t) => t.id));
      for (const id of next.keys()) {
        if (!wanted.has(id)) next.delete(id);
      }
      // Mark every active archive trace as loading at the start of the fetch cycle.
      for (const t of archiveTraces) {
        const cur = next.get(t.id);
        next.set(t.id, {
          status: 'loading',
          mean: cur?.mean ?? [],
          band: cur?.band ?? [],
          mode: cur?.mode,
          decimated: cur?.decimated,
          archiver: cur?.archiver,
        });
      }
      return next;
    });

    for (const trace of archiveTraces) {
      const archiver = pickArchiver(trace, globalArchiver);
      const bins = pickBins(trace);
      const window = rangeToWindowNs(trace.archiveTimeRange);

      void (async () => {
        try {
          const dto = await fetchData(
            trace.pvName,
            {
              fromNs: window.fromNs,
              toNs: window.toNs,
              archiver,
              binning: 'auto',
              maxPoints: bins,
            },
            controller.signal
          );
          if (controller.signal.aborted) return;
          setResults((prev) => {
            const next = new Map(prev);
            next.set(trace.id, dtoToResult(dto));
            return next;
          });
        } catch (err) {
          if ((err as { name?: string }).name === 'AbortError') return;
          const code = err instanceof CanopyError ? err.code : 'unknown_error';
          const detail = err instanceof CanopyError ? err.detail : (err as Error).message;
          setResults((prev) => {
            const next = new Map(prev);
            next.set(trace.id, {
              status: 'error',
              mean: [],
              band: [],
              error: { code, detail },
            });
            return next;
          });
        }
      })();
    }

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  return results;
}

export { EMPTY_RESULT };
