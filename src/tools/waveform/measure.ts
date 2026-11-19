// Waveform's drawing data reads: the curves a drawing sees — each
// visible live curve over the element range, at the x the chart plots, after
// Δ when Δ is on — and the two host pieces built on them: the `nearestPoint`
// magnet's series and the Measure card.
//
// The card is a Δx Δy header, then one row per visible live curve over the
// elements whose x lies inside the measured span: the element count and the
// mean/σ of those elements. It never reuses the whole-range statistics frame.
//
// Everything reads the latest publish through a getter at call time (the
// host config is never keyed on a frame); nothing here caches a frame.
//
// Also the plot's other host pieces: the
// placing hint and the stamp a new drawing gets.
import type { Annotation } from '../../annotations/model';
import type { MeasureProvider, SamplePoint, StyleSwatch } from '../../annotations/catalog/types';
import {
  axisUnit,
  fmtValue,
  READOUT_DASH,
  TERM_GAP,
  term,
  terms,
} from '../../annotations/catalog/format';
import type { NearestSeries } from '../../plot/nearestPoint';
import { WAVEFORM_AXIS_ID } from './drawings';
import { deltaFrame, elementSpan } from './frames';
import type { WaveformModel } from './model';
import { renderedXSource, type WaveformPlotFrames } from './plotOption';
import type { WaveformState } from './query';
import { referenceFor } from './reference';
import { autoYColor } from '../shared/colors';

/** What the drawing reads see of the latest publish. */
export interface WaveformDrawingData {
  state: WaveformState;
  model: WaveformModel;
  frames: WaveformPlotFrames;
}

/** One drawn curve as a drawing sees it. */
export interface WaveformDrawnCurve {
  pv: string;
  /** The curve's pinned Label, else the PV. */
  name: string;
  /** The values the chart draws (Δ applied when Δ is on), full range. */
  values: Float64Array;
  /** The element range, half-open. */
  start: number;
  end: number;
  /** The plotted x of element `i`. */
  xAt(i: number): number;
}

/**
 * Every visible live curve (drawable, not hidden) with a published frame, as
 * the chart draws it: its values after Δ when Δ is on (a curve without a
 * reference is skipped then), its element range, and the x it is plotted at —
 * the element index, or the X source's value when the chart plots the source.
 */
export function waveformDrawnCurves(data: WaveformDrawingData): WaveformDrawnCurve[] {
  const { state, model, frames } = data;
  const xs = renderedXSource(model, frames) === 'index' ? null : frames.x;
  const out: WaveformDrawnCurve[] = [];
  for (const row of model.live) {
    if (!row.drawable || row.hidden) continue;
    const frame = frames.live[row.pv]?.frame;
    if (frame === undefined) continue;
    let values: Float64Array | null = frame;
    if (model.delta.on) {
      const against = referenceFor(state, frames, row.pv)?.values ?? null;
      values = against === null ? null : deltaFrame(frame, against);
    }
    if (values === null) continue;
    const span = elementSpan(values.length, state.elems);
    const start = span.start;
    let end = span.end;
    if (xs !== null) end = Math.min(end, xs.length);
    out.push({
      pv: row.pv,
      name: state.styles[row.pv]?.label ?? row.pv,
      values,
      start,
      end: Math.max(start, end),
      xAt: xs === null ? (i) => i : (i) => xs[i],
    });
  }
  return out;
}

/** The drawn curves' colours and names, for the style panel. */
export function waveformSwatches(data: WaveformDrawingData): StyleSwatch[] {
  return waveformDrawnCurves(data).map((c) => ({
    color: data.state.styles[c.pv]?.color ?? autoYColor(data.state.pvs.indexOf(c.pv)),
    name: c.name,
  }));
}

/** The magnet's candidates: one series per drawn curve, on Waveform's one y axis. */
export function waveformSnapSeries(data: WaveformDrawingData): NearestSeries[] {
  return waveformDrawnCurves(data).map((c) => {
    const points: SamplePoint[] = [];
    for (let i = c.start; i < c.end; i++) {
      const v = c.values[i];
      points.push([c.xAt(i), Number.isFinite(v) ? v : null]);
    }
    return { id: c.pv, axisId: WAVEFORM_AXIS_ID, points };
  });
}

/** One curve's statistics over a measured span. */
export interface WaveformMeasureRow {
  pv: string;
  name: string;
  /** Finite elements whose x lies in the span. */
  n: number;
  /** NaN when `n` is 0. */
  mean: number;
  /** Sample standard deviation; NaN when `n` < 2. */
  std: number;
}

/** The measured span's ends, ordered; null when the drawing has no two finite points. */
function spanOf(a: Annotation): { x0: number; x1: number; dx: number; dy: number } | null {
  const [p, q] = a.points;
  if (p === undefined || q === undefined) return null;
  if (!Number.isFinite(p.t) || !Number.isFinite(q.t)) return null;
  return {
    x0: Math.min(p.t, q.t),
    x1: Math.max(p.t, q.t),
    dx: q.t - p.t,
    dy: q.v - p.v,
  };
}

/**
 * One row per drawn curve over the elements whose plotted x lies in the
 * measured span (ends included, finite values only).
 */
export function waveformMeasureRows(
  a: Annotation,
  data: WaveformDrawingData
): WaveformMeasureRow[] {
  const span = spanOf(a);
  if (span === null) return [];
  return waveformDrawnCurves(data).map((c) => {
    let n = 0;
    let sum = 0;
    let sumSq = 0;
    for (let i = c.start; i < c.end; i++) {
      const x = c.xAt(i);
      if (!(x >= span.x0 && x <= span.x1)) continue;
      const v = c.values[i];
      if (!Number.isFinite(v)) continue;
      n++;
      sum += v;
      sumSq += v * v;
    }
    const mean = n > 0 ? sum / n : NaN;
    const std = n > 1 ? Math.sqrt(Math.max(0, (sumSq - n * mean * mean) / (n - 1))) : NaN;
    return { pv: c.pv, name: c.name, n, mean, std };
  });
}

/**
 * The readout's lines, as a figure prints them: `Δx = …  Δy = …`, then one
 * line per drawn curve, `n = …  x̄ = …  σ = …` with the y values in `unit`.
 * The curve's name leads its line when more than one curve is drawn.
 */
export function waveformMeasureLines(
  a: Annotation,
  data: WaveformDrawingData,
  opts: { unit?: string; formatSpan?: (dx: number) => string } = {}
): string[] {
  const span = spanOf(a);
  const { unit } = opts;
  const formatSpan = opts.formatSpan ?? ((dx: number) => fmtValue(Math.abs(dx)));
  const dx = span !== null && Number.isFinite(span.dx) ? formatSpan(span.dx) : READOUT_DASH;
  const curves = waveformMeasureRows(a, data);
  const rows = curves.map((r) => {
    const stats = terms(`n = ${r.n}`, term('x̄', r.mean, unit), term('σ', r.std, unit));
    return curves.length > 1 ? `${r.name}:${TERM_GAP}${stats}` : stats;
  });
  return [terms(`Δx = ${dx}`, term('Δy', span?.dy, unit)), ...rows];
}

/** Waveform's measure provider over the publish `read` returns at call time. */
export function createWaveformMeasure(read: () => WaveformDrawingData): MeasureProvider {
  return {
    card(a, ctx) {
      return waveformMeasureLines(a, read(), {
        unit: axisUnit(ctx.axis),
        formatSpan: (dx) => ctx.xAxis.formatSpan(dx),
      });
    },
  };
}

// ── Host pieces ─────────────────────────────────────────────────────────────

/** The status-line hint while the chosen X source is not drawn yet: a press places nothing. */
export const X_SOURCE_PENDING_HINT = 'Waiting for the X source — drawings place once it is drawn';

/**
 * `next` with every drawing not in `prev` (a new one) stamped with the x the
 * chart plots and, when Δ is drawn, `delta: true`. `next` itself when
 * nothing is new.
 */
export function stampNewDrawings(
  prev: readonly Annotation[],
  next: Annotation[],
  xRef: string,
  delta: boolean
): Annotation[] {
  const had = new Set(prev.map((a) => a.id));
  if (next.every((a) => had.has(a.id))) return next;
  return next.map((a) => {
    if (had.has(a.id)) return a;
    const stamped: Annotation = { ...a, xRef };
    if (delta) stamped.delta = true;
    else delete stamped.delta;
    return stamped;
  });
}
