import { useEffect, useState } from 'react';
import type { Plot } from '../types';
import type { TimeWindowNs } from '../api/time';

export const DEFAULT_REFRESH_INTERVAL_S = 5;
export const MIN_REFRESH_S = 1;
export const MAX_REFRESH_S = 60;

export function clampInterval(s: number | undefined): number {
  return Math.min(MAX_REFRESH_S, Math.max(MIN_REFRESH_S, s ?? DEFAULT_REFRESH_INTERVAL_S));
}

// A plot tracks "now" only with autoscroll on, a relative range (not custom),
// and no manual pan/zoom recorded (which would otherwise own the window).
function eligible(plot: Plot, viewWindowByPlot: Map<string, TimeWindowNs>): boolean {
  return (
    plot.autoScroll !== false && plot.xAxis.timeRange !== 'custom' && !viewWindowByPlot.has(plot.id)
  );
}

// Drives now-tracking. A single timer fires at the shortest eligible interval.
// Each tick bumps local state, which re-renders the caller (TraceApp); its
// `windowByTrace` then recomputes `rangeToWindowNs` fresh and every eligible
// plot's window advances at once. This is deliberate: one `setTick` re-renders
// the whole tree, so separate per-plot timers could not advance plots
// independently anyway (a faster plot's tick would still advance the slow ones).
// Ticking all plots at the fastest rate keeps the behavior explicit. The archive
// store's coverage check decides whether an advance warrants a refetch, so the
// extra ticks on slower plots are cheap.
export function useAutoScrollTimers(
  plots: Plot[],
  viewWindowByPlot: Map<string, TimeWindowNs>
): void {
  const [, setTick] = useState(0);

  // Re-subscribe only when the eligible set or any interval changes.
  const intervals = plots
    .filter((p) => eligible(p, viewWindowByPlot))
    .map((p) => clampInterval(p.refreshIntervalS));
  const tickSecs = intervals.length ? Math.min(...intervals) : 0;

  useEffect(() => {
    if (!tickSecs) return;
    const id = window.setInterval(() => setTick((t) => t + 1), tickSecs * 1000);
    return () => window.clearInterval(id);
  }, [tickSecs]);
}
