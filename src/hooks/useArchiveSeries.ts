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
  // Drive the store from the current set of traces. The store dedupes
  // requests with matching (pv, archiver, bins) and a covering window, so
  // calling `request` every render is safe and cheap when nothing changed.
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
  });

  const snapshot = useSyncExternalStore(archiveStore.subscribe, archiveStore.getSnapshot);

  if (snapshot.size === 0) return EMPTY_SERIES;

  const out = new Map<string, ArchiveSeriesResult>();
  for (const trace of traces) {
    const entry = snapshot.get(trace.id);
    out.set(trace.id, entry ? entryToResult(entry) : IDLE_RESULT);
  }
  return out;
}
