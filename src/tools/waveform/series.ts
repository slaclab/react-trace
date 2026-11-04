// The Waveform chart's series: what each curve, trail, held shot, reference
// and band draws, the shared dataset columns, and the ECharts series object of
// each. The rules are listed in plotOption.ts.

import { echartsLineType } from '../../curveStyle';
import type { ReadoutDock } from '../../plot/readoutDock';
import { decimateInto, decimateXInto, freshIndex, hasNaN, WaveformPlotBuffers } from './decimate';
import { elementSpan, type ElementSpan } from './frames';
import type { WaveformModel } from './model';
import type { WaveformLineStyle, WaveformLineType, WaveformState, WaveformStyle } from './query';
import { referenceFor, referenceSuffix, type ReferenceFrames } from './reference';
import { autoYColor } from '../shared/colors';
import type { ChartDrawingTheme } from '../../annotationTheme';

/** Minmax sampling starts at this multiple of the plot's device-pixel width. */
export const SAMPLING_FACTOR = 2.5;
export const REF_ID = 'ref';
export const X_COLUMN = 'x';
const DEFAULT_WIDTH = 1.5;
const POINT_SIZE = 3;
/** Trail opacity: the newest trail is TRAIL_OPACITY, older ones fade toward 0. */
const TRAIL_OPACITY = 0.6;
const HELD_OPACITY = 0.8;
const BAND_OPACITY = 0.2;

export function liveId(pv: string): string {
  return `live:${pv}`;
}
export function trailId(pv: string, age: number): string {
  return `trail:${age}:${pv}`;
}
/** A frozen shot's id (Freeze this shot). */
export function heldId(pv: string): string {
  return `held:${pv}`;
}
/** A snapshot or rolling entry's id; the PV reference is REF_ID. */
export function refId(pv: string): string {
  return `ref:${pv}`;
}
/** The spread band's two stacked series per curve: the lower edge and the height. */
export function bandId(pv: string, part: 'lo' | 'hi'): string {
  return `band:${part}:${pv}`;
}
const BAND_SPREAD_OPACITY = 0.18;

/** One live curve as the controller published it. */
export interface WaveformCurveFrames {
  /** The published pre-Δ frame at full range (the ring mean when averaging). */
  frame: Float64Array;
  /**
   * Earlier frames to overlay, oldest first, as the ring stores them — not
   * including `frame`. The newest `persist − 1` are drawn.
   */
  trails?: readonly Float64Array[];
}

export interface WaveformPlotFrames extends ReferenceFrames {
  live: Readonly<Record<string, WaveformCurveFrames | undefined>>;
  /** A frozen shot, per live PV: drawn dotted beside the live curve until released. */
  held?: Readonly<Record<string, Float64Array>>;
  /** The X source's frame. */
  x: Float64Array | null;
}

export interface WaveformPlotInput {
  state: WaveformState;
  model: WaveformModel;
  frames: WaveformPlotFrames;
  /** The plot's width in device pixels (CSS width × devicePixelRatio). */
  widthPx: number;
  /** Device pixels per CSS pixel (devicePixelRatio), for the trail hairline; 1 when absent. */
  pixelRatio?: number;
  theme: ChartDrawingTheme;
  /** Reusable arrays for Δ, decimation and the index column; absent = fresh arrays. */
  buffers?: WaveformPlotBuffers;
  /** The read-out dock (the plot's): the tooltip docks in a free corner and its grip moves it. */
  readoutDock?: ReadoutDock;
}

function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

/** What a series draws before the dataset is assembled. */
export interface Drawn {
  id: string;
  name: string;
  color: string;
  kind: 'live' | 'trail' | 'ref' | 'band-lo' | 'band-hi';
  pv: string | null;
  lineType: WaveformLineType;
  width: number;
  lineStyle: WaveformLineStyle;
  band: boolean;
  opacity: number;
  /** Full-range array (after Δ). */
  values: Float64Array;
}

// The layout every column shares: element span, x column, decimation.
export interface Columns {
  span: ElementSpan;
  /** The x column as drawn (decimated when bucketing). */
  x: Float64Array;
  /** The x column over the element range, before decimation. */
  rangedX: Float64Array;
  /** Bucket count when decimating, else 0. */
  buckets: number;
}

/** Whether the chart plots the X source's column: chosen, usable and its frame published. */
function plotsXSource(model: WaveformModel, frames: Pick<WaveformPlotFrames, 'x'>): boolean {
  return model.xAxis.mode === 'source' && frames.x !== null;
}

/**
 * The x the chart actually plots: `src:<pv>` when it plots the X
 * source's column, else `index` — including source mode whose frame has not
 * arrived. Same predicate as the chart's x column, so a drawing bound to it
 * hides exactly when the plotted x differs.
 */
export function renderedXSource(
  model: WaveformModel,
  frames: Pick<WaveformPlotFrames, 'x'>
): string {
  const pv = model.x?.pv;
  return plotsXSource(model, frames) && pv ? `src:${pv}` : 'index';
}

export function columns(input: WaveformPlotInput, drawn: readonly Drawn[]): Columns {
  const { state, model, frames, buffers } = input;
  const useSource = plotsXSource(model, frames);
  const len = useSource
    ? frames.x!.length
    : drawn.reduce((m, d) => Math.max(m, d.values.length), 0);
  const span = elementSpan(len, state.elems);
  const n = span.end - span.start;
  let x: Float64Array;
  if (useSource) {
    x = span.start === 0 && span.end === len ? frames.x! : frames.x!.subarray(span.start, span.end);
  } else {
    x = buffers ? buffers.index('index', span.start, n) : freshIndex(span.start, n);
  }
  const buckets = state.dec > 0 && n > state.dec ? Math.floor(state.dec / 2) : 0;
  if (buckets > 0) {
    const outX = buffers ? buffers.get('dec:x', 2 * buckets) : new Float64Array(2 * buckets);
    // x positions only; the y slot is a throwaway.
    decimateXInto(x, buckets, outX);
    return { span, x: outX, rangedX: x, buckets };
  }
  return { span, x, rangedX: x, buckets: 0 };
}

/** The column a series draws: ranged view, then decimated into a buffer. */
export function columnOf(
  d: Drawn,
  c: Columns,
  buffers: WaveformPlotBuffers | undefined
): Float64Array {
  const { start, end } = c.span;
  const full = d.values;
  const stop = Math.min(end, full.length);
  const ranged =
    start === 0 && stop === full.length ? full : full.subarray(Math.min(start, stop), stop);
  if (c.buckets === 0) return ranged;
  const out = buffers ? buffers.get(`dec:${d.id}`, 2 * c.buckets) : new Float64Array(2 * c.buckets);
  decimateInto(ranged, c.rangedX, c.buckets, out, null);
  return out;
}

function delta(
  live: Float64Array,
  ref: Float64Array,
  key: string,
  buffers: WaveformPlotBuffers | undefined
): Float64Array | null {
  if (live.length !== ref.length) return null;
  const out = buffers ? buffers.get(key, live.length) : new Float64Array(live.length);
  for (let i = 0; i < live.length; i++) out[i] = live[i] - ref[i];
  return out;
}

function styleOf(state: WaveformState, pv: string): WaveformStyle {
  return own(state.styles, pv) ?? {};
}

export function drawnSeries(input: WaveformPlotInput): Drawn[] {
  const { state, model, frames, buffers, theme } = input;
  const out: Drawn[] = [];
  const ratio = input.pixelRatio !== undefined && input.pixelRatio > 0 ? input.pixelRatio : 1;
  const hairline = 1 / ratio;
  const ref = state.reference;
  const xLen = model.xAxis.mode === 'source' ? model.xAxis.length : null;
  const fits = (a: Float64Array) => xLen === null || a.length === xLen;
  const liveColor = (pv: string) => styleOf(state, pv).color ?? autoYColor(state.pvs.indexOf(pv));
  const labelOf = (pv: string) => styleOf(state, pv).label || pv;

  // Reference first, so it draws behind the live curves.
  if (ref !== null && model.reference?.drawable) {
    const band = state.drawAs === 'band';
    if (ref.kind === 'pv' && frames.reference !== null && fits(frames.reference)) {
      const st = styleOf(state, ref.pv);
      out.push({
        id: REF_ID,
        name: st.label || ref.pv,
        color: st.color ?? theme.axisLabel,
        kind: 'ref',
        pv: ref.pv,
        lineType: 'line',
        width: st.width ?? DEFAULT_WIDTH,
        lineStyle: 'dashed',
        band,
        opacity: 1,
        values: frames.reference,
      });
    } else if (ref.kind === 'snapshot' || ref.kind === 'rolling') {
      // A snapshot or a rolling reference: one entry per curve, in its colour.
      const st = ref.style ?? {};
      const suffix = referenceSuffix(state);
      for (const row of model.live) {
        const entry = referenceFor(state, frames, row.pv)?.values;
        if (entry === undefined || row.hidden || row.status === 'refused' || !fits(entry)) continue;
        out.push({
          id: refId(row.pv),
          name: st.label || `${labelOf(row.pv)} ${suffix}`,
          color: st.color ?? liveColor(row.pv),
          kind: 'ref',
          pv: row.pv,
          lineType: 'line',
          width: st.width ?? DEFAULT_WIDTH,
          lineStyle: 'dashed',
          band,
          opacity: 1,
          values: entry,
        });
      }
    }
  }

  const deltaOn = model.delta.on && ref !== null;
  const refFor = (pv: string): Float64Array | null =>
    referenceFor(state, frames, pv)?.values ?? null;

  // The spread band: reference ± kσ per drawn curve, around zero in Δ.
  // Both edges are absolute here; the stacked height is derived after the
  // columns are decimated, so the drawn top edge is the decimated upper edge.
  // A stack cannot place a lower edge at or below zero on a log axis: no band there.
  const k = state.spread;
  if (ref !== null && k > 0 && state.yScale?.log !== true) {
    for (const row of model.live) {
      if (!row.drawable) continue;
      const curve = own(frames.live, row.pv);
      const r = referenceFor(state, frames, row.pv);
      if (curve === undefined || r === null || r.spread === null) continue;
      const { values, spread } = r;
      const n = spread.length;
      if (values.length !== n || curve.frame.length !== n || !fits(spread)) continue;
      const lo = buffers ? buffers.get(bandId(row.pv, 'lo'), n) : new Float64Array(n);
      const hi = buffers ? buffers.get(bandId(row.pv, 'hi'), n) : new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const half = k * spread[i];
        const centre = deltaOn ? 0 : values[i];
        lo[i] = centre - half;
        hi[i] = centre + half;
      }
      const base = {
        name: `${labelOf(row.pv)} ±${k}σ`,
        color: liveColor(row.pv),
        pv: row.pv,
        lineType: 'line' as const,
        width: 0,
        lineStyle: 'solid' as const,
        band: false,
        opacity: 0,
      };
      out.push({ ...base, id: bandId(row.pv, 'lo'), kind: 'band-lo', values: lo });
      out.push({ ...base, id: bandId(row.pv, 'hi'), kind: 'band-hi', values: hi });
    }
  }

  for (const row of model.live) {
    if (!row.drawable) continue;
    const curve = own(frames.live, row.pv);
    if (curve === undefined) continue;
    const st = styleOf(state, row.pv);
    const lineType = st.lineType ?? 'line';
    const base = {
      name: labelOf(row.pv),
      color: liveColor(row.pv),
      pv: row.pv,
      lineType,
      width: st.width ?? DEFAULT_WIDTH,
      lineStyle: st.lineStyle ?? 'solid',
      band: false,
    } as const;
    const against = deltaOn ? refFor(row.pv) : null;
    if (deltaOn && against === null) continue;
    const prepare = (a: Float64Array, key: string): Float64Array | null =>
      against === null ? a : delta(a, against, `delta:${key}`, buffers);

    // Trails: never for bars; the newest persist − 1, oldest drawn first.
    const trails = lineType === 'bars' ? [] : (curve.trails ?? []);
    const count = Math.min(trails.length, Math.max(0, state.persist - 1));
    for (let age = count; age >= 1; age--) {
      const id = trailId(row.pv, age);
      const values = prepare(trails[trails.length - age], id);
      if (values === null || !fits(values)) continue;
      out.push({
        ...base,
        id,
        kind: 'trail',
        width: Math.min(base.width, hairline),
        opacity: (TRAIL_OPACITY * (count - age + 1)) / count,
        values,
      });
    }
    // A frozen shot: the curve's colour, dotted, under the live curve.
    const heldFrame = lineType === 'bars' || !frames.held ? undefined : own(frames.held, row.pv);
    if (heldFrame !== undefined) {
      const hid = heldId(row.pv);
      const values = prepare(heldFrame, hid);
      if (values !== null && fits(values)) {
        out.push({
          ...base,
          id: hid,
          kind: 'trail',
          lineStyle: 'dotted',
          opacity: HELD_OPACITY,
          values,
        });
      }
    }
    const id = liveId(row.pv);
    const values = prepare(curve.frame, id);
    if (values === null || !fits(values)) continue;
    out.push({ ...base, id, kind: 'live', opacity: 1, values });
  }
  return out;
}

export type Series = Record<string, unknown>;

export function seriesOf(d: Drawn, column: Float64Array, widthPx: number): Series {
  const common: Series = {
    id: d.id,
    name: d.name,
    color: d.color,
    datasetIndex: 0,
    encode: { x: X_COLUMN, y: d.id },
    animation: false,
  };
  const sampled = column.length >= SAMPLING_FACTOR * widthPx && !hasNaN(column);
  if (d.lineType === 'bars') {
    return {
      ...common,
      type: 'bar',
      large: true,
      largeThreshold: 1,
      // Progressive rendering paints a large bar series over several frames
      // and restarts on every new option, so at a 10 Hz stream no frame ever
      // completes (`finished` never fires). Draw each publish in one pass.
      progressive: 0,
      barGap: '-100%',
      itemStyle: { opacity: d.opacity },
      ...(sampled ? { sampling: 'minmax' } : {}),
    };
  }
  if (d.kind === 'band-lo' || d.kind === 'band-hi') {
    // Two stacked lines: an invisible lower edge and the band's height, filled.
    return {
      ...common,
      type: 'line',
      stack: `band:${d.pv}`,
      showSymbol: false,
      silent: true,
      tooltip: { show: false },
      lineStyle: { width: 0, opacity: 0 },
      ...(d.kind === 'band-hi' ? { areaStyle: { opacity: BAND_SPREAD_OPACITY } } : {}),
      // No per-series sampling: the two edges must stay paired element by element.
    };
  }
  if (d.lineType === 'points') {
    return {
      ...common,
      type: 'scatter',
      symbolSize: Math.max(POINT_SIZE, d.width * 2),
      itemStyle: { opacity: d.opacity },
    };
  }
  return {
    ...common,
    type: 'line',
    step: d.lineType === 'step' ? 'middle' : false,
    showSymbol: false,
    lineStyle: {
      width: d.band ? 0 : d.width,
      type: echartsLineType(d.lineStyle),
      opacity: d.opacity,
    },
    ...(d.band ? { areaStyle: { opacity: BAND_OPACITY } } : {}),
    ...(sampled ? { sampling: 'minmax' } : {}),
  };
}
