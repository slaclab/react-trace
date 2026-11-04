// The correlation plot's query grammar: what a host page (the CANOPY
// workspace), a saved view, a link or a host default opens the plot with,
// and what the plot reports back.
//
//   x=<pv>               the X PV
//   y=<pv> (x1..8)       Y PVs in colour order; duplicates dropped, Y = X allowed
//   trig=<pv>            sample on each update of this PV (Trigger PV mode)
//   dt=<seconds >= 0.1>  sample on a timer (Timer mode); `trig` wins if both
//   n=<1..10000>         rows kept (default 1000)
//   lookback=<span>      Trace's span syntax ("30m", "1.5h"), clamped to [1m, 24h]
//   view=scatter|density
//   axes=shared|overlay|split
//                        how the scatter lays out its Y: one shared Y axis
//                        (default), one axis per Y overlapping in one plot, or
//                        one panel per Y; the density view ignores it
//   dy=<pv>              the Y PV the density view shows (default: the first Y)
//
// Every later setting is a flat key with its default omitted.
// <i> is a Y's 1-based position among the written `y=` keys.
//
//   xl=<text>            the X's label (the X-axis title)
//   l<i>=<text>          Y i's label (legend name)
//   c<i>=<colour>        Y i's pinned colour
//   m<i>=<shape>,<size>,<opacity>
//                        Y i's pinned marker fields; an absent field is empty
//                        ("m2=diamond,,0.5")
//   hide=<i>,<i>...      the hidden Ys
//   fire=rising|falling  Trigger edge, Trigger PV mode only (absent: Every update)
//   fit=0  readout=0  dist=1  legend=0  grid=0  cross=1  fade=1  tip=0
//                        the tool-level toggles, written only off their default
//                        (`tip` is the hover read-out, on by default)
//   drag=pan             a left-drag in the plot pans (default: draws a zoom box)
//   m=<token>            one statistics metric (repeated, in column order):
//                        a preset id or a custom "label=expr[=unit]", with a
//                        leading "-" when it is not a table column and "~"
//                        when it is a strip chart (metrics.ts)
//   xauto=0 xmin=<n> xmax=<n> xlog=1
//   yauto=0 ymin=<n> ymax=<n> ylog=1
//                        the X and the (every) Y axis scale; each key present
//                        iff its field is
//   ann=<json>           the drawings, through the shared context codec
//                        (annotations/contextLink.ts): each drawing's axis and
//                        magnet trace are named by Y PV in the reference
//                        table, so a drawing survives its Y's removal
//
// The per-PV keys are the projection of the sparse records: a key is
// written iff its record exists, whatever its value (a label equal to the PV
// name, a colour equal to the positional one), and parsing creates a record
// for every key present.
//
// URL-encoded, no leading "?", at most 4 KB. Neither `trig` nor `dt` means
// Timer 1 s. Unknown keys are ignored; invalid values fall back to their
// defaults, with one console warning per parse naming every key that did.
// The serializer writes only the active trigger mode's key, and `axes` only
// when it is not the default (as `dy` and every key above), so queries saved
// before they existed serialize unchanged. The `m` keys are written only when
// the metric list differs from the default, and then all of them (any `m` key
// present means the list is exactly the decoded tokens). Over 4 KB it sheds, in
// this order: labels (`l<i>` from the last Y, then `xl`), then colours and
// markers (`c<i>`/`m<i>` from the last Y), then `hide`, then every `m` key (the
// metrics reopen at the default), then the drawings (note texts trimmed, then
// drawings dropped from the end, leaving room for the page keys the state-out
// step adds), and only then trailing Ys. A query carrying `ann` that is over
// 4 KB on arrival is read without its drawings when that fits.
//
// This module is the only parser of the grammar. Both functions are pure apart
// from the warnings.
//
// It also owns the state's shape and its defaults. Per-PV settings live
// in sparse records keyed by PV — `labels`, `colors`, `hidden`, `markers` — and
// a record is present iff the setting is pinned; absent means automatic.
// `normalizeCorrelationState` is the one canonical form: it runs at the end of
// every parse and every edit, and prunes each record to the roles that show its
// field: a label on the X and the Ys, a colour, visibility and marker on
// the Ys only, nothing on the Trigger.

import { parseSpanMs } from '../../api/time';
import { isColorLiteral } from '../../annotationTheme';
import { isDragMode, type DragMode } from '../../plot/plotToggles';
import { CORRELATION_CATALOG } from '../../annotations/catalog';
import type { Catalog } from '../../annotations/catalog/types';
import { VALUE_X_AXIS } from '../../annotations/catalog/xAxis';
import {
  decodeContextDrawings,
  encodeContextDrawings,
  fitContextDrawings,
  withoutContextDrawings,
  type ContextCodecOptions,
} from '../../annotations/contextLink';
import { encodeJsonParam } from '../../annotations/config';
import type { ShedSnapshot } from '../../annotations/host/shedStore';
import { validateAnnotationIn, type Annotation } from '../../annotations/model';
import { CORRELATION_METRICS } from './metrics';
import {
  decodeMetricToken,
  defaultMetrics,
  encodeMetricToken,
  metricsAreDefault,
  nextCustomId,
  normalizeMetrics,
  type Metric,
} from '../../statistics/model';

export const MAX_QUERY_BYTES = 4096;
export const MAX_Y = 8;
export const DEFAULT_N = 1000;
export const MAX_N = 10_000;
export const DEFAULT_DT_S = 1;
export const MIN_DT_S = 0.1;
export const DEFAULT_LOOKBACK = '1h';

const MIN_LOOKBACK_MS = 60 * 1000;
const MAX_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const MIN_LOOKBACK = '1m';
const MAX_LOOKBACK = '24h';

export type CorrelationView = 'scatter' | 'density';

/** The scatter's Y layout. */
export type CorrelationAxes = 'shared' | 'overlay' | 'split';
export const CORRELATION_AXES: readonly CorrelationAxes[] = ['shared', 'overlay', 'split'];
export const DEFAULT_AXES: CorrelationAxes = 'shared';

function isAxes(v: unknown): v is CorrelationAxes {
  return (CORRELATION_AXES as readonly unknown[]).includes(v);
}

// How rows are sampled: on every update of a trigger PV, or every `dtS` seconds.
export type CorrelationTrigger = { mode: 'pv'; pv: string } | { mode: 'timer'; dtS: number };

/** Which trigger-PV updates take a row; absent means Every update. */
export type CorrelationFire = 'rising' | 'falling';
export const CORRELATION_FIRE: readonly CorrelationFire[] = ['rising', 'falling'];

/** Labels (Y legend names, the X-axis title) are capped at this many characters. */
export const MAX_LABEL_LENGTH = 80;

/** ECharts' built-in symbols a Y marker may take. */
export type MarkerShape =
  | 'circle'
  | 'rect'
  | 'roundRect'
  | 'triangle'
  | 'diamond'
  | 'pin'
  | 'arrow';
export const MARKER_SHAPES: readonly MarkerShape[] = [
  'circle',
  'rect',
  'roundRect',
  'triangle',
  'diamond',
  'pin',
  'arrow',
];
export const MIN_MARKER_SIZE = 1;
export const MAX_MARKER_SIZE = 40;

/** A Y's marker as drawn when it has no record (today's scatter: ECharts' scatter defaults, size 5). */
export const DEFAULT_MARKER: Readonly<Required<CorrelationMarker>> = Object.freeze({
  shape: 'circle',
  size: 5,
  opacity: 0.8,
});

/** A Y's pinned marker fields; each absent field draws its `DEFAULT_MARKER` value. */
export interface CorrelationMarker {
  shape?: MarkerShape;
  /** Symbol size in px, within [1, 40]. */
  size?: number;
  /** Within [0, 1]. */
  opacity?: number;
}

/**
 * A section's axis scale (Section › Axis); the state holds one for X and
 * one for every Y axis (overlay and split included). Absent = automatic. In
 * canonical form `auto` is present only as `false` and `log` only as `true`;
 * `min`/`max` apply only when `auto` is false and are kept otherwise, so
 * toggling Auto-scale back off restores them.
 */
export interface CorrelationAxisScale {
  auto?: boolean;
  min?: number;
  max?: number;
  log?: boolean;
}

export interface CorrelationState {
  /** The X PV; '' while none is chosen. */
  x: string;
  /** Y PVs in colour order, at most 8, no duplicates. */
  ys: string[];
  trigger: CorrelationTrigger;
  /** Rows kept, 1..10000. */
  n: number;
  /** Lookback in Trace's span syntax, within [1m, 24h]. */
  lookback: string;
  view: CorrelationView;
  /** The scatter's Y layout. */
  axes: CorrelationAxes;
  /** The Y PV the density view shows; '' means the first Y. */
  dy: string;
  /** Pinned labels by PV: a Y's legend name, the X's axis title. X and Ys only. */
  labels: Record<string, string>;
  /** Pinned colours by Y PV; absent = `Y_COLORS[position in ys]` (see colors.ts). */
  colors: Record<string, string>;
  /** Hidden Ys (present = hidden). Ys only. */
  hidden: Record<string, true>;
  /** Pinned marker fields by Y PV. Ys only. */
  markers: Record<string, CorrelationMarker>;
  /** Draw each Y's least-squares fit line (on by default, as drawn today). */
  fit: boolean;
  /** Show statistics (the readout table and the strips); off by default. */
  readout: boolean;
  /** Show distribution (the panel's density block); off by default. */
  dist: boolean;
  legend: boolean;
  /** X/Y gridlines. */
  grid: boolean;
  crosshair: boolean;
  /** Fade older points (colour by age). */
  fade: boolean;
  /** The hover read-out (the chart tooltip); on by default. */
  tooltip: boolean;
  /** What a left-drag in the plot does; a zoom box by default. */
  drag: DragMode;
  /** Trigger edge, PV mode only; absent = Every update. */
  fire?: CorrelationFire;
  /** The X axis scale; absent = automatic. */
  xScale?: CorrelationAxisScale;
  /** The scale of every Y axis; absent = automatic. */
  yScale?: CorrelationAxisScale;
  /** The statistics metrics in column order (metrics.ts); default `defaultMetrics(CORRELATION_METRICS)`. */
  metrics: Metric[];
  /**
   * The plot's drawings, in creation order; `axisId` and `traceId` are Y
   * PVs. A drawing of a Y no longer in `ys` is kept.
   */
  drawings: Annotation[];
}

export function defaultCorrelationState(): CorrelationState {
  return {
    x: '',
    ys: [],
    trigger: { mode: 'timer', dtS: DEFAULT_DT_S },
    n: DEFAULT_N,
    lookback: DEFAULT_LOOKBACK,
    view: 'scatter',
    axes: DEFAULT_AXES,
    dy: '',
    labels: {},
    colors: {},
    hidden: {},
    markers: {},
    fit: true,
    readout: false,
    dist: false,
    legend: true,
    grid: true,
    crosshair: false,
    fade: false,
    tooltip: true,
    drag: 'zoom',
    metrics: defaultMetrics(CORRELATION_METRICS),
    drawings: [],
  };
}

function own<T>(record: Record<string, T> | undefined, key: string): T | undefined {
  return record !== undefined && Object.prototype.hasOwnProperty.call(record, key)
    ? record[key]
    : undefined;
}

// A sparse record kept only at `keys`, each value mapped through `keep`
// (undefined drops the entry). Keys follow `keys` order, so the result does not
// depend on the order edits wrote them.
function pruned<T, U>(
  record: Record<string, T> | undefined,
  keys: readonly string[],
  keep: (value: T) => U | undefined
): Record<string, U> {
  const out: Record<string, U> = {};
  for (const key of keys) {
    const value = own(record, key);
    if (value === undefined) continue;
    const kept = keep(value);
    if (kept !== undefined) out[key] = kept;
  }
  return out;
}

function normalizeLabel(value: unknown): string | undefined {
  return typeof value === 'string' ? [...value].slice(0, MAX_LABEL_LENGTH).join('') : undefined;
}

// A colour from the link reaches chart options and statistics-row styles, so
// only a plain colour literal is kept; anything else is an invalid `c<i>`.
function normalizeColor(value: unknown): string | undefined {
  const color = typeof value === 'string' ? value.trim() : undefined;
  return isColorLiteral(color) ? color : undefined;
}

function isMarkerShape(v: unknown): v is MarkerShape {
  return (MARKER_SHAPES as readonly unknown[]).includes(v);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function normalizeMarker(value: CorrelationMarker): CorrelationMarker | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const out: CorrelationMarker = {};
  if (isMarkerShape(value.shape)) out.shape = value.shape;
  if (typeof value.size === 'number' && Number.isFinite(value.size)) {
    out.size = clamp(value.size, MIN_MARKER_SIZE, MAX_MARKER_SIZE);
  }
  if (typeof value.opacity === 'number' && Number.isFinite(value.opacity)) {
    out.opacity = clamp(value.opacity, 0, 1);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeScale(value: CorrelationAxisScale | undefined): CorrelationAxisScale | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const out: CorrelationAxisScale = {};
  if (value.auto === false) out.auto = false;
  if (typeof value.min === 'number' && Number.isFinite(value.min)) out.min = value.min;
  if (typeof value.max === 'number' && Number.isFinite(value.max)) out.max = value.max;
  if (value.log === true) out.log = true;
  return Object.keys(out).length > 0 ? out : undefined;
}

// Structural equality of plain data, key order included (the canonical form
// fixes key order, so a reordered record is a change).
function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return false;
    const key = ka[i];
    if (!sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) {
      return false;
    }
  }
  return true;
}

/**
 * The drawings validated against `catalog`: a drawing of a kind the
 * catalog lacks, or malformed, is dropped; a drawing whose validated form
 * equals it keeps its reference, and with no element changed the list itself
 * is returned. Drawings are never pruned by Y: a drawing of a removed Y stays.
 */
function normalizeDrawings(
  list: readonly Annotation[] | undefined,
  catalog: Catalog
): Annotation[] {
  if (!Array.isArray(list)) return [];
  let changed = false;
  const out: Annotation[] = [];
  for (const a of list) {
    const valid = validateAnnotationIn(catalog, a, VALUE_X_AXIS, 'Correlation');
    if (valid === null) changed = true;
    else if (sameValue(a, valid)) out.push(a);
    else {
      changed = true;
      out.push(valid);
    }
  }
  return changed ? out : (list as Annotation[]);
}

/**
 * The canonical form of a state, applied at the end of every parse and
 * every edit; pure and idempotent. Ys are trimmed, deduplicated and capped at
 * `MAX_Y`; `dy` not among them falls back to ''. Each per-PV record is pruned
 * to the roles that show its field — labels to the X and the Ys, colours,
 * `hidden` and markers to the Ys, nothing for the Trigger — labels are
 * capped at 80 characters, an empty marker or axis scale is dropped,
 * `fire` is dropped outside Trigger PV mode, the metric list goes through
 * `normalizeMetrics`, and the drawings are validated against `catalog`.
 *
 * Reference-preserving: each field structurally equal to the input's
 * keeps the input's reference, so a drawing commit leaves every other field
 * alone and a settings edit leaves `drawings` alone.
 */
export function normalizeCorrelationState(
  state: CorrelationState,
  catalog: Catalog = CORRELATION_CATALOG
): CorrelationState {
  const defaults = defaultCorrelationState();
  const x = state.x.trim();
  const ys: string[] = [];
  for (const raw of state.ys) {
    const y = raw.trim();
    if (y === '' || ys.includes(y) || ys.length === MAX_Y) continue;
    ys.push(y);
  }
  const labelled = x === '' ? ys : [x, ...ys.filter((y) => y !== x)];
  const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);

  const next: CorrelationState = {
    x,
    ys,
    trigger: state.trigger,
    n: state.n,
    lookback: state.lookback,
    view: state.view,
    axes: state.axes,
    dy: ys.includes(state.dy) ? state.dy : '',
    labels: pruned(state.labels, labelled, normalizeLabel),
    colors: pruned(state.colors, ys, normalizeColor),
    hidden: pruned(state.hidden, ys, (v) => (v === true ? (true as const) : undefined)),
    markers: pruned(state.markers, ys, normalizeMarker),
    fit: bool(state.fit, defaults.fit),
    readout: bool(state.readout, defaults.readout),
    dist: bool(state.dist, defaults.dist),
    legend: bool(state.legend, defaults.legend),
    grid: bool(state.grid, defaults.grid),
    crosshair: bool(state.crosshair, defaults.crosshair),
    fade: bool(state.fade, defaults.fade),
    tooltip: bool(state.tooltip, defaults.tooltip),
    drag: isDragMode(state.drag) ? state.drag : defaults.drag,
    metrics: normalizeMetrics(CORRELATION_METRICS, state.metrics),
    drawings: normalizeDrawings(state.drawings, catalog),
  };
  if (state.trigger.mode === 'pv' && CORRELATION_FIRE.includes(state.fire as CorrelationFire)) {
    next.fire = state.fire;
  }
  const xScale = normalizeScale(state.xScale);
  if (xScale !== undefined) next.xScale = xScale;
  const yScale = normalizeScale(state.yScale);
  if (yScale !== undefined) next.yScale = yScale;

  return keepCorrelationReferences(state, next);
}

/**
 * `next` with every field structurally equal to `prev`'s replaced by `prev`'s
 * reference, mutating and returning `next`; for `drawings` each equal
 * element keeps `prev`'s, and the whole list does when every element does.
 * `apply` runs it against the state before the edit, so a writer that
 * rebuilds an equal list still leaves `drawings` alone.
 */
export function keepCorrelationReferences(
  prev: CorrelationState,
  next: CorrelationState
): CorrelationState {
  const before = prev as unknown as Record<string, unknown>;
  const out = next as unknown as Record<string, unknown>;
  for (const key of Object.keys(out)) {
    if (out[key] !== before[key] && sameValue(before[key], out[key])) out[key] = before[key];
  }
  const was: readonly Annotation[] | undefined = prev.drawings;
  if (next.drawings !== was && Array.isArray(was)) {
    const list = next.drawings.map((a, i) => (a !== was[i] && sameValue(was[i], a) ? was[i] : a));
    next.drawings =
      list.length === was.length && list.every((a, i) => a === was[i])
        ? (was as Annotation[])
        : list;
  }
  return next;
}

// The lookback of a state in milliseconds (its span is valid by construction).
export function lookbackMs(state: CorrelationState): number {
  return parseSpanMs(state.lookback) ?? (parseSpanMs(DEFAULT_LOOKBACK) as number);
}

// The PV the density view shows: `dy`, else the first Y; '' with no Y.
export function densityY(state: CorrelationState): string {
  return state.dy !== '' ? state.dy : (state.ys[0] ?? '');
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

function pvName(raw: string): string | null {
  const name = raw.trim();
  return name === '' ? null : name;
}

// A lookback span, whitespace removed and clamped; null when not a span.
function normalizeLookback(raw: string): string | null {
  const span = raw.replace(/\s+/g, '');
  const ms = parseSpanMs(span);
  if (ms === null) return null;
  if (ms < MIN_LOOKBACK_MS) return MIN_LOOKBACK;
  if (ms > MAX_LOOKBACK_MS) return MAX_LOOKBACK;
  return span;
}

function parseN(raw: string): number | null {
  if (!/^\d+$/.test(raw.trim())) return null;
  const n = Number(raw.trim());
  return n >= 1 && n <= MAX_N ? n : null;
}

function parseDt(raw: string): number | null {
  const text = raw.trim();
  if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
  const dt = Number(text);
  return Number.isFinite(dt) && dt >= MIN_DT_S ? dt : null;
}

function warnInvalid(invalid: string[], what: string): void {
  if (invalid.length === 0) return;
  console.warn(
    `Correlation ${what} has invalid ${invalid.join(', ')}; using the defaults for them.`
  );
}

// The 1-based position <i> of a per-Y key ("l3" -> 3), or null.
function yIndex(key: string, prefix: string): number | null {
  const m = new RegExp(`^${prefix}([1-9]\\d{0,2})$`).exec(key);
  return m === null ? null : Number(m[1]);
}

function parseFlag(raw: string): boolean | null {
  return raw === '1' ? true : raw === '0' ? false : null;
}

function parseNumber(raw: string): number | null {
  const text = raw.trim();
  if (text === '') return null;
  const v = Number(text);
  return Number.isFinite(v) ? v : null;
}

// "<shape>,<size>,<opacity>", each part optional; null when any part is bad.
function parseMarker(raw: string): CorrelationMarker | null {
  const parts = raw.split(',');
  if (parts.length > 3) return null;
  const [shape = '', size = '', opacity = ''] = parts.map((p) => p.trim());
  const out: CorrelationMarker = {};
  if (shape !== '') {
    if (!isMarkerShape(shape)) return null;
    out.shape = shape;
  }
  if (size !== '') {
    const v = parseNumber(size);
    if (v === null) return null;
    out.size = v;
  }
  if (opacity !== '') {
    const v = parseNumber(opacity);
    if (v === null) return null;
    out.opacity = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

// The tool-level toggles: query key, state field. Written only off their default.
const TOGGLE_KEYS = [
  ['fit', 'fit'],
  ['readout', 'readout'],
  ['dist', 'dist'],
  ['legend', 'legend'],
  ['grid', 'grid'],
  ['cross', 'crosshair'],
  ['fade', 'fade'],
  ['tip', 'tooltip'],
] as const;

// The per-PV records, the toggles, the metrics, `fire` and the axis scales
// (parse side).
// Runs after `ys` and the trigger are settled, since <i> indexes the Ys.
function parseSettings(params: URLSearchParams, state: CorrelationState, invalid: string[]): void {
  const seen = new Set<string>();
  for (const key of params.keys()) {
    if (seen.has(key)) continue;
    seen.add(key);
    const value = params.get(key) as string;
    for (const prefix of ['l', 'c', 'm'] as const) {
      const i = yIndex(key, prefix);
      if (i === null) continue;
      const y = state.ys[i - 1];
      if (y === undefined) {
        invalid.push(key);
        break;
      }
      if (prefix === 'l') {
        state.labels[y] = value;
      } else if (prefix === 'c') {
        const colour = normalizeColor(value);
        if (colour === undefined) invalid.push(key);
        else state.colors[y] = colour;
      } else {
        const marker = parseMarker(value);
        if (marker === null) invalid.push(key);
        else state.markers[y] = marker;
      }
    }
  }

  const xl = params.get('xl');
  if (xl !== null) {
    if (state.x === '') invalid.push('xl');
    else state.labels[state.x] = xl;
  }

  const hide = params.get('hide');
  if (hide !== null) {
    let bad = false;
    const entries = hide.split(',').map((p) => p.trim());
    for (const entry of entries) {
      const y = /^[1-9]\d{0,2}$/.test(entry) ? state.ys[Number(entry) - 1] : undefined;
      if (y === undefined) bad = true;
      else state.hidden[y] = true;
    }
    if (bad) invalid.push('hide');
  }

  for (const [key, field] of TOGGLE_KEYS) {
    const raw = params.get(key);
    if (raw === null) continue;
    const flag = parseFlag(raw);
    if (flag === null) invalid.push(key);
    else state[field] = flag;
  }

  // Any `m` key: the list is exactly the decoded tokens, customs numbered c1,
  // c2... in token order; a bad token is skipped (and `m` reported once).
  const tokens = params.getAll('m');
  if (tokens.length > 0) {
    const metrics: Metric[] = [];
    let bad = false;
    for (const token of tokens) {
      const metric = decodeMetricToken(CORRELATION_METRICS, token, nextCustomId(metrics));
      if (metric === null) bad = true;
      else metrics.push(metric);
    }
    if (bad) invalid.push('m');
    state.metrics = metrics;
  }

  const drag = params.get('drag');
  if (drag !== null) {
    if (isDragMode(drag)) state.drag = drag;
    else invalid.push('drag');
  }

  const fire = params.get('fire');
  if (fire !== null) {
    if (state.trigger.mode === 'pv' && CORRELATION_FIRE.includes(fire as CorrelationFire)) {
      state.fire = fire as CorrelationFire;
    } else invalid.push('fire');
  }

  for (const axis of ['x', 'y'] as const) {
    const scale: CorrelationAxisScale = {};
    let present = false;
    const auto = params.get(`${axis}auto`);
    if (auto !== null) {
      const flag = parseFlag(auto);
      if (flag === null) invalid.push(`${axis}auto`);
      else {
        scale.auto = flag;
        present = true;
      }
    }
    for (const bound of ['min', 'max'] as const) {
      const raw = params.get(`${axis}${bound}`);
      if (raw === null) continue;
      const v = parseNumber(raw);
      if (v === null) invalid.push(`${axis}${bound}`);
      else {
        scale[bound] = v;
        present = true;
      }
    }
    const log = params.get(`${axis}log`);
    if (log !== null) {
      const flag = parseFlag(log);
      if (flag === null) invalid.push(`${axis}log`);
      else {
        scale.log = flag;
        present = true;
      }
    }
    if (present) state[axis === 'x' ? 'xScale' : 'yScale'] = scale;
  }
}

/** The catalog a link's drawings are read and written against. */
export interface CorrelationQueryOptions {
  /** Default `CORRELATION_CATALOG`. */
  catalog?: Catalog;
}

// The context codec's options for this plot: axis and magnet trace are both
// named by Y PV, which is each drawing's own `axisId`/`traceId` (the codec's
// identity default).
const CODEC: ContextCodecOptions = { xAxis: VALUE_X_AXIS, warnPrefix: 'Correlation query' };

// Parse a query string (with or without a leading "?"). Over 4 KB the
// drawings (`ann`) are dropped first; if it is still over, the whole query is
// rejected and the defaults open.
export function parseCorrelationQuery(
  s: string,
  opts: CorrelationQueryOptions = {}
): CorrelationState {
  const catalog = opts.catalog ?? CORRELATION_CATALOG;
  let raw = s.startsWith('?') ? s.slice(1) : s;
  const state = defaultCorrelationState();
  if (byteLength(raw) > MAX_QUERY_BYTES) {
    const stripped = withoutContextDrawings(raw);
    if (stripped === raw || byteLength(stripped) > MAX_QUERY_BYTES) {
      console.warn(
        `Correlation query is ${byteLength(raw)} bytes, over the ${MAX_QUERY_BYTES}-byte limit; ignoring it.`
      );
      return state;
    }
    console.warn(
      `Correlation query is ${byteLength(raw)} bytes, over the ${MAX_QUERY_BYTES}-byte limit; ignoring its drawings.`
    );
    raw = stripped;
  }

  const params = new URLSearchParams(raw);
  const invalid: string[] = [];

  const xs = params.getAll('x');
  if (xs.length > 0) {
    const x = pvName(xs[0]);
    if (x === null || xs.length > 1) invalid.push('x');
    if (x !== null) state.x = x;
  }

  const yRaw = params.getAll('y');
  let badY = false;
  for (const value of yRaw) {
    const y = pvName(value);
    if (y === null) {
      badY = true;
      continue;
    }
    if (state.ys.includes(y)) continue;
    if (state.ys.length === MAX_Y) {
      badY = true;
      continue;
    }
    state.ys.push(y);
  }
  if (badY) invalid.push('y');

  const trig = params.get('trig');
  const dt = params.get('dt');
  const trigPv = trig === null ? null : pvName(trig);
  if (trig !== null && trigPv === null) invalid.push('trig');
  if (trigPv !== null) {
    state.trigger = { mode: 'pv', pv: trigPv };
  } else if (dt !== null) {
    const dtS = parseDt(dt);
    if (dtS === null) invalid.push('dt');
    else state.trigger = { mode: 'timer', dtS };
  }

  const n = params.get('n');
  if (n !== null) {
    const parsed = parseN(n);
    if (parsed === null) invalid.push('n');
    else state.n = parsed;
  }

  const lookback = params.get('lookback');
  if (lookback !== null) {
    const span = normalizeLookback(lookback);
    if (span === null) invalid.push('lookback');
    else state.lookback = span;
  }

  const view = params.get('view');
  if (view !== null) {
    if (view === 'scatter' || view === 'density') state.view = view;
    else invalid.push('view');
  }

  const axes = params.get('axes');
  if (axes !== null) {
    if (isAxes(axes)) state.axes = axes;
    else invalid.push('axes');
  }

  const dy = params.get('dy');
  if (dy !== null) {
    const name = pvName(dy);
    if (name !== null && state.ys.includes(name)) state.dy = name;
    else invalid.push('dy');
  }

  parseSettings(params, state, invalid);

  const ann = params.get('ann');
  if (ann !== null) state.drawings = decodeContextDrawings(ann, catalog, CODEC);

  warnInvalid(invalid, 'query');
  return normalizeCorrelationState(state, catalog);
}

// Percent-encode a component, leaving ":" readable (it is legal in a query and
// every PV name has one), as Trace's serializer does.
function encodeComponent(v: string): string {
  return encodeURIComponent(v).replace(/%3A/gi, ':');
}

// "<shape>,<size>,<opacity>" with absent fields empty and trailing commas cut.
function markerText(marker: CorrelationMarker): string {
  const parts = [
    marker.shape ?? '',
    marker.size === undefined ? '' : String(marker.size),
    marker.opacity === undefined ? '' : String(marker.opacity),
  ];
  while (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
  return parts.map(encodeComponent).join(',');
}

function scaleParts(axis: 'x' | 'y', scale: CorrelationAxisScale | undefined): string[] {
  const s = normalizeScale(scale);
  if (s === undefined) return [];
  const out: string[] = [];
  if (s.auto === false) out.push(`${axis}auto=0`);
  if (s.min !== undefined) out.push(`${axis}min=${encodeComponent(String(s.min))}`);
  if (s.max !== undefined) out.push(`${axis}max=${encodeComponent(String(s.max))}`);
  if (s.log === true) out.push(`${axis}log=1`);
  return out;
}

/**
 * Bytes the state-out step's page keys may add in front of a query
 * (`embedded=true&theme=light&`); the drawing steps keep this much free.
 */
export const PAGE_KEY_RESERVE = byteLength('embedded=true&theme=light&');

export interface CorrelationSerializeOptions extends CorrelationQueryOptions {
  /**
   * Bytes to leave free for the page keys when the link carries drawings;
   * default (and at least) {@link PAGE_KEY_RESERVE}.
   */
  reserve?: number;
}

/** A serialized query and what its drawings lost to the 4 KB budget. */
export interface CorrelationSerialized {
  query: string;
  shed: ShedSnapshot;
}

// Serialize a state into the grammar. Blank and duplicate Y are skipped and Y
// beyond the eighth dropped; a value outside its domain is written as its
// default, with one warning naming every such field. Over 4 KB the per-PV keys,
// then the metrics, then trailing Y are shed in the header's shedding order
// (one more warning) until it fits.
export function serializeCorrelationQuery(
  state: CorrelationState,
  opts: CorrelationSerializeOptions = {}
): string {
  return serializeCorrelationQueryWithShed(state, opts).query;
}

/**
 * {@link serializeCorrelationQuery} with the shed counts of the drawings:
 * `dropped` drawings the link does not carry, `trimmed` notes whose
 * text it shortened. With drawings, the shedding steps run first, then the
 * note trim and the drop from the end, which leave `reserve` bytes free for the
 * page keys, and only then trailing Ys.
 */
export function serializeCorrelationQueryWithShed(
  state: CorrelationState,
  opts: CorrelationSerializeOptions = {}
): CorrelationSerialized {
  const catalog = opts.catalog ?? CORRELATION_CATALOG;
  const reserve = Math.max(PAGE_KEY_RESERVE, opts.reserve ?? 0);
  const invalid: string[] = [];
  const head: string[] = [];
  const tail: string[] = [];

  const x = pvName(state.x);
  if (x !== null) head.push(`x=${encodeComponent(x)}`);

  const ys: string[] = [];
  for (const value of state.ys) {
    const y = pvName(value);
    if (y === null || ys.includes(y)) continue;
    if (ys.length === MAX_Y) {
      if (!invalid.includes('y')) invalid.push('y');
      continue;
    }
    ys.push(y);
  }

  const { trigger } = state;
  if (trigger.mode === 'pv') {
    const pv = pvName(trigger.pv);
    if (pv !== null) tail.push(`trig=${encodeComponent(pv)}`);
    else {
      invalid.push('trig');
      tail.push(`dt=${DEFAULT_DT_S}`);
    }
  } else {
    const ok = Number.isFinite(trigger.dtS) && trigger.dtS >= MIN_DT_S;
    if (!ok) invalid.push('dt');
    tail.push(`dt=${ok ? trigger.dtS : DEFAULT_DT_S}`);
  }

  const nOk = Number.isInteger(state.n) && state.n >= 1 && state.n <= MAX_N;
  if (!nOk) invalid.push('n');
  tail.push(`n=${nOk ? state.n : DEFAULT_N}`);

  let lookback = normalizeLookback(state.lookback);
  if (lookback === null) {
    invalid.push('lookback');
    lookback = DEFAULT_LOOKBACK;
  }
  tail.push(`lookback=${encodeComponent(lookback)}`);

  const viewOk = state.view === 'scatter' || state.view === 'density';
  if (!viewOk) invalid.push('view');
  tail.push(`view=${viewOk ? state.view : 'scatter'}`);

  if (!isAxes(state.axes)) invalid.push('axes');
  else if (state.axes !== DEFAULT_AXES) tail.push(`axes=${state.axes}`);

  const dy = pvName(state.dy);
  if (dy !== null && !ys.includes(dy)) invalid.push('dy');
  warnInvalid(invalid, 'state');

  // The record projections, each present iff its record is.
  const xLabel = x === null ? undefined : normalizeLabel(own(state.labels, x));
  const perY = ys.map((y) => {
    const marker = own(state.markers, y);
    const kept = marker === undefined ? undefined : normalizeMarker(marker);
    return {
      label: normalizeLabel(own(state.labels, y)),
      colour: normalizeColor(own(state.colors, y)),
      marker: kept === undefined ? undefined : markerText(kept),
      hidden: own(state.hidden, y) === true,
    };
  });

  // Settings that are never shed: they are a few bytes each.
  const settings: string[] = [];
  if (trigger.mode === 'pv' && state.fire !== undefined && CORRELATION_FIRE.includes(state.fire)) {
    settings.push(`fire=${state.fire}`);
  }
  const defaults = defaultCorrelationState();
  for (const [key, field] of TOGGLE_KEYS) {
    const value = state[field];
    if (typeof value === 'boolean' && value !== defaults[field]) {
      settings.push(`${key}=${value ? 1 : 0}`);
    }
  }
  if (isDragMode(state.drag) && state.drag !== defaults.drag) settings.push(`drag=${state.drag}`);
  // The metric tokens, all or none: the list is written only off the default.
  const metrics = normalizeMetrics(CORRELATION_METRICS, state.metrics);
  const metricParts = metricsAreDefault(CORRELATION_METRICS, metrics)
    ? []
    : metrics.map((m) => `m=${encodeComponent(encodeMetricToken(CORRELATION_METRICS, m))}`);
  const scales = [...scaleParts('x', state.xScale), ...scaleParts('y', state.yScale)];

  // The drawings as written in full: the shedding steps measure the query with them.
  const drawings: readonly Annotation[] = Array.isArray(state.drawings) ? state.drawings : [];
  const full = encodeContextDrawings(drawings, catalog, CODEC);
  const fullAnn = full.value === undefined ? undefined : encodeJsonParam(full.value);

  const encode = (kept: number, shed: ReadonlySet<string>, ann: string | undefined): string => {
    const keptYs = ys.slice(0, kept);
    const parts = [...head, ...keptYs.map((y) => `y=${encodeComponent(y)}`), ...tail];
    if (dy !== null && keptYs.includes(dy)) parts.push(`dy=${encodeComponent(dy)}`);
    if (xLabel !== undefined && !shed.has('xl')) parts.push(`xl=${encodeComponent(xLabel)}`);
    const per = perY.slice(0, kept);
    per.forEach((p, i) => {
      if (p.label !== undefined && !shed.has(`l${i + 1}`)) {
        parts.push(`l${i + 1}=${encodeComponent(p.label)}`);
      }
    });
    per.forEach((p, i) => {
      if (p.colour !== undefined && !shed.has(`c${i + 1}`)) {
        parts.push(`c${i + 1}=${encodeComponent(p.colour)}`);
      }
    });
    per.forEach((p, i) => {
      if (p.marker !== undefined && !shed.has(`m${i + 1}`)) parts.push(`m${i + 1}=${p.marker}`);
    });
    const hidden = per.flatMap((p, i) => (p.hidden ? [String(i + 1)] : []));
    if (hidden.length > 0 && !shed.has('hide')) parts.push(`hide=${hidden.join(',')}`);
    parts.push(...settings);
    if (!shed.has('m')) parts.push(...metricParts);
    parts.push(...scales);
    if (ann !== undefined) parts.push(`ann=${ann}`);
    return parts.join('&');
  };

  const shed = new Set<string>();
  let out = encode(ys.length, shed, fullAnn);
  // With drawings in the link, it must also leave room for the page keys.
  const budget = fullAnn === undefined ? MAX_QUERY_BYTES : MAX_QUERY_BYTES - reserve;
  if (byteLength(out) <= budget) {
    return { query: out, shed: { dropped: full.dropped, trimmed: 0 } };
  }

  // The shedding order; each step drops the keys of one Y (or `xl`,
  // `hide`, every `m`).
  const last = [...ys.keys()].reverse();
  const steps: string[][] = [
    ...last.filter((i) => perY[i].label !== undefined).map((i) => [`l${i + 1}`]),
    ...(xLabel !== undefined ? [['xl']] : []),
    ...last.map((i) => [
      ...(perY[i].colour !== undefined ? [`c${i + 1}`] : []),
      ...(perY[i].marker !== undefined ? [`m${i + 1}`] : []),
    ]),
    ...(perY.some((p) => p.hidden) ? [['hide']] : []),
    ...(metricParts.length > 0 ? [['m']] : []),
  ].filter((step) => step.length > 0);
  const dropped: string[] = [];
  for (const step of steps) {
    if (byteLength(out) <= MAX_QUERY_BYTES) break;
    for (const key of step) shed.add(key);
    dropped.push(...step);
    out = encode(ys.length, shed, fullAnn);
  }
  // The drawing steps: trim note texts, then drop drawings from the end,
  // until the query plus the page keys fits.
  let ann = fullAnn;
  let drawingShed: ShedSnapshot = { dropped: full.dropped, trimmed: 0 };
  if (fullAnn !== undefined) {
    const fit = fitContextDrawings(drawings, catalog, {
      ...CODEC,
      queryWith: (a) => encode(ys.length, shed, a),
      reserve,
    });
    ann = fit.ann;
    out = fit.query;
    drawingShed = fit.shed;
  }
  let kept = ys.length;
  while (kept > 0 && byteLength(out) > MAX_QUERY_BYTES) {
    kept -= 1;
    out = encode(kept, shed, ann);
  }
  const drawingNote =
    fullAnn === undefined
      ? ''
      : `; ${drawingShed.dropped} drawing(s) not written, ${drawingShed.trimmed} note text(s) shortened`;
  console.warn(
    `Correlation query over ${MAX_QUERY_BYTES} bytes; shed ${
      dropped.length > 0 ? dropped.join(', ') : 'no settings'
    } and kept ${kept} of ${ys.length} Y PVs${drawingNote}.`
  );
  return { query: out, shed: drawingShed };
}
