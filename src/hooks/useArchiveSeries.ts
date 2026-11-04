import { useEffect, useSyncExternalStore } from 'react';
import { archiveStore, DEFAULT_OPTIMIZED_BINS } from '../state/archiveStore';
import type { ArchiveEntry } from '../state/archiveStore';
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
  // End of the window the buffer covers (ns). The gap rule compares it with
  // the last sample to tell a stalled recorder from a fresh tail.
  coverToNs?: number;
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
    coverToNs: entry.coverToNs,
  };
}

function pickArchiver(trace: PVTrace, plotArchiver: string | undefined): string | undefined {
  return trace.archiver ?? plotArchiver;
}

export function useArchiveSeries(
  traces: PVTrace[],
  // Per-trace plot default archiver (keyed by trace id). A trace's own
  // `archiver` overrides it; both undefined means "use the backend default".
  plotArchiverByTrace: Map<string, string | undefined>,
  windowByTrace: Map<string, TimeWindowNs>
): Map<string, ArchiveSeriesResult> {
  // Stable signature of the inputs that should drive a store update. Callers
  // (TraceApp) rebuild `traces` and `windowByTrace` every render, so depending
  // on them directly would re-fire the effect on every render. The signature
  // collapses identical input shapes into a string so the effect only runs
  // when something archive-relevant actually changed. Traces without a window
  // are skipped by the effect, but still contribute a stable slot so that the
  // signature changes when a window appears for them.
  const signature = traces
    .map((t) => {
      if (!t.useArchive || !t.pvName) return `${t.id}:off`;
      const archiver = pickArchiver(t, plotArchiverByTrace.get(t.id)) ?? '';
      const bins = t.optimizedDataBins ?? '';
      const win = windowByTrace.get(t.id);
      const winKey = win ? `${win.fromNs}-${win.toNs}` : 'none';
      return `${t.id}:${t.pvName}|${archiver}|${bins}|${winKey}`;
    })
    .join('||');

  // Drive the store from the current set of traces. The store dedupes
  // requests with matching (pv, archiver, bins) and a covering window, so
  // calling `request` every render is safe and cheap when nothing changed.
  // Time range is plot-level. TraceApp resolves it per-trace and feeds the
  // map; a missing entry means "skip this trace."
  useEffect(() => {
    const wanted = new Set<string>();
    for (const trace of traces) {
      if (!trace.useArchive || !trace.pvName) continue;
      const window = windowByTrace.get(trace.id);
      if (!window) continue;
      wanted.add(trace.id);
      archiveStore.request(trace.id, {
        pv: trace.pvName,
        archiver: pickArchiver(trace, plotArchiverByTrace.get(trace.id)),
        bins: trace.optimizedDataBins,
        window,
      });
    }
    for (const id of archiveStore.getSnapshot().keys()) {
      if (!wanted.has(id)) archiveStore.release(id);
    }
    // The effect closes over `traces`, `plotArchiverByTrace`, and
    // `windowByTrace`, but those references churn every render; the signature
    // captures the meaningful subset.
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
