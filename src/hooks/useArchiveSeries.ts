import { useEffect, useSyncExternalStore } from 'react';
import { archiveStore, DEFAULT_OPTIMIZED_BINS } from '../state/archiveStore';
import type { ArchiveEntry } from '../state/archiveStore';
import { rangeToWindowNs } from '../api/time';
import type { TimeWindowNs } from '../api/time';
import type { PVTrace } from '../types';

export { DEFAULT_OPTIMIZED_BINS };
export type { ArchivePlotPoint, ArchiveBandPoint, ArchiveEntry } from '../state/archiveStore';

// Public shape consumed by PlotArea / RightPanel / LeftPanel. Keeps the old
// `ArchiveSeriesResult` field names so component call sites don't churn.
export type ArchiveSeriesStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface ArchiveSeriesResult {
  status: ArchiveSeriesStatus;
  mode?: 'raw' | 'binned';
  mean: ArchiveEntry['mean'];
  band: ArchiveEntry['band'];
  decimated?: boolean;
  archiver?: string;
  error?: { code: string; detail: string };
}

const IDLE_RESULT: ArchiveSeriesResult = { status: 'idle', mean: [], band: [] };
const EMPTY_SERIES = new Map<string, ArchiveSeriesResult>();

function entryToResult(entry: ArchiveEntry): ArchiveSeriesResult {
  return {
    status: entry.status,
    mode: entry.mode,
    mean: entry.mean,
    band: entry.band,
    decimated: entry.decimated,
    archiver: entry.archiver || undefined,
    error: entry.error,
  };
}

function pickArchiver(trace: PVTrace, globalArchiver: string | undefined): string | undefined {
  return trace.archiver ?? globalArchiver;
}

export function useArchiveSeries(
  traces: PVTrace[],
  globalArchiver: string | undefined,
  windowOverrideByTrace?: Map<string, TimeWindowNs>
): Map<string, ArchiveSeriesResult> {
  // Stable signature of the inputs that should drive a store update. Callers
  // (TraceApp) rebuild `traces` and `windowOverrideByTrace` every render, so
  // depending on them directly would re-fire the effect on every render. The
  // signature collapses identical input shapes into a string so the effect
  // only runs when something archive-relevant actually changed.
  const signature = traces
    .map((t) => {
      if (!t.useArchive || !t.pvName) return `${t.id}:off`;
      const archiver = pickArchiver(t, globalArchiver) ?? '';
      const bins = t.optimizedDataBins ?? '';
      const win = windowOverrideByTrace?.get(t.id);
      const winKey = win ? `${win.fromNs}-${win.toNs}` : `r:${t.archiveTimeRange}`;
      return `${t.id}:${t.pvName}|${archiver}|${bins}|${winKey}`;
    })
    .join('||');

  useEffect(() => {
    const wanted = new Set<string>();
    for (const trace of traces) {
      if (!trace.useArchive || !trace.pvName) continue;
      wanted.add(trace.id);
      const window =
        windowOverrideByTrace?.get(trace.id) ?? rangeToWindowNs(trace.archiveTimeRange);
      archiveStore.request(trace.id, {
        pv: trace.pvName,
        archiver: pickArchiver(trace, globalArchiver),
        bins: trace.optimizedDataBins,
        window,
      });
    }
    for (const id of archiveStore.getSnapshot().keys()) {
      if (!wanted.has(id)) archiveStore.release(id);
    }
    // The effect closes over `traces`, `globalArchiver`, and
    // `windowOverrideByTrace`, but those references churn every render — the
    // signature captures the meaningful subset.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  const snapshot = useSyncExternalStore(archiveStore.subscribe, archiveStore.getSnapshot);

  if (snapshot.size === 0) return EMPTY_SERIES;

  const out = new Map<string, ArchiveSeriesResult>();
  for (const trace of traces) {
    const entry = snapshot.get(trace.id);
    out.set(trace.id, entry ? entryToResult(entry) : IDLE_RESULT);
  }
  return out;
}
