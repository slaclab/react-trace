import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Plot } from '../types';
import type { TimeWindowNs } from '../api/time';
import { relativeRangeMs } from '../api/time';
import type { LiveSeriesResult } from './useLiveSeries';

export const DEFAULT_REFRESH_INTERVAL_S = 5;
export const MIN_REFRESH_S = 1;
export const MAX_REFRESH_S = 60;

// Longest refresh interval a following plot gets, as a fraction of its span.
// Only its axis scrolls between refreshes (useFollowNow), so archive and
// formula samples end where the last refresh left them: at -30s with a 60 s
// interval the axis would scroll past all of them before the next one. A sixth
// leaves the default 5 s at -30s alone and caps -1m at 10 s and -5m at 50 s.
const MAX_REFRESH_SPAN_FRACTION = 1 / 6;

// Treat a plot as due this many ms before its interval elapses, so a timer that
// fires a hair early still advances it instead of rescheduling a 1ms timeout.
const DUE_SLOP_MS = 5;

export function clampInterval(s: number | undefined): number {
  return Math.min(MAX_REFRESH_S, Math.max(MIN_REFRESH_S, s ?? DEFAULT_REFRESH_INTERVAL_S));
}

// How often a following plot's clock advances, in ms: its refresh interval
// (clamped), but no longer than MAX_REFRESH_SPAN_FRACTION of a relative range's
// span, and never under MIN_REFRESH_S.
export function refreshIntervalMs(plot: Plot): number {
  const ms = clampInterval(plot.refreshIntervalS) * 1000;
  const spanMs = relativeRangeMs(plot.xAxis.timeRange);
  if (spanMs === null) return ms;
  return Math.min(ms, Math.max(MIN_REFRESH_S * 1000, spanMs * MAX_REFRESH_SPAN_FRACTION));
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
  const capMs = anchorMs + refreshIntervalMs(plot);
  return Math.min(Math.max(anchorMs, liveEdgeMs(plot, liveResults)), capMs);
}

// Where the plot's time axis ends: a frozen plot ends exactly at its anchor; a
// following one keeps up with live samples between ticks (see followingEndMs).
// The one place this is worked out, so the chart draws to the same instant
// that stopping Autoscroll or a pan freezes the plot at.
export function axisEndMs(
  plot: Plot,
  anchorMs: number,
  following: boolean,
  liveResults: Map<string, LiveSeriesResult>
): number {
  return following ? followingEndMs(plot, anchorMs, liveResults) : anchorMs;
}

export interface FollowingCadence {
  // `[id, ms]` for each following plot, in plot order.
  cadence: [string, number][];
  // Equal for two values exactly when their cadences are equal.
  key: string;
}

// The following plots and how often each advances, plus a string key for them,
// built in one pass. Each id is length-prefixed: imports keep plot ids as saved,
// so an id can hold `,`, `:` or `;`, and plain separators would let two
// different sets collide (`['a,b', 'c']` and `['a', 'b,c']` joined on `,`). The
// `;` after each interval can't occur in a number's string form.
export function followingCadence(
  plots: Plot[],
  viewWindowByPlot: Map<string, TimeWindowNs>
): FollowingCadence {
  const cadence: [string, number][] = [];
  let key = '';
  for (const plot of plots) {
    if (!isFollowing(plot, viewWindowByPlot)) continue;
    const ms = refreshIntervalMs(plot);
    cadence.push([plot.id, ms]);
    key += `${plot.id.length}:${plot.id}${ms};`;
  }
  return { cadence, key };
}

interface ClockState {
  // Per-plot anchor ("now") in epoch ms.
  byPlot: ReadonlyMap<string, number>;
  // Most recent anchor written. Fallback for a plot id that hasn't been seeded
  // yet; every path that introduces a plot seeds it, so this is defensive only.
  lastWriteMs: number;
}

export interface PlotClock {
  // The plot's anchor: "now" for its relative range or a custom range with a
  // blank To. Read this instead of the wall clock. A following plot's axis may
  // end a little past it (see axisEndMs).
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

  // Following plots and their cadence in ms. `following` keeps its identity
  // until the key changes, so the effect re-subscribes only when the following
  // set or an interval changes, not on every re-render (live batches, selection).
  const latest = followingCadence(plots, viewWindowByPlot);
  const [following, setFollowing] = useState(latest);
  if (following.key !== latest.key) setFollowing(latest);

  useEffect(() => {
    const { cadence } = following;
    if (cadence.length === 0) return;
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
  }, [following, clock]);

  const nowFor = useCallback(
    (plotId: string) => clock.byPlot.get(plotId) ?? clock.lastWriteMs,
    [clock]
  );

  return useMemo(() => ({ nowFor, resync }), [nowFor, resync]);
}
