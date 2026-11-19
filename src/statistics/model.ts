// The statistics model shared by every tool: a list of metrics, each an
// expression (expr.ts) over a frame (evaluate.ts), evaluated per row. The
// readout table's columns are the metrics that are `on`; the strip charts are
// the metrics with `strip`; the list order is the column order.
//
// What differs per tool is the **catalog** (`MetricCatalog`): the variable
// names and which are vectors, the unit kinds a metric may carry, the presets
// (built-ins) with their default-on flags and strip ranges, and the words the
// editor uses. Everything below is parameterised by it and never by a tool.
//
// Presets and custom metrics are one kind of row. A preset has a fixed label,
// expression and unit kind (re-stamped by the normalizer); a custom metric
// carries its own, and its id is `c<n>` (in-memory only; renumbered on parse).
//
// The default list (`defaultMetrics`) is every preset in catalog order, the
// `defaultOn` ones on, no strip. A query writes `m=` tokens only when the
// list differs from it (`metricsAreDefault`); see `encodeMetricToken` /
// `decodeMetricToken` for the grammar each tool's query module carries.

import { compileExpression, rowReference, type CompileResult, type ExprLanguage } from './expr';
import type { ReferenceEntry } from './expr';

export interface Metric {
  /** A preset id of the catalog or `c<n>` for a custom metric. */
  id: string;
  label: string;
  /** The expression (expr.ts grammar); a preset's comes from the catalog. */
  expr: string;
  /** A unit kind of the catalog ('' = none); resolved per row by the tool. */
  unit: string;
  /** A column of the readout table. */
  on: boolean;
  /** Also drawn as a strip chart over time. */
  strip: boolean;
}

/** At most this many metrics in the list (keeps the query within its budget). */
export const MAX_METRICS = 16;
export const MAX_METRIC_LABEL_LENGTH = 32;
export const MAX_METRIC_EXPR_LENGTH = 160;

export interface MetricPreset {
  id: string;
  label: string;
  expr: string;
  unit: string;
  /** A fixed strip-chart range, when the metric has a natural one. */
  range?: [number, number];
  /** Shown in the table by default. */
  defaultOn: boolean;
}

export interface MetricUnitOption {
  /** '' for none; otherwise a kind the tool resolves (`y`, `x`, `y/x`, `y/s`…). */
  value: string;
  /** The editor's name for it ("Y unit", "Y per second"). */
  label: string;
}

/** A tool's statistics payload. Build one per tool at module level. */
export interface MetricCatalog {
  /** Keys the compile cache and test ids. */
  id: string;
  /** Vector variables a row's columns provide (`y` always among them). */
  vectorVars: readonly string[];
  /** Scalar variables beyond the constants (`n`). */
  scalarVars: readonly string[];
  /**
   * Own columns filtered jointly for every metric, referenced or not, so `n`
   * and every aggregate see one row set (Correlation: `x` and `y`, the
   * pairwise rows). `y` is always among them.
   */
  jointVars: readonly string[];
  /**
   * Rows share one index space (Correlation's table rows, Waveform elements),
   * so a referenced row of the same length joins element-wise. False when
   * each row is sampled on its own clock (Trace): a reference is then only
   * ever an aggregate input.
   */
  alignedRows: boolean;
  /**
   * When rows are not aligned: the own column (a time, `t`) a referenced row
   * is resampled on, sample-and-hold, so it joins this row's index space and
   * element-wise mixing compares values at the same instants. Absent, a
   * reference is only ever an aggregate input.
   */
  resampleVar?: string;
  /** The unit kinds, '' first. */
  units: readonly MetricUnitOption[];
  /** The built-in metrics, in default column order. */
  presets: readonly MetricPreset[];
  /** The editor's word for a row: "Y PV", "curve". */
  rowNoun: string;
  /** The variable entries of the editor's reference. */
  variables: readonly ReferenceEntry[];
  /** The editor's one-line example sentence. */
  example: string;
}

/** The catalog as the compiler sees it. */
export function languageOf(catalog: MetricCatalog): ExprLanguage {
  return { isVector: (name) => catalog.vectorVars.includes(name) };
}

export function presetOf(catalog: MetricCatalog, id: string): MetricPreset | undefined {
  return catalog.presets.find((p) => p.id === id);
}

export function isPresetId(catalog: MetricCatalog, id: string): boolean {
  return presetOf(catalog, id) !== undefined;
}

const CUSTOM_ID = /^c[1-9]\d{0,3}$/;

export function isCustomId(id: string): boolean {
  return CUSTOM_ID.test(id);
}

/** The metric of a preset, as it sits in a fresh list. */
export function presetMetric(preset: MetricPreset, on = preset.defaultOn): Metric {
  return {
    id: preset.id,
    label: preset.label,
    expr: preset.expr,
    unit: preset.unit,
    on,
    strip: false,
  };
}

/** The default list: every preset, the `defaultOn` ones on, no strips. */
export function defaultMetrics(catalog: MetricCatalog): Metric[] {
  return catalog.presets.map((p) => presetMetric(p));
}

/** The next unused custom id in `metrics`. */
export function nextCustomId(metrics: readonly Metric[]): string {
  let max = 0;
  for (const m of metrics) {
    if (isCustomId(m.id)) max = Math.max(max, Number(m.id.slice(1)));
  }
  return `c${max + 1}`;
}

export function isMetricUnit(catalog: MetricCatalog, value: unknown): value is string {
  return typeof value === 'string' && catalog.units.some((u) => u.value === value);
}

// A label holds no `=` (the token separator) and does not start with `-` or
// `~` (the token flags), so its token decodes to the same label.
function cleanLabel(value: unknown): string {
  if (typeof value !== 'string') return '';
  const text = value
    .replace(/=/g, '')
    .trim()
    .replace(/^[-~]+/, '')
    .trimStart();
  return [...text].slice(0, MAX_METRIC_LABEL_LENGTH).join('');
}

function cleanExpr(value: unknown): string {
  if (typeof value !== 'string') return '';
  return [...value.replace(/=/g, '').trim()].slice(0, MAX_METRIC_EXPR_LENGTH).join('');
}

/**
 * The canonical list: ids unique (later duplicates dropped), at most
 * `MAX_METRICS`, a preset's label/expr/unit re-stamped from the catalog, a
 * custom's label and expression trimmed, stripped of `=` and capped, its unit
 * a kind of the catalog; any other id is dropped. Pure and idempotent. An
 * expression that does not parse is kept: the editor shows the error and the
 * table "–".
 */
export function normalizeMetrics(
  catalog: MetricCatalog,
  metrics: readonly Metric[] | undefined
): Metric[] {
  const out = normalizedMetrics(catalog, metrics);
  // Identity is kept when nothing changed, so a memo keyed on the list (the
  // readout table) does not recompute on an unrelated edit.
  if (metrics !== undefined && sameMetrics(metrics, out)) return metrics as Metric[];
  return out;
}

function normalizedMetrics(
  catalog: MetricCatalog,
  metrics: readonly Metric[] | undefined
): Metric[] {
  const out: Metric[] = [];
  const seen = new Set<string>();
  for (const raw of metrics ?? []) {
    if (typeof raw !== 'object' || raw === null || typeof raw.id !== 'string') continue;
    if (seen.has(raw.id) || out.length === MAX_METRICS) continue;
    const preset = presetOf(catalog, raw.id);
    const on = raw.on === true;
    const strip = raw.strip === true;
    if (preset !== undefined) {
      out.push({ ...presetMetric(preset, on), strip });
    } else if (isCustomId(raw.id)) {
      out.push({
        id: raw.id,
        label: cleanLabel(raw.label),
        expr: cleanExpr(raw.expr),
        unit: isMetricUnit(catalog, raw.unit) ? raw.unit : '',
        on,
        strip,
      });
    } else continue;
    seen.add(raw.id);
  }
  return out;
}

function sameMetric(a: Metric, b: Metric): boolean {
  return (
    a.id === b.id &&
    a.label === b.label &&
    a.expr === b.expr &&
    a.unit === b.unit &&
    a.on === b.on &&
    a.strip === b.strip
  );
}

export function sameMetrics(a: readonly Metric[], b: readonly Metric[]): boolean {
  return a.length === b.length && a.every((m, i) => sameMetric(m, b[i]));
}

/** Whether `metrics` is the catalog's default list (so the query writes no `m=` key). */
export function metricsAreDefault(catalog: MetricCatalog, metrics: readonly Metric[]): boolean {
  return sameMetrics(metrics, defaultMetrics(catalog));
}

/** The refusal shown when the metric list has no room. */
export function metricsFullMessage(): string {
  return `Metrics are full (${MAX_METRICS}/${MAX_METRICS})`;
}

// ── Compilation and validation ────────────────────────────────────────────

const COMPILE_CACHE_SIZE = 64;
const compileCache = new Map<string, CompileResult>();

/** `compileExpression` in the catalog's language, through a bounded cache (oldest evicted first). */
export function compileMetric(catalog: MetricCatalog, expr: string): CompileResult {
  const key = `${catalog.id}\n${expr}`;
  const hit = compileCache.get(key);
  if (hit !== undefined) return hit;
  const result = compileExpression(expr, languageOf(catalog));
  if (compileCache.size >= COMPILE_CACHE_SIZE) {
    const oldest = compileCache.keys().next();
    if (oldest.done !== true) compileCache.delete(oldest.value);
  }
  compileCache.set(key, result);
  return result;
}

/** "no Y PVs" / "only 2 curves": how many rows the frame has, in the catalog's words. */
export function rowCountText(catalog: MetricCatalog, rowCount: number): string {
  const noun = catalog.rowNoun;
  return rowCount === 0 ? `no ${noun}s` : `only ${rowCount} ${noun}${rowCount === 1 ? '' : 's'}`;
}

/**
 * The error of a referenced variable the catalog does not provide (null when
 * every name is known): a `y<k>` past `rowCount` is "Unknown variable y3:
 * only 2 curves", any other unknown name "Unknown variable foo".
 */
export function unknownVariable(
  catalog: MetricCatalog,
  vars: readonly string[],
  rowCount: number
): string | null {
  for (const name of vars) {
    if (catalog.vectorVars.includes(name) || catalog.scalarVars.includes(name)) continue;
    const k = rowReference(name);
    if (k === null) return `Unknown variable ${name}`;
    if (k > rowCount) return `Unknown variable ${name}: ${rowCountText(catalog, rowCount)}`;
  }
  return null;
}

/**
 * Static check for the editor: the expression compiles and every variable it
 * references exists with `rowCount` rows. Null when valid.
 */
export function validateExpression(
  catalog: MetricCatalog,
  expr: string,
  rowCount: number
): string | null {
  const result = compileMetric(catalog, expr);
  if (!result.ok) return result.error;
  return unknownVariable(catalog, result.compiled.vars, rowCount);
}

// ── Token grammar (the `m=` query key) ────────────────────────────────────────
//
//   token  = flags body
//   flags  = [ "-" ] [ "~" ]        "-" off (not a table column), "~" strip chart
//   body   = preset-id | custom
//   custom = label "=" [ expr ] [ "=" unit ]   unit ∈ the catalog's kinds
//
// Neither label nor expression may contain "=" (the normalizer strips it), so
// the split on "=" is unambiguous, and a label never starts with "-" or "~".
// Tokens are URL-encoded by the serializer.

/** The token of a metric; the custom id is not written (position is identity). */
export function encodeMetricToken(catalog: MetricCatalog, metric: Metric): string {
  const flags = `${metric.on ? '' : '-'}${metric.strip ? '~' : ''}`;
  if (isPresetId(catalog, metric.id)) return `${flags}${metric.id}`;
  const unit = metric.unit === '' ? '' : `=${metric.unit}`;
  return `${flags}${metric.label}=${metric.expr}${unit}`;
}

/**
 * The metric of a token, with `customId` for a custom body; null when the
 * token is structurally bad (unknown preset, empty label, a bad unit, or more
 * than three parts). An empty expression is kept: it is a metric still being
 * written.
 */
export function decodeMetricToken(
  catalog: MetricCatalog,
  token: string,
  customId: string
): Metric | null {
  let rest = token;
  let on = true;
  let strip = false;
  if (rest.startsWith('-')) {
    on = false;
    rest = rest.slice(1);
  }
  if (rest.startsWith('~')) {
    strip = true;
    rest = rest.slice(1);
  }
  if (rest === '') return null;
  if (!rest.includes('=')) {
    const preset = presetOf(catalog, rest);
    return preset === undefined ? null : { ...presetMetric(preset, on), strip };
  }
  const parts = rest.split('=');
  if (parts.length > 3) return null;
  const [labelRaw, exprRaw, unitRaw = ''] = parts;
  const label = cleanLabel(labelRaw);
  const expr = cleanExpr(exprRaw);
  // An empty expression is a metric still being written: it round-trips.
  if (label === '' || !isMetricUnit(catalog, unitRaw)) return null;
  if (!isCustomId(customId)) return null;
  return { id: customId, label, expr, unit: unitRaw, on, strip };
}

/** Every token of a list, in order (the `m=` values of a query). */
export function encodeMetricTokens(catalog: MetricCatalog, metrics: readonly Metric[]): string[] {
  return metrics.map((m) => encodeMetricToken(catalog, m));
}

/**
 * The list of a query's `m=` tokens: structurally bad tokens are dropped
 * (reported through `onBad`), customs are numbered in order, and the result
 * is normalized.
 */
export function decodeMetricTokens(
  catalog: MetricCatalog,
  tokens: readonly string[],
  onBad?: (token: string) => void
): Metric[] {
  const metrics: Metric[] = [];
  for (const token of tokens) {
    const metric = decodeMetricToken(catalog, token, nextCustomId(metrics));
    if (metric === null) onBad?.(token);
    else metrics.push(metric);
  }
  return normalizeMetrics(catalog, metrics);
}
