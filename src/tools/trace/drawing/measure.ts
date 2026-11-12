// Measure readout.
//
// A measure's card reads Δy, Δ% (against the first anchor's v), Δt, and n /
// mean / σ over the adopted curve's samples inside [t0, t1]. The statistics go
// through the shared library: a one-row `StatFrame` sliced from the curve's
// line data, evaluated with the trace catalog's `n`, `mean` and `std` presets
// (sample σ). `traceStatFrame` is not used: it needs the whole Plot and every
// result map, while the measure only has one curve's line.
//
// Adopted curve: the anchor's snapped `traceId` when that curve has line data,
// else the primary-axis curve nearest in time to the span (a curve with a
// sample inside the span is at distance 0; ties keep the earlier curve). None
// leaves n / mean / σ as `—`.
//
// Binned: when the adopted curve's archive data is binned and the span reaches
// it (starts at or before the archive's last sample, when that is known), n
// counts bins and σ is approximate. The Layers label (`objName`) takes the
// same flag, so the two never disagree.
//
import type { LinePoint } from '../../../components/traceGaps';
import { evaluateMetrics, type StatFrame } from '../../../statistics/evaluate';
import { presetMetric, presetOf, type Metric } from '../../../statistics/model';
import { TRACE_METRICS } from '../metrics';
import {
  fmtValue,
  formatDuration,
  READOUT_DASH,
  term,
  terms,
  withMinus,
} from '../../../annotations/catalog/format';
import type { AxisRef } from '../../../annotations/catalog/types';
import { BUILTIN_CATALOG } from '../../../annotations/catalog';
import { TIME_X_AXIS } from '../../../annotations/catalog/xAxis';
import { objNameIn, type Annotation } from '../../../annotations/model';

/** A curve the measure may adopt: its id and the y axis it is drawn on. */
export interface MeasureTrace {
  id: string;
  axisId: string;
}

export interface MeasureInputs {
  /** Line data of the plot's visible curves (SinglePlot's `traceData`). */
  traceData?: ReadonlyMap<string, readonly LinePoint[]>;
  /** The curves, in plot order (ties in the nearest-curve rule keep the earlier). */
  traces?: readonly MeasureTrace[];
  /** The plot's primary y axis (the first visible one). */
  primaryAxisId?: string;
  /** Curves whose archive data is binned (`archiveResults` mode 'binned'). */
  binnedTraceIds?: ReadonlySet<string>;
  /** Last archive sample time (ms) per binned curve; absent = the whole line is archive. */
  archiveEndMs?: ReadonlyMap<string, number>;
}

export interface MeasureReadout {
  /** v1 - v0. */
  dy: number;
  /** (v1 - v0) / |v0| × 100; null when v0 is 0 or not finite. */
  dPct: number | null;
  /** t1 - t0, ms. */
  dt: number;
  /** The adopted curve, or null when there is none. */
  traceId: string | null;
  /** Samples (or bins) in the span; null without a curve. */
  n: number | null;
  mean: number | null;
  /** Sample σ (ddof 1); null under two samples or without a curve. */
  std: number | null;
  /** The adopted curve is binned archive data over this span. */
  binned: boolean;
}

const STAT_METRICS: readonly Metric[] = ['n', 'mean', 'std'].map((id) =>
  presetMetric(presetOf(TRACE_METRICS, id)!, true)
);

function spanOf(a: Annotation): [number, number] {
  const t0 = a.points[0]?.t ?? 0;
  const t1 = a.points[1]?.t ?? t0;
  return [Math.min(t0, t1), Math.max(t0, t1)];
}

/** Time distance from the curve's nearest valued sample to [lo, hi]; Infinity when it has none. */
function distanceToSpan(line: readonly LinePoint[], lo: number, hi: number): number {
  let best = Number.POSITIVE_INFINITY;
  for (const [t, v] of line) {
    if (v === null || !Number.isFinite(v)) continue;
    const d = t < lo ? lo - t : t > hi ? t - hi : 0;
    if (d < best) best = d;
    if (best === 0) break;
  }
  return best;
}

/** The curve the measure's statistics come from, or null. */
export function adoptedTraceId(a: Annotation, inputs: MeasureInputs): string | null {
  const data = inputs.traceData;
  if (!data) return null;
  if (a.traceId !== undefined && data.has(a.traceId)) return a.traceId;
  const [lo, hi] = spanOf(a);
  let best: string | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  for (const trace of inputs.traces ?? []) {
    if (trace.axisId !== inputs.primaryAxisId) continue;
    const line = data.get(trace.id);
    if (!line) continue;
    const d = distanceToSpan(line, lo, hi);
    if (d < bestD) {
      bestD = d;
      best = trace.id;
    }
  }
  return best;
}

/** The values (and their times) of `line` inside [lo, hi], gap markers dropped. */
function slice(
  line: readonly LinePoint[],
  lo: number,
  hi: number
): StatFrame['rows'][number]['columns'] {
  const y: number[] = [];
  const t: number[] = [];
  for (const [tm, v] of line) {
    if (tm < lo || tm > hi || v === null || !Number.isFinite(v)) continue;
    y.push(v);
    t.push((tm - hi) / 1000);
  }
  return { y, t };
}

function cell(value: number | null | undefined): number | null {
  return value === null || value === undefined || !Number.isFinite(value) ? null : value;
}

export function measureReadout(a: Annotation, inputs: MeasureInputs): MeasureReadout {
  const v0 = a.points[0]?.v ?? Number.NaN;
  const v1 = a.points[1]?.v ?? v0;
  const t0 = a.points[0]?.t ?? 0;
  const t1 = a.points[1]?.t ?? t0;
  const dy = v1 - v0;
  const dPct = v0 === 0 || !Number.isFinite(v0) ? null : (dy / Math.abs(v0)) * 100;
  const base = { dy, dPct: dPct !== null && Number.isFinite(dPct) ? dPct : null, dt: t1 - t0 };

  const traceId = adoptedTraceId(a, inputs);
  const line = traceId !== null ? inputs.traceData?.get(traceId) : undefined;
  if (traceId === null || !line) {
    return { ...base, traceId: null, n: null, mean: null, std: null, binned: false };
  }
  const [lo, hi] = spanOf(a);
  const frame: StatFrame = {
    rows: [{ id: traceId, label: traceId, columns: slice(line, lo, hi) }],
  };
  const cells = evaluateMetrics(TRACE_METRICS, frame, STAT_METRICS).rows[0]?.cells ?? {};
  const archiveEnd = inputs.archiveEndMs?.get(traceId);
  const binned =
    (inputs.binnedTraceIds?.has(traceId) ?? false) &&
    (archiveEnd === undefined || lo <= archiveEnd);
  return {
    ...base,
    traceId,
    n: cell(cells.n?.value) ?? 0,
    mean: cell(cells.mean?.value),
    std: cell(cells.std?.value),
    binned,
  };
}

/**
 * The readout's lines, as a figure prints them: `Δt = …  Δy = …  (Δ …%)`,
 * then `n = …  x̄ = …  σ = …`. `unit` (the axis unit text) follows Δy, the
 * mean and σ; over binned data n counts bins and σ reads approximate.
 */
export function measureCardLines(r: MeasureReadout, unit?: string): string[] {
  const dt = `Δt = ${Number.isFinite(r.dt) ? formatDuration(r.dt) : READOUT_DASH}`;
  const pct = r.dPct === null ? null : `(${withMinus(fmtValue(r.dPct))} %)`;
  const n = r.n === null ? READOUT_DASH : r.binned ? `${r.n} bins` : String(r.n);
  const sd = term('σ', r.std, unit);
  return [
    terms(dt, term('Δy', r.dy, unit), ...(pct ? [pct] : [])),
    terms(`n = ${n}`, term('x̄', r.mean, unit), r.binned ? sd.replace(' = ', ' ≈ ') : sd),
  ];
}

/** The measure's Layers label, binned exactly when its readout is. */
export function measureLabel(
  a: Annotation,
  axes: readonly AxisRef[],
  inputs: MeasureInputs
): string {
  return objNameIn(BUILTIN_CATALOG, TIME_X_AXIS, a, axes, measureReadout(a, inputs).binned);
}
