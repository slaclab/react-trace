import { useEffect, useSyncExternalStore } from 'react';
import { liveStore } from '../state/liveStore';
import type { LiveEntry, LivePoint, LiveStatus } from '../state/liveStore';
import type { PVTrace } from '../types';

export const LIVE_RETENTION_DEFAULT_MS = 5 * 60_000;

export type { LivePoint, LiveStatus } from '../state/liveStore';

export interface LiveSeriesResult {
  status: LiveStatus;
  connected: boolean;
  severity: LiveEntry['severity'];
  latest: LiveEntry['latest'];
  points: readonly LivePoint[];
}

const IDLE_RESULT: LiveSeriesResult = {
  status: 'idle',
  connected: false,
  severity: null,
  latest: null,
  points: [],
};

const EMPTY_SERIES = new Map<string, LiveSeriesResult>();

function entryToResult(entry: LiveEntry): LiveSeriesResult {
  return {
    status: entry.status,
    connected: entry.connected,
    severity: entry.severity,
    latest: entry.latest,
    points: entry.points,
  };
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

  if (snapshot.size === 0) return EMPTY_SERIES;

  const out = new Map<string, LiveSeriesResult>();
  for (const trace of traces) {
    const entry = snapshot.get(trace.id);
    out.set(trace.id, entry ? entryToResult(entry) : IDLE_RESULT);
  }
  return out;
}
