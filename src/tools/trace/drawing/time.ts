// Trace's time-window maths and its "All" span: time windows `{ from, to }` in
// epoch milliseconds (the x axis), and the all-loaded follow-live window.
import { relativeSpanFor, type TimeWindowMs } from '../../../api/time';
import type { ArchiveSeriesResult } from '../../../hooks/useArchiveSeries';
import type { FormulaSeriesResult } from '../../../hooks/useFormulaSeries';
import type { LiveSeriesResult } from '../../../hooks/useLiveSeries';
import type { Plot } from '../../../types';

/**
 * Scale a time window's span by `factor` keeping its right edge fixed — the
 * time-band drag, so a window that ends at "now" still ends at "now".
 */
export function stretchTimeRightAnchored(window: TimeWindowMs, factor: number): TimeWindowMs {
  return { from: window.to - (window.to - window.from) * factor, to: window.to };
}

/** Scale a time window's span by `factor` about the time `atT` (cursor zoom). */
export function zoomTimeAt(window: TimeWindowMs, atT: number, factor: number): TimeWindowMs {
  return {
    from: atT + (window.from - atT) * factor,
    to: atT + (window.to - atT) * factor,
  };
}

/** Shift a time window by `dt` milliseconds, keeping its span. */
export function panTime(window: TimeWindowMs, dt: number): TimeWindowMs {
  return { from: window.from + dt, to: window.to + dt };
}

/** Move a time window so it is centred on `t`, keeping its span. */
export function centerTimeOn(window: TimeWindowMs, t: number): TimeWindowMs {
  const half = (window.to - window.from) / 2;
  return { from: t - half, to: t + half };
}

// ---------------------------------------------------------------------------
// All loaded
//
// "All" is the earliest loaded sample → now, written back as a relative span so
// the plot keeps following live. It reads the per-plot
// result maps PlotArea already holds (archive/live/formula keyed by trace id),
// not the SinglePlot memo the tab bar cannot reach.

/** One plot's loaded buffers, keyed by trace id (PlotArea's `*ResultsByPlot.get(plotId)`). */
export interface LoadedResults {
  archive?: ReadonlyMap<string, ArchiveSeriesResult>;
  live?: ReadonlyMap<string, LiveSeriesResult>;
  formula?: ReadonlyMap<string, FormulaSeriesResult>;
}

/** A real sample: finite time and finite value (gap markers carry a null value). */
function isSample(t: unknown, v: unknown): t is number {
  return typeof t === 'number' && Number.isFinite(t) && typeof v === 'number' && Number.isFinite(v);
}

/** Earliest real sample time in a time-sorted buffer, or Infinity. */
function earliestOf<P>(points: readonly P[] | undefined, at: (p: P) => [unknown, unknown]): number {
  if (!points) return Infinity;
  for (const p of points) {
    const [t, v] = at(p);
    if (isSample(t, v)) return t;
  }
  return Infinity;
}

/**
 * The window from the earliest non-null sample across the visible curves'
 * buffers to `nowMs`, or null when no visible curve holds a sample. Hidden
 * curves, gap markers (null values) and live disconnect breaks never count.
 */
export function allLoadedWindow(
  results: LoadedResults,
  visibleTraceIds: Iterable<string>,
  nowMs: number
): TimeWindowMs | null {
  let from = Infinity;
  for (const id of visibleTraceIds) {
    from = Math.min(
      from,
      earliestOf(results.archive?.get(id)?.mean, (p) => [p.time, p.value]),
      earliestOf(results.live?.get(id)?.points, (p) => [p.time, p.value]),
      earliestOf(results.formula?.get(id)?.points, (p) => [p[0], p[1]])
    );
  }
  return Number.isFinite(from) ? { from, to: nowMs } : null;
}

/**
 * The follow-live xAxis every All surface applies: `xAxis` with `timeRange`
 * set to the all-loaded span, rounded up so the earliest sample stays in view
 *. Null when nothing is loaded or the span is under the
 * relative-span floor; every All surface is then a no-op.
 */
export function allLoadedXAxis(
  xAxis: Plot['xAxis'],
  results: LoadedResults,
  visibleTraceIds: Iterable<string>,
  nowMs: number
): Plot['xAxis'] | null {
  const window = allLoadedWindow(results, visibleTraceIds, nowMs);
  const timeRange = window ? relativeSpanFor(window, 'up') : null;
  return timeRange ? { ...xAxis, timeRange } : null;
}
