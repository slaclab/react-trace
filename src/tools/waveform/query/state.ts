// The Waveform link format; the grammar is documented in docs/waveform.md (Link format).
//
// The state's shape, its domains and defaults, and the options the parser,
// the normalizer and the serializer take.

import type { DragMode } from '../../../plot/plotToggles';
import { defaultMetrics, type Metric } from '../../../statistics/model';
import { WAVEFORM_METRICS } from '../metrics';
import type { Catalog } from '../../../annotations/catalog/types';
import type { ShedSnapshot } from '../../../annotations/host/shedStore';
import type { Annotation } from '../../../annotations/model';

export const MAX_QUERY_BYTES = 4096;
/** Live capacity: Correlation's MAX_Y, for the same reasons. */
export const MAX_LIVE = 8;
/** Persistence cap: 8 curves × 16 trails is the render budget. */
export const MAX_PERSIST = 16;
export const MAX_AVG = 64;
export const MIN_HZ = 1;
export const MAX_HZ = 10;
export const DEFAULT_HZ = MAX_HZ;
export const DEFAULT_DEC = 4096;
export const MIN_DEC = 256;
export const MAX_DEC = 100_000;
/** The id of the Waveform's one y axis: every drawing's `axisId`, and its `ann=` axis reference. */
export const WAVEFORM_AXIS_ID = 'y';
/** Labels (legend names, the X-axis title) are capped at this many characters. */
export const MAX_LABEL_LENGTH = 80;
export const MIN_ROLL_S = 1;
export const MAX_ROLL_S = 3600;
export const DEFAULT_ROLL_S = 60;
export const MAX_SPREAD = 3;
export const MIN_WIDTH = 0.5;
export const MAX_WIDTH = 20;

export type WaveformLineType = 'line' | 'step' | 'bars' | 'points';
export const WAVEFORM_LINE_TYPES: readonly WaveformLineType[] = ['line', 'step', 'bars', 'points'];

/** Dash patterns, by Trace's wire values (`dashDot`, `dashDotDot` as in its TraceConfig). */
export type WaveformLineStyle = 'solid' | 'dashed' | 'dotted' | 'dashDot' | 'dashDotDot';
export const WAVEFORM_LINE_STYLES: readonly WaveformLineStyle[] = [
  'solid',
  'dashed',
  'dotted',
  'dashDot',
  'dashDotDot',
];

/** How the Reference is drawn (Reference › Draw as). */
export type WaveformDrawAs = 'dashed' | 'band';

/** X axis: element index, or the X-source PV when one is set and usable. */
export type WaveformXAxis = 'source' | 'index';

/**
 * A curve's pinned style fields; each absent field is automatic. Live
 * items use label, color, lineType, width, lineStyle; Reference items label,
 * color, width. A record is kept across Group moves, so no field is pruned by
 * role.
 */
export interface WaveformStyle {
  label?: string;
  color?: string;
  lineType?: WaveformLineType;
  width?: number;
  lineStyle?: WaveformLineStyle;
}

/**
 * A snapshot reference: per Live PV, the last published pre-Δ frame,
 * taken at `time` (ms since the epoch). Session data: never serialized.
 */
export interface WaveformSnapshot {
  kind: 'snapshot';
  frames: Readonly<Record<string, Float64Array>>;
  time: number;
  /** The snapshot item's own style; lives here, not in `styles`. */
  style?: WaveformStyle;
  /** Per Live PV, the per-element σ it was frozen with (from a rolling reference). */
  spread?: Readonly<Record<string, Float64Array>>;
  /** The rolling window (s) it was frozen from, when it was. */
  rolling?: number;
}

/**
 * A rolling reference: per Live PV, the per-element mean of its
 * frames over the last `seconds`, with the per-element σ as its spread. The
 * controller computes it; the state only names it. Serialized as `roll=`.
 */
export interface WaveformRolling {
  kind: 'rolling';
  seconds: number;
  /** The rolling item's own style; lives here, not in `styles`. */
  style?: WaveformStyle;
}

export type WaveformReference = { kind: 'pv'; pv: string } | WaveformSnapshot | WaveformRolling;

/** Whether a reference carries a per-element σ (the spread band and `s` can exist). */
export function referenceHasSpread(ref: WaveformReference | null): boolean {
  return ref?.kind === 'rolling' || (ref?.kind === 'snapshot' && ref.spread !== undefined);
}

/** An axis scale; absent = automatic. `auto` is present only as false, `log` only as true (Y only). */
export interface WaveformAxisScale {
  auto?: boolean;
  min?: number;
  max?: number;
  log?: boolean;
}

/** An element range, 0-based inclusive; either side may be open. */
export interface WaveformElementRange {
  first?: number;
  last?: number;
}

export interface WaveformState {
  /** Live PVs in colour order, at most 8, no duplicates. */
  pvs: string[];
  reference: WaveformReference | null;
  /** The X-source PV; '' for none (element index). */
  xs: string;
  /** The X-source item's pinned Label; absent = automatic (EGU, else "Element"). */
  xLabel?: string;
  xAxis: WaveformXAxis;
  /** Subtract reference; false whenever there is no reference. */
  delta: boolean;
  /** Overlay the last N frames, 1..16. */
  persist: number;
  /** Average over N frames, 1..64. */
  avg: number;
  /** Update-rate cap in Hz, 1..10. */
  hz: number;
  /** Element range; null = all elements. */
  elems: WaveformElementRange | null;
  /** Decimation: points drawn per curve, 0 (off) or 256..100000. */
  dec: number;
  drawAs: WaveformDrawAs;
  /** The ±kσ band around a reference with a σ: 0 (none) … 3; default 1. */
  spread: number;
  legend: boolean;
  grid: boolean;
  crosshair: boolean;
  /** The hover read-out (the chart tooltip); on by default. */
  tooltip: boolean;
  /** What a left-drag in the plot does; a zoom box by default. */
  drag: DragMode;
  /** Show statistics (the panel under the chart); off by default. */
  stats: boolean;
  /** Show distribution (the panel's density block); off by default. */
  dist: boolean;
  /** The statistics metrics in column order (metrics.ts); default `defaultMetrics(WAVEFORM_METRICS)`. */
  metrics: Metric[];
  /** The Live axis scale; absent = automatic. */
  yScale?: WaveformAxisScale;
  /** The X axis scale (never `log`); absent = automatic. */
  xScale?: WaveformAxisScale;
  /** Hidden curves (present = hidden), Live and Reference PVs only. */
  hidden: Record<string, true>;
  /** Pinned styles by PV, Live and Reference PVs only. */
  styles: Record<string, WaveformStyle>;
  /** The plot's drawings, validated against the plot's catalog; written as `ann=`. */
  drawings: Annotation[];
}

/** What the parser, the normalizer and the serializer validate drawings against. */
export interface WaveformQueryOptions {
  /** The plot's drawing catalog; default {@link WAVEFORM_CATALOG}. */
  catalog?: Catalog;
}

/** Serializer options: the catalog, and the bytes the page keys will add. */
export interface WaveformSerializeOptions extends WaveformQueryOptions {
  /**
   * Bytes the state-out step adds for the page keys (`theme`, `embedded` and
   * their `&`), so a link carrying drawings still fits once they are added.
   * Only the drawing steps use it; default 0.
   */
  reserve?: number;
}

/** A serialized query, and what of the drawings it could not carry. */
export interface WaveformShedQuery {
  query: string;
  shed: ShedSnapshot;
}

export function defaultWaveformState(): WaveformState {
  return {
    pvs: [],
    reference: null,
    xs: '',
    xAxis: 'source',
    delta: false,
    persist: 1,
    avg: 1,
    hz: DEFAULT_HZ,
    elems: null,
    dec: DEFAULT_DEC,
    drawAs: 'dashed',
    spread: 1,
    legend: true,
    grid: true,
    crosshair: false,
    tooltip: true,
    drag: 'zoom',
    stats: false,
    dist: false,
    metrics: defaultMetrics(WAVEFORM_METRICS),
    hidden: {},
    styles: {},
    drawings: [],
  };
}
