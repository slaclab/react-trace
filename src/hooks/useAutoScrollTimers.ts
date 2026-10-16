import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Plot } from '../types';
import type { TimeWindowNs } from '../api/time';
import type { LiveSeriesResult } from './useLiveSeries';

export const DEFAULT_REFRESH_INTERVAL_S = 5;
export const MIN_REFRESH_S = 1;
export const MAX_REFRESH_S = 60;

// Treat a plot as due this many ms before its interval elapses, so a timer that
// fires a hair early still advances it instead of rescheduling a 1ms timeout.
const DUE_SLOP_MS = 5;

export function clampInterval(s: number | undefined): number {
  return Math.min(MAX_REFRESH_S, Math.max(MIN_REFRESH_S, s ?? DEFAULT_REFRESH_INTERVAL_S));
}

// A plot tracks "now" only with autoscroll on, a relative range (not custom),
// and no manual pan/zoom recorded (which would otherwise own the window).
export function isFollowing(plot: Plot, viewWindowByPlot: Map<string, TimeWindowNs>): boolean {
  return (
    plot.autoScroll !== false && plot.xAxis.timeRange !== 'custom' && !viewWindowByPlot.has(plot.id)
  );
}

// Newest live sample time (ms) among the plot's visible live traces, or
// -Infinity when there is none.
export function liveEdgeMs(plot: Plot, liveResults: Map<string, LiveSeriesResult>): number {
  let edge = -Infinity;
  for (const trace of plot.traces) {
    if (!trace.visible || !trace.useLive || trace.kind === 'formula') continue;
    const last = liveResults.get(trace.id)?.points.at(-1);
    if (last && last.time > edge) edge = last.time;
  }
  return edge;
}

// Where a following plot's time axis ends. The anchor only advances once per
// refresh interval, so on its own it would leave up to one interval of fresh
// live samples past the right edge. Instead the end is pushed forward to the
// newest live sample, so the axis keeps up with live data between ticks without
// reading the wall clock. It never runs more than one interval past the anchor,
// which bounds the effect of a skewed or bogus IOC timestamp. Fetch windows
// still use the anchor alone.
export function followingEndMs(
  plot: Plot,
  anchorMs: number,
  liveResults: Map<string, LiveSeriesResult>
): number {
  const capMs = anchorMs + clampInterval(plot.refreshIntervalS) * 1000;
  return Math.min(Math.max(anchorMs, liveEdgeMs(plot, liveResults)), capMs);
}

interface ClockState {
  // Per-plot anchor ("now") in epoch ms.
  byPlot: ReadonlyMap<string, number>;
  // Most recent anchor written. Fallback for a plot id that hasn't been seeded
  // yet; every path that introduces a plot seeds it, so this is defensive only.
  lastWriteMs: number;
}

export interface PlotClock {
  // The instant this plot's time range ends at ("now" for a relative range or a
  // custom range with a blank To). Read this instead of the wall clock.
  nowFor: (plotId: string) => number;
  // Set the given plots' anchors to `atMs` (default: the current time). Call it
  // from event handlers when a plot appears, resumes following, or freezes at a
  // specific instant.
  resync: (plotIds: string[], atMs?: number) => void;
}

// Per-plot "now" clock. Each plot's time window resolves against its own anchor
// rather than `Date.now()` at render, so re-renders (live batches, selection,
// settings) never move a window. A following plot's anchor advances once per
// its own refresh interval; any other plot's anchor holds still, which is what
// freezes the axis and the archive/formula/DIT fetch windows together.
//
// One timeout is scheduled for the earliest due following plot. When it fires,
// every due plot is re-anchored to the current time (not anchor + interval), so
// a throttled background tab catches up in one step.
export function useAutoScrollTimers(
  plots: Plot[],
  viewWindowByPlot: Map<string, TimeWindowNs>
): PlotClock {
  const [clock, setClock] = useState<ClockState>(() => {
    const now = Date.now();
    return { byPlot: new Map(plots.map((p) => [p.id, now])), lastWriteMs: now };
  });

  const resync = useCallback((plotIds: string[], atMs?: number) => {
    const at = atMs ?? Date.now();
    setClock((prev) => {
      const byPlot = new Map(prev.byPlot);
      for (const id of plotIds) byPlot.set(id, at);
      return { byPlot, lastWriteMs: Math.max(prev.lastWriteMs, at) };
    });
  }, []);

  // Following plots and their cadence in ms. The effect parses this string back
  // so it re-subscribes only when the following set or an interval changes.
  const signature = plots
    .filter((p) => isFollowing(p, viewWindowByPlot))
    .map((p) => `${p.id}:${clampInterval(p.refreshIntervalS) * 1000}`)
    .join('|');

  useEffect(() => {
    if (!signature) return;
    const cadence = signature.split('|').map((entry) => {
      const i = entry.lastIndexOf(':');
      return [entry.slice(0, i), Number(entry.slice(i + 1))] as const;
    });
    const anchorOf = (state: ClockState, id: string) => state.byPlot.get(id) ?? state.lastWriteMs;
    let nextDue = Infinity;
    for (const [id, ms] of cadence) nextDue = Math.min(nextDue, anchorOf(clock, id) + ms);

    const timer = window.setTimeout(
      () => {
        const now = Date.now();
        setClock((prev) => {
          const byPlot = new Map(prev.byPlot);
          for (const [id, ms] of cadence) {
            if (anchorOf(prev, id) + ms <= now + DUE_SLOP_MS) byPlot.set(id, now);
          }
          // Always hand back a new state, even if nothing was due (a timer that
          // fired early), so this effect re-runs and reschedules.
          return { byPlot, lastWriteMs: Math.max(prev.lastWriteMs, now) };
        });
      },
      Math.max(0, nextDue - Date.now())
    );
    return () => window.clearTimeout(timer);
  }, [signature, clock]);

  const nowFor = useCallback(
    (plotId: string) => clock.byPlot.get(plotId) ?? clock.lastWriteMs,
    [clock]
  );

  return useMemo(() => ({ nowFor, resync }), [nowFor, resync]);
}
