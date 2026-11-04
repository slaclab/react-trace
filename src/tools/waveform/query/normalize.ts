// The Waveform link format; the grammar is documented in docs/waveform.md (Link format).
//
// `normalizeWaveformState` is the one canonical form, run at the end of every
// parse and every edit: a PV sits in at most one section (Live, then
// Reference, then X source), and `styles` and `hidden` are pruned to the Live
// and Reference PVs. A snapshot reference keeps its own style on the snapshot
// object; neither is ever serialized.

import { isColorLiteral } from '../../../annotationTheme';
import { isDragMode } from '../../../plot/plotToggles';
import { normalizeMetrics } from '../../../statistics/model';
import { WAVEFORM_METRICS } from '../metrics';
import { WAVEFORM_CATALOG } from '../../../annotations/catalog';
import type { Catalog } from '../../../annotations/catalog/types';
import { VALUE_X_AXIS } from '../../../annotations/catalog/xAxis';
import { type Annotation, validateAnnotationIn } from '../../../annotations/model';
import {
  DEFAULT_DEC,
  DEFAULT_ROLL_S,
  defaultWaveformState,
  MAX_AVG,
  MAX_DEC,
  MAX_HZ,
  MAX_LABEL_LENGTH,
  MAX_LIVE,
  MAX_PERSIST,
  MAX_ROLL_S,
  MAX_SPREAD,
  MAX_WIDTH,
  MIN_DEC,
  MIN_HZ,
  MIN_ROLL_S,
  MIN_WIDTH,
  WAVEFORM_LINE_STYLES,
  WAVEFORM_LINE_TYPES,
  type WaveformAxisScale,
  type WaveformElementRange,
  type WaveformLineStyle,
  type WaveformLineType,
  type WaveformReference,
  type WaveformRolling,
  type WaveformSnapshot,
  type WaveformState,
  type WaveformStyle,
} from './state';

// Structural equality of normalized values: plain objects by their
// defined keys in any order, arrays element-wise, anything else (a snapshot's
// typed arrays included) by identity.
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => sameValue(v, b[i]));
  }
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const ka = Object.keys(ra).filter((k) => ra[k] !== undefined);
  const kb = Object.keys(rb).filter((k) => rb[k] !== undefined);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(rb, k) && sameValue(ra[k], rb[k]));
}

/** Whether two states are structurally equal (a snapshot's frames by identity). */
export function sameWaveformState(a: WaveformState, b: WaveformState): boolean {
  return sameValue(a, b);
}

// `next`, or `prev` when it is structurally equal: the field keeps its reference.
function kept<T>(prev: unknown, next: T): T {
  return sameValue(prev, next) ? (prev as T) : next;
}

/**
 * The drawings validated against `catalog` on a value x axis. An element
 * whose validated value equals it is kept by reference, and the array itself
 * is returned when no element changed. A drawing of a kind the catalog
 * lacks is dropped with a warning; drawings are never pruned by curve.
 */
export function normalizeDrawings(list: unknown, catalog: Catalog): Annotation[] {
  if (!Array.isArray(list)) return [];
  let changed = false;
  const out: Annotation[] = [];
  for (const raw of list as unknown[]) {
    const valid = validateAnnotationIn(catalog, raw, VALUE_X_AXIS, 'Waveform');
    if (valid === null) {
      changed = true;
      continue;
    }
    const element = kept(raw, valid);
    if (element !== raw) changed = true;
    out.push(element);
  }
  return changed ? out : (list as Annotation[]);
}

export function own<T>(record: Record<string, T> | undefined, key: string): T | undefined {
  return record !== undefined && Object.prototype.hasOwnProperty.call(record, key)
    ? record[key]
    : undefined;
}

// A sparse record kept only at `keys`, in `keys` order, each value mapped
// through `keep` (undefined drops it).
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

export function pvName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.trim();
  return name === '' ? null : name;
}

function normalizeLabel(value: unknown): string | undefined {
  return typeof value === 'string' ? [...value].slice(0, MAX_LABEL_LENGTH).join('') : undefined;
}

// A colour from the link reaches the chart and the statistics rows' styles, so
// only a plain colour literal is kept; anything else gives the curve its
// automatic colour.
function normalizeColor(value: unknown): string | undefined {
  const color = typeof value === 'string' ? value.trim() : undefined;
  return isColorLiteral(color) ? color : undefined;
}

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function normalizeStyle(value: unknown): WaveformStyle | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const v = value as Record<string, unknown>;
  const out: WaveformStyle = {};
  const label = normalizeLabel(v.label);
  if (label !== undefined) out.label = label;
  const color = normalizeColor(v.color);
  if (color !== undefined) out.color = color;
  if ((WAVEFORM_LINE_TYPES as readonly unknown[]).includes(v.lineType)) {
    out.lineType = v.lineType as WaveformLineType;
  }
  if (finite(v.width) && v.width > 0) out.width = clamp(v.width, MIN_WIDTH, MAX_WIDTH);
  if ((WAVEFORM_LINE_STYLES as readonly unknown[]).includes(v.lineStyle)) {
    out.lineStyle = v.lineStyle as WaveformLineStyle;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeScale(value: WaveformAxisScale | undefined): WaveformAxisScale | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const out: WaveformAxisScale = {};
  if (value.auto === false) out.auto = false;
  if (finite(value.min)) out.min = value.min;
  if (finite(value.max)) out.max = value.max;
  if (value.log === true) out.log = true;
  return Object.keys(out).length > 0 ? out : undefined;
}

function isIndex(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

function normalizeElems(value: WaveformElementRange | null): WaveformElementRange | null {
  if (typeof value !== 'object' || value === null) return null;
  const out: WaveformElementRange = {};
  if (isIndex(value.first)) out.first = value.first;
  if (isIndex(value.last)) out.last = value.last;
  if (out.first !== undefined && out.last !== undefined && out.first > out.last) return null;
  return Object.keys(out).length > 0 ? out : null;
}

// An integer setting within [lo, hi]; a finite value is rounded and clamped,
// anything else falls back.
function intIn(v: unknown, lo: number, hi: number, fallback: number): number {
  return finite(v) ? clamp(Math.round(v), lo, hi) : fallback;
}

function normalizeDec(v: unknown): number {
  if (!finite(v)) return DEFAULT_DEC;
  const n = Math.round(v);
  return n <= 0 ? 0 : clamp(n, MIN_DEC, MAX_DEC);
}

/**
 * The canonical form of a state, applied at the end of every parse and every
 * edit; pure and idempotent. Reference-preserving: a field structurally
 * equal to the input's keeps the input's reference, and an input already in
 * canonical form is returned as is, so a drawing commit leaves every other
 * field alone and a settings edit leaves `drawings` alone. Drawings are
 * validated against `catalog` (default {@link WAVEFORM_CATALOG}). Live PVs are trimmed, deduplicated and capped at
 * 8; a PV sits in at most one section — a Reference PV that is Live is
 * dropped, an X source that is Live or the Reference PV is dropped.
 * `styles` and `hidden` are pruned to the Live and Reference PVs; `xLabel` is
 * dropped without an X source; `delta` is false without a reference. Numbers
 * are rounded and clamped into their domains. A snapshot reference is kept by
 * identity (its frames are never copied); only its style is normalized.
 */
export function normalizeWaveformState(
  state: WaveformState,
  catalog: Catalog = WAVEFORM_CATALOG
): WaveformState {
  const defaults = defaultWaveformState();
  const pvs: string[] = [];
  for (const raw of state.pvs) {
    const pv = pvName(raw);
    if (pv === null || pvs.includes(pv) || pvs.length === MAX_LIVE) continue;
    pvs.push(pv);
  }

  let reference: WaveformReference | null = null;
  const ref = state.reference;
  if (ref !== null && typeof ref === 'object') {
    if (ref.kind === 'pv') {
      const pv = pvName(ref.pv);
      if (pv !== null && !pvs.includes(pv)) reference = { kind: 'pv', pv };
    } else if (ref.kind === 'snapshot') {
      const style = normalizeStyle(ref.style);
      const snapshot: WaveformSnapshot = { kind: 'snapshot', frames: ref.frames, time: ref.time };
      if (style !== undefined) snapshot.style = style;
      // A σ entry counts only for a frame of the snapshot, at that frame's length.
      if (ref.spread !== undefined) {
        const spread: Record<string, Float64Array> = {};
        for (const [pv, sigma] of Object.entries(ref.spread)) {
          const frame = Object.prototype.hasOwnProperty.call(ref.frames, pv)
            ? ref.frames[pv]
            : undefined;
          if (frame !== undefined && sigma.length === frame.length) spread[pv] = sigma;
        }
        if (Object.keys(spread).length > 0) snapshot.spread = spread;
      }
      if (typeof ref.rolling === 'number' && Number.isFinite(ref.rolling)) {
        snapshot.rolling = intIn(ref.rolling, MIN_ROLL_S, MAX_ROLL_S, DEFAULT_ROLL_S);
      }
      reference = snapshot;
    } else if (ref.kind === 'rolling') {
      const style = normalizeStyle(ref.style);
      const rolling: WaveformRolling = {
        kind: 'rolling',
        seconds: intIn(ref.seconds, MIN_ROLL_S, MAX_ROLL_S, DEFAULT_ROLL_S),
      };
      if (style !== undefined) rolling.style = style;
      reference = rolling;
    }
  }
  const refPv = reference?.kind === 'pv' ? reference.pv : null;

  const xsName = pvName(state.xs);
  const xs = xsName !== null && !pvs.includes(xsName) && xsName !== refPv ? xsName : '';
  const curves = refPv === null ? pvs : [...pvs, refPv];
  const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);

  const next: WaveformState = {
    pvs: kept(state.pvs, pvs),
    reference: kept(state.reference, reference),
    xs,
    xAxis: state.xAxis === 'index' ? 'index' : 'source',
    delta: reference !== null && state.delta === true,
    persist: intIn(state.persist, 1, MAX_PERSIST, defaults.persist),
    avg: intIn(state.avg, 1, MAX_AVG, defaults.avg),
    hz: intIn(state.hz, MIN_HZ, MAX_HZ, defaults.hz),
    elems: kept(state.elems, normalizeElems(state.elems)),
    dec: normalizeDec(state.dec),
    drawAs: state.drawAs === 'band' ? 'band' : 'dashed',
    spread: intIn(state.spread, 0, MAX_SPREAD, defaults.spread),
    legend: bool(state.legend, defaults.legend),
    grid: bool(state.grid, defaults.grid),
    crosshair: bool(state.crosshair, defaults.crosshair),
    tooltip: bool(state.tooltip, defaults.tooltip),
    drag: isDragMode(state.drag) ? state.drag : defaults.drag,
    stats: bool(state.stats, defaults.stats),
    dist: bool(state.dist, defaults.dist),
    metrics: kept(state.metrics, normalizeMetrics(WAVEFORM_METRICS, state.metrics)),
    hidden: kept(
      state.hidden,
      pruned(state.hidden, curves, (v) => (v === true ? (true as const) : undefined))
    ),
    styles: kept(state.styles, pruned(state.styles, curves, normalizeStyle)),
    drawings: normalizeDrawings(state.drawings, catalog),
  };
  if (xs !== '') {
    const xLabel = normalizeLabel(state.xLabel);
    if (xLabel !== undefined) next.xLabel = xLabel;
  }
  const yScale = normalizeScale(state.yScale);
  if (yScale !== undefined) next.yScale = kept(state.yScale, yScale);
  const xScale = normalizeScale(
    state.xScale === undefined ? undefined : { ...state.xScale, log: undefined }
  );
  if (xScale !== undefined) next.xScale = kept(state.xScale, xScale);
  return sameValue(state, next) ? state : next;
}
