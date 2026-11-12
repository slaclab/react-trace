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
// This module is the only parser of the grammar; hosts check size and
// decodability only. Both functions are pure apart from the warnings.

import { relativeRangeMs, resolveTimeWindow } from '../api/time';
import { encodeJsonParam, MAX_DRAWINGS } from '../annotations/config';
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

// Parse a host query string (with or without a leading "?"). Unknown keys are
// ignored; a missing range is `-1h`. Over 4 KB the whole query is rejected.
export function parseTraceQuery(s: string): TraceQuery {
  const raw = s.startsWith('?') ? s.slice(1) : s;
  if (byteLength(raw) > MAX_QUERY_BYTES) {
    console.warn(
      `Trace query is ${byteLength(raw)} bytes, over the ${MAX_QUERY_BYTES}-byte limit; ignoring it.`
    );
    return { pvs: [], xAxis: defaultXAxis() };
  }

  const params = new URLSearchParams(raw);
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
