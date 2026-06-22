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

// Drives now-tracking. One interval per eligible plot (plots can have different
// refresh rates). Each tick bumps local state, which re-renders the caller
// (TraceApp); its `windowByTrace` then recomputes `rangeToWindowNs` fresh and
// the window advances. The archive store's coverage check decides whether the
// advance warrants a refetch, so over-ticking is cheap.
export function useAutoScrollTimers(
  plots: Plot[],
  viewWindowByPlot: Map<string, TimeWindowNs>
): void {
  const [, setTick] = useState(0);

  // Re-subscribe only when the eligible set or any interval changes.
  const signature = plots
    .filter((p) => eligible(p, viewWindowByPlot))
    .map((p) => `${p.id}:${clampInterval(p.refreshIntervalS)}`)
    .join('|');

  useEffect(() => {
    if (!signature) return;
    const timers = signature.split('|').map((entry) => {
      const secs = Number(entry.slice(entry.lastIndexOf(':') + 1));
      return window.setInterval(() => setTick((t) => t + 1), secs * 1000);
    });
    return () => timers.forEach((id) => window.clearInterval(id));
  }, [signature]);
}
