// The Waveform link format; the grammar is documented in docs/waveform.md (Link format).
//
// The serializer: every key is omitted at its default, and an over-long link
// is shed in a fixed order (see `serializeWaveformQueryWithShed`).

import { isDragMode } from '../../../plot/plotToggles';
import { encodeMetricTokens, metricsAreDefault } from '../../../statistics/model';
import { WAVEFORM_METRICS } from '../metrics';
import { WAVEFORM_CATALOG } from '../../../annotations/catalog';
import { encodeJsonParam } from '../../../annotations/config';
import { encodeContextDrawings, fitContextDrawings } from '../../../annotations/contextLink';
import type { ShedSnapshot } from '../../../annotations/host/shedStore';
import { normalizeWaveformState, own } from './normalize';
import {
  defaultWaveformState,
  MAX_QUERY_BYTES,
  type WaveformSerializeOptions,
  type WaveformShedQuery,
  type WaveformState,
} from './state';
import { byteLength, codecOptions, wireFromStyle } from './wire';

// Percent-encode a component, leaving ":" readable (every PV name has one), as
// Trace's and Correlation's serializers do.
function encodeComponent(v: string): string {
  return encodeURIComponent(v).replace(/%3A/gi, ':');
}

function numberText(n: number): string {
  return String(n);
}

// Serialize a state into the grammar, defaults omitted. The state is put in
// canonical form first, so a value outside its domain is written clamped or
// not at all. A snapshot reference, its style and Δ against it are never
// written. Over 4 KB labels are shed first, then the whole `plot`,
// then trailing Live PVs (never `ref`/`xs`), with one warning. The drawings
// and what of them was shed: see serializeWaveformQueryWithShed.
export function serializeWaveformQuery(
  input: WaveformState,
  opts: WaveformSerializeOptions = {}
): string {
  return serializeWaveformQueryWithShed(input, opts).query;
}

/**
 * The query of `input` and what of its drawings the link could not carry
 *. Shedding order: labels, then the whole `plot` and `m` (as without
 * drawings), then the drawing steps — note text trimmed, then drawings
 * dropped from the end, until the query plus `opts.reserve` fits — then
 * trailing Live PVs; never `ref` or `xs`. A query carrying drawings always
 * fits with the reserve; one without them is exactly the drawing-free link.
 * `shed.dropped` also counts the Δ drawings left out while the reference is a
 * snapshot.
 */
export function serializeWaveformQueryWithShed(
  input: WaveformState,
  opts: WaveformSerializeOptions = {}
): WaveformShedQuery {
  const catalog = opts.catalog ?? WAVEFORM_CATALOG;
  const reserve = Math.max(0, opts.reserve ?? 0);
  const state = normalizeWaveformState(input, catalog);
  const defaults = defaultWaveformState();
  const refPv = state.reference?.kind === 'pv' ? state.reference.pv : null;
  const rolling = state.reference?.kind === 'rolling' ? state.reference.seconds : null;

  const head: string[] = [];
  if (refPv !== null) head.push(`ref=${encodeComponent(refPv)}`);
  if (rolling !== null) head.push(`roll=${rolling}`);
  if (state.xs !== '') head.push(`xs=${encodeComponent(state.xs)}`);
  if (state.xAxis !== defaults.xAxis) head.push(`xaxis=${state.xAxis}`);
  if (state.delta && (refPv !== null || rolling !== null)) head.push('delta=1');
  if (state.persist !== defaults.persist) head.push(`persist=${state.persist}`);
  if (state.avg !== defaults.avg) head.push(`avg=${state.avg}`);
  if (state.hz !== defaults.hz) head.push(`hz=${state.hz}`);
  if (state.elems !== null) {
    head.push(`elems=${state.elems.first ?? ''}:${state.elems.last ?? ''}`);
  }
  if (state.dec !== defaults.dec) head.push(`dec=${state.dec}`);
  if (state.drawAs !== defaults.drawAs) head.push(`draw=${state.drawAs}`);
  if (state.spread !== defaults.spread) head.push(`spread=${state.spread}`);
  if (state.legend !== defaults.legend) head.push(`legend=${state.legend ? 1 : 0}`);
  if (state.grid !== defaults.grid) head.push(`grid=${state.grid ? 1 : 0}`);
  if (state.crosshair !== defaults.crosshair) head.push(`cross=${state.crosshair ? 1 : 0}`);
  if (state.tooltip !== defaults.tooltip) head.push(`tip=${state.tooltip ? 1 : 0}`);
  if (isDragMode(state.drag) && state.drag !== defaults.drag) head.push(`drag=${state.drag}`);
  if (state.stats !== defaults.stats) head.push(`stats=${state.stats ? 1 : 0}`);
  if (state.dist !== defaults.dist) head.push(`dist=${state.dist ? 1 : 0}`);
  // The metric tokens, all or none: the list is written only off the default,
  // and shed with the plot styles.
  const metricParts = metricsAreDefault(WAVEFORM_METRICS, state.metrics)
    ? []
    : encodeMetricTokens(WAVEFORM_METRICS, state.metrics).map((t) => `m=${encodeComponent(t)}`);
  const scale = state.yScale;
  if (scale?.auto === false) head.push('yauto=0');
  if (scale?.min !== undefined) head.push(`ymin=${numberText(scale.min)}`);
  if (scale?.max !== undefined) head.push(`ymax=${numberText(scale.max)}`);
  if (scale?.log === true) head.push('ylog=1');
  const xScale = state.xScale;
  if (xScale?.auto === false) head.push('xauto=0');
  if (xScale?.min !== undefined) head.push(`xmin=${numberText(xScale.min)}`);
  if (xScale?.max !== undefined) head.push(`xmax=${numberText(xScale.max)}`);

  type Level = 'full' | 'unlabelled' | 'none';
  const encode = (live: string[], level: Level, ann?: string): string => {
    const parts = live.map((pv) => `pv=${encodeComponent(pv)}`);
    parts.push(...head);
    const curves = refPv === null ? live : [...live, refPv];
    for (const pv of curves) if (own(state.hidden, pv)) parts.push(`hide=${encodeComponent(pv)}`);
    if (level === 'full' && state.xLabel !== undefined) {
      parts.push(`xl=${encodeComponent(state.xLabel)}`);
    }
    if (level !== 'none') {
      parts.push(...metricParts);
      const traces = curves.map((pv) => wireFromStyle(own(state.styles, pv), level === 'full'));
      while (traces.length > 0 && Object.keys(traces[traces.length - 1]).length === 0) traces.pop();
      if (traces.length > 0) {
        parts.push(`plot=${encodeComponent(JSON.stringify({ v: 1, traces }))}`);
      }
    }
    if (ann !== undefined) parts.push(`ann=${ann}`);
    return parts.join('&');
  };

  // The drawings as written whole. With none written the budget is the plain
  // limit, so a drawing-free link is shed exactly as before drawings existed;
  // with some, it leaves room for the page keys.
  const codec = codecOptions(state);
  const whole = encodeContextDrawings(state.drawings, catalog, codec);
  const annWhole = whole.value === undefined ? undefined : encodeJsonParam(whole.value);
  const budget = annWhole === undefined ? MAX_QUERY_BYTES : MAX_QUERY_BYTES - reserve;
  const wholeShed: ShedSnapshot = { dropped: whole.dropped, trimmed: 0 };

  const full = encode(state.pvs, 'full', annWhole);
  if (byteLength(full) <= budget) return { query: full, shed: wholeShed };

  const unlabelled = encode(state.pvs, 'unlabelled', annWhole);
  if (byteLength(unlabelled) <= budget) {
    console.warn(`Waveform query over ${MAX_QUERY_BYTES} bytes; dropped the curve labels.`);
    return { query: unlabelled, shed: wholeShed };
  }

  // Level none, then the drawing steps: trim note text, drop from the end.
  let shed = wholeShed;
  let out = encode(state.pvs, 'none', annWhole);
  let drawingsWritten = annWhole !== undefined;
  if (annWhole !== undefined && byteLength(out) > budget) {
    const fit = fitContextDrawings(state.drawings, catalog, {
      ...codec,
      queryWith: (ann) => encode(state.pvs, 'none', ann),
      reserve,
    });
    out = fit.query;
    shed = fit.shed;
    drawingsWritten = fit.ann !== undefined;
  }
  const drawingNote =
    shed.dropped > whole.dropped || shed.trimmed > 0
      ? `, shortened ${shed.trimmed} note(s) and left out ${shed.dropped - whole.dropped} drawing(s)`
      : '';
  if (drawingsWritten) {
    console.warn(
      `Waveform query over ${MAX_QUERY_BYTES} bytes; dropped the curve styles${drawingNote}.`
    );
    return { query: out, shed };
  }

  // No drawing fits: trailing Live PVs go, on the plain limit.
  const kept = [...state.pvs];
  out = encode(kept, 'none');
  while (kept.length > 0 && byteLength(out) > MAX_QUERY_BYTES) {
    kept.pop();
    out = encode(kept, 'none');
  }
  console.warn(
    `Waveform query over ${MAX_QUERY_BYTES} bytes; dropped the curve styles${drawingNote} and kept ` +
      `${kept.length} of ${state.pvs.length} Live PVs.`
  );
  return { query: out, shed };
}
