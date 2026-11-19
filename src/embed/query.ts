// The embed query grammar: how a host page (the CANOPY workspace) tells Trace
// which PVs and time range to open, and how Trace reports its state back.
//
//   pv=<NAME>&pv=<NAME>...&range=<relative span, e.g. -1h>
//   pv=<NAME>...&range=custom&from=<datetime-local>[&to=<datetime-local>]
//   ...&plot=<JSON>      optional: axes, trace looks, plot options (plotConfig.ts)
//
// URL-encoded, no leading "?", at most 4 KB. `from`/`to` are Trace's stored
// zone-less wall-time values carried verbatim; no `to` means "until now". An
// invalid range costs one console warning and becomes `-1h`. A missing `plot`
// opens Trace's defaults; an unusable one is ignored with one warning.
//
// The 4 KB are counted the same way on the way in as on the way out: the
// parser measures the query as the serializer would write it (each value
// re-encoded as `serializeTraceQuery` encodes it), page keys left out. A
// browser's URL (`'` becomes `%27`), `plotQuery` (`:,[]{}` become `%XX`) or
// the page keys in front therefore never push a query the serializer wrote
// over the limit. A query that is over it on arrival (hand-made) opens
// without its drawings when that fits, else without its `plot` config; only
// when even its PVs and range are over is it ignored whole. One warning each.
//
// This module is the only parser of the grammar; hosts check size and
// decodability only. Both functions are pure apart from the warnings.

import { relativeRangeMs, resolveTimeWindow } from '../api/time';
import { encodeJsonParam, encodeJsonText, MAX_DRAWINGS } from '../annotations/config';
import { PAGE_KEYS } from './pageKeys';
import { axesOnly, parsePlotConfig, type PlotConfig } from './plotConfig';

export const MAX_QUERY_BYTES = 4096;

const DEFAULT_RANGE = '-1h';

// Zone-less datetime-local value: "YYYY-MM-DDTHH:mm", optional seconds.
const DATETIME_LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/;

export interface TraceQueryXAxis {
  timeRange: string;
  timeFrom?: string;
  timeTo?: string;
}

export interface TraceQuery {
  pvs: string[];
  xAxis: TraceQueryXAxis;
  /** The first plot's display configuration; absent means Trace's defaults. */
  plot?: PlotConfig;
}

// A PV trace as stored in a plot; formula traces carry kind 'formula'.
export interface TraceQueryTrace {
  kind?: string;
  pvName: string;
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

function isBlank(name: string): boolean {
  return name.trim() === '';
}

function defaultXAxis(): TraceQueryXAxis {
  return { timeRange: DEFAULT_RANGE };
}

// Validate a range and keep only the fields it uses; null when invalid.
function normalizeXAxis(xAxis: TraceQueryXAxis): TraceQueryXAxis | null {
  const { timeRange } = xAxis;
  if (timeRange === 'custom') {
    const from = xAxis.timeFrom ?? '';
    const to = xAxis.timeTo ?? '';
    if (!DATETIME_LOCAL.test(from)) return null;
    if (to !== '' && !DATETIME_LOCAL.test(to)) return null;
    const out: TraceQueryXAxis =
      to === '' ? { timeRange, timeFrom: from } : { timeRange, timeFrom: from, timeTo: to };
    if (resolveTimeWindow(out, Date.now()).error !== undefined) return null;
    return out;
  }
  return relativeRangeMs(timeRange) !== null ? { timeRange } : null;
}

function describeRange(xAxis: TraceQueryXAxis): string {
  if (xAxis.timeRange !== 'custom') return JSON.stringify(xAxis.timeRange);
  return `custom from=${JSON.stringify(xAxis.timeFrom ?? '')} to=${JSON.stringify(xAxis.timeTo ?? '')}`;
}

// The bytes `params` take as the serializer writes them: each value encoded
// as `encode` encodes it, the page keys left out.
function writtenBytes(params: URLSearchParams): number {
  const parts: string[] = [];
  for (const [key, value] of params) {
    if (PAGE_KEYS.includes(key)) continue;
    const encoded = key === 'plot' ? encodeJsonText(value) : encodeComponent(value);
    parts.push(`${encodeComponent(key)}=${encoded}`);
  }
  return byteLength(parts.join('&'));
}

// The `plot` JSON without its drawings; null when it has none or is not an object.
function withoutDrawingsJson(plot: string): string | null {
  try {
    const value: unknown = JSON.parse(plot);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    if (!('drawings' in value)) return null;
    const rest: Record<string, unknown> = { ...(value as Record<string, unknown>) };
    delete rest.drawings;
    return JSON.stringify(rest);
  } catch {
    return null;
  }
}

// `params` cut to fit the limit (drawings first, then the plot config), with
// one warning; null when even its PVs and range do not fit.
function fitParams(params: URLSearchParams): URLSearchParams | null {
  const size = writtenBytes(params);
  if (size <= MAX_QUERY_BYTES) return params;
  const over = `Trace query is ${size} bytes, over the ${MAX_QUERY_BYTES}-byte limit`;
  const plot = params.get('plot');
  if (plot !== null) {
    const stripped = withoutDrawingsJson(plot);
    if (stripped !== null) {
      const next = new URLSearchParams(params);
      next.set('plot', stripped);
      if (writtenBytes(next) <= MAX_QUERY_BYTES) {
        console.warn(`${over}; opening it without its drawings.`);
        return next;
      }
    }
    const next = new URLSearchParams(params);
    next.delete('plot');
    if (writtenBytes(next) <= MAX_QUERY_BYTES) {
      console.warn(`${over}; opening it without its plot config.`);
      return next;
    }
  }
  console.warn(`${over}; ignoring it.`);
  return null;
}

// Parse a host query string (with or without a leading "?"). Unknown keys are
// ignored; a missing range is `-1h`. Measured as written (see the header);
// over 4 KB the drawings go, then the plot config, then the whole query.
export function parseTraceQuery(s: string): TraceQuery {
  const raw = s.startsWith('?') ? s.slice(1) : s;
  const params = fitParams(new URLSearchParams(raw));
  if (params === null) return { pvs: [], xAxis: defaultXAxis() };

  const pvs = params.getAll('pv').filter((name) => !isBlank(name));
  const plotRaw = params.get('plot');
  const plot = plotRaw === null ? null : parsePlotConfig(plotRaw);
  const withPlot = (q: TraceQuery): TraceQuery => (plot === null ? q : { ...q, plot });

  const range = params.get('range');
  if (range === null) return withPlot({ pvs, xAxis: defaultXAxis() });

  const requested: TraceQueryXAxis =
    range === 'custom'
      ? {
          timeRange: range,
          timeFrom: params.get('from') ?? undefined,
          timeTo: params.get('to') ?? undefined,
        }
      : { timeRange: range };
  const xAxis = normalizeXAxis(requested);
  if (xAxis === null) {
    console.warn(
      `Trace query has an invalid range (${describeRange(requested)}); using ${DEFAULT_RANGE}.`
    );
    return withPlot({ pvs, xAxis: defaultXAxis() });
  }
  return withPlot({ pvs, xAxis });
}

// Percent-encode a component, leaving ":" readable (it is legal in a query and
// every PV name has one), so the preset serializes to its literal form.
function encodeComponent(v: string): string {
  return encodeURIComponent(v).replace(/%3A/gi, ':');
}

function encode(pvs: string[], xAxis: TraceQueryXAxis, plot?: PlotConfig): string {
  const parts = pvs.map((name) => `pv=${encodeComponent(name)}`);
  parts.push(`range=${encodeComponent(xAxis.timeRange)}`);
  if (xAxis.timeRange === 'custom') {
    parts.push(`from=${encodeComponent(xAxis.timeFrom ?? '')}`);
    if (xAxis.timeTo) parts.push(`to=${encodeComponent(xAxis.timeTo)}`);
  }
  if (plot !== undefined) parts.push(`plot=${encodeJsonParam(plot)}`);
  return parts.join('&');
}

// Serialize PV names (or a plot's traces), an x-axis and optionally the plot
// config into the grammar. Formula traces and blank names are skipped; an
// invalid range is written as `-1h` (one warning). The drawings are capped at
// MAX_DRAWINGS; over 4 KB trailing drawings are dropped first ("kept k of n
// drawings"); if not even one fits, the config shrinks to its axes (which
// carry no drawings), then goes, then trailing PVs are dropped, with one
// warning per step taken, until it fits.
export function serializeTraceQuery(
  traces: readonly (string | TraceQueryTrace)[],
  xAxis: TraceQueryXAxis,
  plot?: PlotConfig
): string {
  const pvs: string[] = [];
  for (const t of traces) {
    if (typeof t !== 'string' && t.kind === 'formula') continue;
    const name = typeof t === 'string' ? t : t.pvName;
    if (!isBlank(name)) pvs.push(name);
  }

  let range = normalizeXAxis(xAxis);
  if (range === null) {
    console.warn(`Trace range ${describeRange(xAxis)} is invalid; writing ${DEFAULT_RANGE}.`);
    range = defaultXAxis();
  }

  const drawings = plot?.drawings ?? [];
  const n = drawings.length;
  const config =
    plot !== undefined && n > MAX_DRAWINGS
      ? { ...plot, drawings: drawings.slice(0, MAX_DRAWINGS) }
      : plot;
  const keptDrawings = (k: number) => console.warn(`Trace query: kept ${k} of ${n} drawings.`);

  let out = encode(pvs, range, config);
  if (byteLength(out) <= MAX_QUERY_BYTES) {
    if (n > MAX_DRAWINGS) keptDrawings(MAX_DRAWINGS);
    return out;
  }

  // First shrink step: drop trailing drawings, one at a time, while one is left.
  if (config !== undefined && n > 0) {
    for (let k = Math.min(n, MAX_DRAWINGS) - 1; k >= 1; k--) {
      out = encode(pvs, range, { ...config, drawings: drawings.slice(0, k) });
      if (byteLength(out) <= MAX_QUERY_BYTES) {
        keptDrawings(k);
        return out;
      }
    }
  }

  if (plot !== undefined) {
    const axes = axesOnly(plot);
    if (axes !== undefined) {
      out = encode(pvs, range, axes);
      if (byteLength(out) <= MAX_QUERY_BYTES) {
        console.warn(
          `Trace query over ${MAX_QUERY_BYTES} bytes; kept only the axes of the plot config.`
        );
        return out;
      }
    }
    console.warn(`Trace query over ${MAX_QUERY_BYTES} bytes; dropped the plot config.`);
    out = encode(pvs, range);
    if (byteLength(out) <= MAX_QUERY_BYTES) return out;
  }

  const total = pvs.length;
  while (pvs.length > 0 && byteLength(out) > MAX_QUERY_BYTES) {
    pvs.pop();
    out = encode(pvs, range);
  }
  console.warn(`Trace query over ${MAX_QUERY_BYTES} bytes; kept ${pvs.length} of ${total} PVs.`);
  return out;
}
