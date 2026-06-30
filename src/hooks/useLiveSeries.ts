import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { liveStore } from '../state/liveStore';
import type { LiveEntry, LiveError, LivePoint, LiveStatus } from '../state/liveStore';
import type { PVTrace } from '../types';

export const LIVE_RETENTION_DEFAULT_MS = 5 * 60_000;

export type { LivePoint, LiveStatus, LiveError } from '../state/liveStore';

export interface LiveSeriesResult {
  status: LiveStatus;
  connected: boolean;
  severity: LiveEntry['severity'];
  latest: LiveEntry['latest'];
  error: LiveError | null;
  points: readonly LivePoint[];
}

const IDLE_RESULT: LiveSeriesResult = {
  status: 'idle',
  connected: false,
  severity: null,
  latest: null,
  error: null,
  points: [],
};

const EMPTY_SERIES = new Map<string, LiveSeriesResult>();

// Cache the per-entry result keyed by the source LiveEntry. The store hands
// back a stable LiveEntry reference when a PV is unchanged, so mapping it to a
// memoized LiveSeriesResult keeps that stability through to PlotArea /
// RightPanel: an unchanged entry yields the same result object across frames.
// Module-scoped because `useLiveSeries` is mounted once at the app level; a
// WeakMap lets entries for released PVs be collected.
const resultCache = new WeakMap<LiveEntry, LiveSeriesResult>();

function entryToResult(entry: LiveEntry): LiveSeriesResult {
  const cached = resultCache.get(entry);
  if (cached) return cached;
  const result: LiveSeriesResult = {
    status: entry.status,
    connected: entry.connected,
    severity: entry.severity,
    latest: entry.latest,
    error: entry.error,
    points: entry.points,
  };
  resultCache.set(entry, result);
  return result;
}

export function useLiveSeries(traces: PVTrace[]): Map<string, LiveSeriesResult> {
  // Stable signature mirroring the archive hook's pattern: traces churn every
  // render, the signature collapses identical input shapes into a string so
  // the effect only fires when something live-relevant actually changed.
  const signature = traces
    .map((t) => {
      if (!t.useLive || !t.pvName) return `${t.id}:off`;
      const retention = t.liveRetentionMs ?? LIVE_RETENTION_DEFAULT_MS;
      return `${t.id}:${t.pvName}|${retention}`;
    })
    .join('||');

  useEffect(() => {
    const wanted = new Set<string>();
    for (const trace of traces) {
      if (!trace.useLive || !trace.pvName) continue;
      wanted.add(trace.id);
      liveStore.watch(trace.id, trace.pvName, trace.liveRetentionMs ?? LIVE_RETENTION_DEFAULT_MS);
    }
    for (const id of liveStore.getSnapshot().keys()) {
      if (!wanted.has(id)) liveStore.release(id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  const snapshot = useSyncExternalStore(liveStore.subscribe, liveStore.getSnapshot);

  // Memoize the output Map so we return a stable reference when neither the
  // store snapshot nor the trace order changed. Live data drives frequent
  // re-renders via useSyncExternalStore; an unchanged frame thus yields the
  // same Map and downstream React.memo short-circuits instead of re-rendering.
  const ids = traces.map((t) => t.id).join('|');
  return useMemo(() => {
    if (snapshot.size === 0) return EMPTY_SERIES;
    const out = new Map<string, LiveSeriesResult>();
    for (const trace of traces) {
      const entry = snapshot.get(trace.id);
      out.set(trace.id, entry ? entryToResult(entry) : IDLE_RESULT);
    }
    return out;
    // `traces` churns every render; `ids` captures the meaningful subset.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot, ids]);
}
