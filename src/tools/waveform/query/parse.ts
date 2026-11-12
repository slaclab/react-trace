// The Waveform link format; the grammar is documented in docs/waveform.md (Link format).
//
// The parser: unknown keys are ignored; invalid values fall back to their
// defaults, with one console warning per parse naming every key that did.

import { isDragMode } from '../../../plot/plotToggles';
import { decodeMetricTokens } from '../../../statistics/model';
import { WAVEFORM_METRICS } from '../metrics';
import { WAVEFORM_CATALOG } from '../../../annotations/catalog';
import { decodeContextDrawings, withoutContextDrawings } from '../../../annotations/contextLink';
import { normalizeStyle, normalizeWaveformState, pvName } from './normalize';
import {
  defaultWaveformState,
  MAX_AVG,
  MAX_DEC,
  MAX_HZ,
  MAX_LIVE,
  MAX_PERSIST,
  MAX_QUERY_BYTES,
  MAX_ROLL_S,
  MAX_SPREAD,
  MIN_DEC,
  MIN_HZ,
  MIN_ROLL_S,
  type WaveformElementRange,
  type WaveformQueryOptions,
  type WaveformState,
  type WaveformStyle,
} from './state';
import { byteLength, codecOptions } from './wire';

function parseInteger(raw: string, lo: number, hi: number): number | null {
  const text = raw.trim();
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  return n >= lo && n <= hi ? n : null;
}

function parseNumber(raw: string): number | null {
  const text = raw.trim();
  if (text === '') return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function parseFlag(raw: string): boolean | null {
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  return null;
}

function parseElems(raw: string): WaveformElementRange | null | undefined {
  const m = /^\s*(\d*)\s*:\s*(\d*)\s*$/.exec(raw);
  if (m === null) return undefined;
  const out: WaveformElementRange = {};
  if (m[1] !== '') out.first = Number(m[1]);
  if (m[2] !== '') out.last = Number(m[2]);
  if (out.first !== undefined && out.last !== undefined && out.first > out.last) return undefined;
  return Object.keys(out).length > 0 ? out : null;
}

function styleFromWire(entry: unknown): WaveformStyle | undefined {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return undefined;
  const t = entry as Record<string, unknown>;
  return normalizeStyle({
    label: t.displayName,
    color: t.color,
    lineType: t.lineType,
    width: t.lineWidth,
    lineStyle: t.lineStyle,
  });
}

// The `plot` traces array, or null when the value is unreadable.
function parsePlotTraces(raw: string): unknown[] | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const { v, traces } = data as { v?: unknown; traces?: unknown };
  if (v !== undefined && v !== 1) return null;
  if (traces === undefined) return [];
  return Array.isArray(traces) ? traces : null;
}

function warnInvalid(invalid: string[], what: string): void {
  if (invalid.length === 0) return;
  console.warn(`Waveform ${what} has invalid ${invalid.join(', ')}; using the defaults for them.`);
}

// Parse a query string (with or without a leading "?"). Over 4 KB a query
// carrying `ann` is retried without its drawings; otherwise the whole query is
// rejected and the defaults open. Drawings are validated against
// `opts.catalog` (default WAVEFORM_CATALOG).
export function parseWaveformQuery(s: string, opts: WaveformQueryOptions = {}): WaveformState {
  const catalog = opts.catalog ?? WAVEFORM_CATALOG;
  const raw = s.startsWith('?') ? s.slice(1) : s;
  const state = defaultWaveformState();
  if (byteLength(raw) > MAX_QUERY_BYTES) {
    const stripped = withoutContextDrawings(raw);
    if (stripped !== raw && byteLength(stripped) <= MAX_QUERY_BYTES) {
      console.warn(
        `Waveform query is ${byteLength(raw)} bytes, over the ${MAX_QUERY_BYTES}-byte limit; ` +
          'ignoring its drawings.'
      );
      return parseWaveformQuery(stripped, opts);
    }
    console.warn(
      `Waveform query is ${byteLength(raw)} bytes, over the ${MAX_QUERY_BYTES}-byte limit; ignoring it.`
    );
    return state;
  }

  const params = new URLSearchParams(raw);
  const invalid: string[] = [];
  const bad = (key: string) => {
    if (!invalid.includes(key)) invalid.push(key);
  };
  const single = (key: string): string | null => {
    const all = params.getAll(key);
    if (all.length > 1) bad(key);
    return all.length > 0 ? all[0] : null;
  };

  // Live PVs, in order: the positional `plot` traces line up with these.
  for (const value of params.getAll('pv')) {
    const pv = pvName(value);
    if (pv === null) bad('pv');
    else if (state.pvs.includes(pv)) continue;
    else if (state.pvs.length === MAX_LIVE) bad('pv');
    else state.pvs.push(pv);
  }

  const ref = single('ref');
  if (ref !== null) {
    const pv = pvName(ref);
    if (pv === null) bad('ref');
    else state.reference = { kind: 'pv', pv };
  }

  // One reference: a rolling one wins over `ref` when both are given, and
  // the dropped `ref` is reported like any other conflicting key.
  const roll = single('roll');
  if (roll !== null) {
    const seconds = Number(roll);
    if (!Number.isFinite(seconds) || seconds < MIN_ROLL_S || seconds > MAX_ROLL_S) bad('roll');
    else {
      if (state.reference !== null) bad('ref');
      state.reference = { kind: 'rolling', seconds: Math.round(seconds) };
    }
  }

  const spread = single('spread');
  if (spread !== null) {
    const k = Number(spread);
    if (!Number.isInteger(k) || k < 0 || k > MAX_SPREAD) bad('spread');
    else state.spread = k;
  }

  const xs = single('xs');
  if (xs !== null) {
    const pv = pvName(xs);
    if (pv === null) bad('xs');
    else state.xs = pv;
  }

  const xl = single('xl');
  if (xl !== null) state.xLabel = xl;

  const xaxis = single('xaxis');
  if (xaxis !== null) {
    if (xaxis === 'index' || xaxis === 'source') state.xAxis = xaxis;
    else bad('xaxis');
  }

  const flag = (key: string, set: (v: boolean) => void) => {
    const value = single(key);
    if (value === null) return;
    const parsed = parseFlag(value);
    if (parsed === null) bad(key);
    else set(parsed);
  };
  flag('delta', (v) => (state.delta = v));
  flag('legend', (v) => (state.legend = v));
  flag('grid', (v) => (state.grid = v));
  flag('cross', (v) => (state.crosshair = v));
  flag('tip', (v) => (state.tooltip = v));
  flag('stats', (v) => (state.stats = v));
  const drag = single('drag');
  if (drag !== null) {
    if (isDragMode(drag)) state.drag = drag;
    else bad('drag');
  }
  flag('dist', (v) => (state.dist = v));
  // Any `m` key: the list is exactly the decoded tokens; a bad token is
  // skipped (and `m` reported once).
  const tokens = params.getAll('m');
  if (tokens.length > 0) {
    let badToken = false;
    state.metrics = decodeMetricTokens(WAVEFORM_METRICS, tokens, () => (badToken = true));
    if (badToken) bad('m');
  }
  flag('ylog', (v) => {
    if (v) state.yScale = { ...state.yScale, log: true };
  });
  flag('yauto', (v) => {
    if (!v) state.yScale = { ...state.yScale, auto: false };
  });
  flag('xauto', (v) => {
    if (!v) state.xScale = { ...state.xScale, auto: false };
  });

  const integer = (key: string, lo: number, hi: number, set: (v: number) => void) => {
    const value = single(key);
    if (value === null) return;
    const parsed = parseInteger(value, lo, hi);
    if (parsed === null) bad(key);
    else set(parsed);
  };
  integer('persist', 1, MAX_PERSIST, (v) => (state.persist = v));
  integer('avg', 1, MAX_AVG, (v) => (state.avg = v));
  integer('hz', MIN_HZ, MAX_HZ, (v) => (state.hz = v));
  integer('dec', 0, MAX_DEC, (v) => {
    if (v === 0 || v >= MIN_DEC) state.dec = v;
    else bad('dec');
  });

  const elems = single('elems');
  if (elems !== null) {
    const parsed = parseElems(elems);
    if (parsed === undefined) bad('elems');
    else state.elems = parsed;
  }

  const draw = single('draw');
  if (draw !== null) {
    if (draw === 'band' || draw === 'dashed') state.drawAs = draw;
    else bad('draw');
  }

  for (const key of ['ymin', 'ymax'] as const) {
    const value = single(key);
    if (value === null) continue;
    const parsed = parseNumber(value);
    if (parsed === null) bad(key);
    else state.yScale = { ...state.yScale, [key === 'ymin' ? 'min' : 'max']: parsed };
  }
  for (const key of ['xmin', 'xmax'] as const) {
    const value = single(key);
    if (value === null) continue;
    const parsed = parseNumber(value);
    if (parsed === null) bad(key);
    else state.xScale = { ...state.xScale, [key === 'xmin' ? 'min' : 'max']: parsed };
  }

  for (const value of params.getAll('hide')) {
    const pv = pvName(value);
    if (pv === null) bad('hide');
    else state.hidden[pv] = true;
  }

  const plot = single('plot');
  if (plot !== null) {
    const traces = parsePlotTraces(plot);
    if (traces === null) bad('plot');
    else {
      const refPv = state.reference?.kind === 'pv' ? state.reference.pv : null;
      const slots = refPv === null ? state.pvs : [...state.pvs, refPv];
      if (traces.length > slots.length) bad('plot');
      traces.forEach((entry, i) => {
        if (i >= slots.length) return;
        const isEmpty =
          typeof entry === 'object' && entry !== null && Object.keys(entry).length === 0;
        const style = styleFromWire(entry);
        if (style === undefined && !isEmpty) bad('plot');
        if (style !== undefined) state.styles[slots[i]] = style;
      });
    }
  }

  // The drawings: the context codec resolves the tables and warns once itself.
  const ann = single('ann');
  if (ann !== null) state.drawings = decodeContextDrawings(ann, catalog, codecOptions(null));

  warnInvalid(invalid, 'query');
  return normalizeWaveformState(state, catalog);
}
