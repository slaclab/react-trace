// Trace's statistics payload: the catalog the shared statistics
// library (src/statistics) evaluates, the per-plot state accessors, and the
// frame adapter over a plot's drawn curves.
//
// Per plot: `Plot.showStats` (undefined = off) and `Plot.metrics` (undefined
// = the default list), the tool-level object being the active plot.
// Rows: every curve of the plot in layer order — so `y<k>` is the k-th layer
// — the visible ones with their points inside the plot's view window (the
// panned dataZoom window, else the resolved time range), gap markers dropped,
// the invisible ones hidden rows with no values. Columns: `y` (the values),
// `t` (seconds relative to the window end, ≤ 0); a referenced curve `y<k>`
// is sampled at its own times, so it is resampled onto this curve's times,
// sample-and-hold (`resampleVar: 't'`), before it is used; `n` the samples
// in the window. Units: the curve's
// axis unit text (`y`), that per second (`y/s`), or none.

import { nsToMs, type TimeWindowNs } from '../../api/time';
import { traceLineData } from '../../components/traceGaps';
import { axisUnitText } from '../../embed/plotConfig';
import type { ArchiveSeriesResult } from '../../hooks/useArchiveSeries';
import type { FormulaSeriesResult } from '../../hooks/useFormulaSeries';
import type { LiveSeriesResult } from '../../hooks/useLiveSeries';
import type { StatFrame, StatRow } from '../../statistics/evaluate';
import {
  defaultMetrics,
  metricsAreDefault,
  normalizeMetrics,
  type Metric,
  type MetricCatalog,
} from '../../statistics/model';
import { traceLabel } from '../../traceLabel';
import type { Plot } from '../../types';

export const TRACE_METRICS: MetricCatalog = {
  id: 'trace',
  vectorVars: ['y', 't'],
  scalarVars: ['n'],
  jointVars: ['y'],
  alignedRows: false,
  resampleVar: 't',
  units: [
    { value: '', label: 'None' },
    { value: 'y', label: 'Axis unit' },
    { value: 'y/s', label: 'Axis unit per second' },
  ],
  presets: [
    { id: 'n', label: 'n', expr: 'n', unit: '', defaultOn: true },
    { id: 'mean', label: 'mean', expr: 'mean(y)', unit: 'y', defaultOn: true },
    { id: 'std', label: 'std', expr: 'std(y)', unit: 'y', defaultOn: true },
    { id: 'min', label: 'min', expr: 'min(y)', unit: 'y', defaultOn: true },
    { id: 'max', label: 'max', expr: 'max(y)', unit: 'y', defaultOn: true },
    { id: 'last', label: 'last', expr: 'last(y)', unit: 'y', defaultOn: false },
    { id: 'first', label: 'first', expr: 'first(y)', unit: 'y', defaultOn: false },
    { id: 'p2p', label: 'p-p', expr: 'ptp(y)', unit: 'y', defaultOn: false },
    { id: 'rms', label: 'rms', expr: 'rms(y)', unit: 'y', defaultOn: false },
    { id: 'median', label: 'median', expr: 'median(y)', unit: 'y', defaultOn: false },
    { id: 'slope', label: 'slope', expr: 'slope(t, y)', unit: 'y/s', defaultOn: false },
  ],
  rowNoun: 'curve',
  variables: [
    { name: 'y', signature: 'y', description: 'This curve’s values inside the time window.' },
    { name: 't', signature: 't', description: 'Seconds relative to the window end (≤ 0).' },
    {
      name: 'y1',
      signature: 'y1 … yN',
      description:
        'A curve by its position in the Layers list, held onto this curve’s sample times.',
    },
    { name: 'n', signature: 'n', description: 'The number of samples in the window.' },
    { name: 'pi', signature: 'pi', description: 'The constant π.' },
    { name: 'e', signature: 'e', description: "Euler's number." },
  ],
  example:
    'Expressions over y (this curve), e.g. std(y - mean(y)), slope(t, y), mean(y) - mean(y1).',
};

/** The plot's metric list: its own when set, else the default. */
export function plotMetrics(plot: Pick<Plot, 'metrics'>): Metric[] {
  return plot.metrics === undefined
    ? defaultMetrics(TRACE_METRICS)
    : normalizeMetrics(TRACE_METRICS, plot.metrics);
}

/** The stored form of a list: absent at the default (the sparse rule). */
export function storedMetrics(metrics: readonly Metric[]): Metric[] | undefined {
  const normalized = normalizeMetrics(TRACE_METRICS, metrics);
  return metricsAreDefault(TRACE_METRICS, normalized) ? undefined : normalized;
}

export interface TraceSeriesResults {
  archive: ReadonlyMap<string, ArchiveSeriesResult>;
  live: ReadonlyMap<string, LiveSeriesResult>;
  formula: ReadonlyMap<string, FormulaSeriesResult>;
}

/** The newest sample time (ms) across the frame's rows; null without one. */
export function frameClockMs(frame: StatFrame | null): number | null {
  if (frame === null) return null;
  let newest: number | null = null;
  for (const row of frame.rows as readonly TraceStatRow[]) {
    const ms = row.newestMs;
    if (ms !== undefined && (newest === null || ms > newest)) newest = ms;
  }
  return newest;
}

/** A frame row with the newest sample time it was built from (the strips' clock). */
export interface TraceStatRow extends StatRow {
  newestMs?: number;
}

/**
 * The frame as the statistics library sees it: one row per curve in layer
 * order (visible ones with their points inside `window`, the others hidden
 * and empty), or null when no curve has a point there.
 */
export function traceStatFrame(
  plot: Plot,
  results: TraceSeriesResults,
  window: TimeWindowNs
): StatFrame | null {
  const fromMs = nsToMs(window.fromNs);
  const toMs = nsToMs(window.toNs);
  const rows: TraceStatRow[] = [];
  for (const trace of plot.traces) {
    if (!trace.visible) {
      rows.push({
        id: trace.id,
        label: traceLabel(trace, plot.traces),
        color: trace.color,
        hidden: true,
        columns: { y: [], t: [] },
      });
      continue;
    }
    const data = traceLineData(
      trace,
      results.archive.get(trace.id),
      results.live.get(trace.id),
      results.formula.get(trace.id)
    );
    const y: number[] = [];
    const t: number[] = [];
    let newest: number | undefined;
    for (const [ms, value] of data) {
      if (value === null || ms < fromMs || ms > toMs) continue;
      y.push(value);
      t.push((ms - toMs) / 1000);
      newest = ms;
    }
    const row: TraceStatRow = {
      id: trace.id,
      label: traceLabel(trace, plot.traces),
      color: trace.color,
      columns: { y, t },
    };
    if (newest !== undefined) row.newestMs = newest;
    rows.push(row);
  }
  return rows.some((r) => r.columns.y.length > 0) ? { rows } : null;
}

/** The unit text of a metric's kind for a curve: its axis's unit text, that per second, or none. */
export function traceUnitOf(plot: Plot, rowId: string, unit: string): string {
  if (unit === '') return '';
  const trace = plot.traces.find((t) => t.id === rowId);
  const axis = trace === undefined ? undefined : plot.axes.find((a) => a.id === trace.axisId);
  const text = axis === undefined ? '' : (axisUnitText(axis) ?? '');
  if (unit === 'y') return text;
  if (unit === 'y/s') return text === '' ? '1/s' : `${text}/s`;
  return '';
}
