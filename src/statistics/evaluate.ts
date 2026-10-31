// The evaluator shared by every tool: a metric list (model.ts) over a frame,
// one row per entity (a Y PV, a waveform curve, a Trace curve), one cell per
// metric.
//
// Frame model: a row has named vector columns in one index space
// — `y` always, plus the catalog's others (`x`, `t`, `i`). A row's evaluation
// sees the indices where every referenced own column is finite (`n` is their
// count). A cross-row reference `y<k>` is the k-th row's `y` — k counts every
// row, hidden ones included, so it is the position in the tool's list. In an
// aligned catalog (`alignedRows`) a reference of the same length joins the
// joint filter (Correlation's table, Waveform curves of one length); in one
// that is not (Trace) it is resampled onto this row's `resampleVar` column,
// sample-and-hold, and joins that way; any other reference is filtered on
// its own — aggregates of it work, element-wise mixing is NaN, shown "–".
// Undefined is `null` — shown as "–", never 0. An expression that does not
// compile, or names an unknown variable, is an error of its whole column
// (`MetricTable.errors`); a `y<k>` past the frame's row count is an error of
// each cell. Row sets are built once per distinct column set per row and
// shared by every metric that needs that set.

import type { ExprEnv } from './expr';
import { rowReference } from './expr';
import { compileMetric, unknownVariable, type Metric, type MetricCatalog } from './model';

/** A column: samples by index; null and non-finite entries are "no value". */
export type StatColumn = ArrayLike<number | null>;

export interface StatRow {
  /** Stable key (test ids, strip history). */
  id: string;
  /** What the table calls the row. */
  label: string;
  /** The row's colour, set by the tool; the panel draws the row in it. */
  color?: string;
  /**
   * Evaluated and referenceable as `y<k>` (its position is its list position),
   * but not shown in the table or the strips: a hidden or undrawn curve.
   */
  hidden?: boolean;
  /** The row's vectors, all of one length; `y` is required. */
  columns: Readonly<Record<string, StatColumn>>;
}

export interface StatFrame {
  rows: readonly StatRow[];
}

export const SIGNIFICANT_DIGITS = 4;

export interface MetricCell {
  value: number | null;
  /** Why the cell has no value beyond "undefined" (a `y<k>` past the row count). */
  error?: string;
}

export interface MetricRow {
  id: string;
  label: string;
  color?: string;
  /** Not shown (see `StatRow.hidden`). */
  hidden?: boolean;
  /** Metric id → its value for this row. */
  cells: Record<string, MetricCell>;
}

export interface MetricTable {
  /** One row per frame row, in order. */
  rows: MetricRow[];
  /** Metric id → compile error, for an invalid column header. */
  errors: Record<string, string>;
}

export const EMPTY_TABLE: MetricTable = { rows: [], errors: {} };

/** A metric ready to evaluate, or the reason its column (or every cell) has none. */
type MetricPlan =
  | { id: string; kind: 'error'; error: string }
  | { id: string; kind: 'cells-error'; error: string }
  | {
      id: string;
      kind: 'ok';
      evaluate: (env: ExprEnv) => number | null;
      /** The row's own columns the expression reads. */
      own: string[];
      /** The rows (1-based) the expression reads through `y<k>`. */
      refs: number[];
    };

function planMetric(catalog: MetricCatalog, metric: Metric, rowCount: number): MetricPlan {
  const result = compileMetric(catalog, metric.expr);
  if (!result.ok) return { id: metric.id, kind: 'error', error: result.error };
  const vars = result.compiled.vars;
  const unknown = unknownVariable(catalog, vars, Number.POSITIVE_INFINITY);
  if (unknown !== null) return { id: metric.id, kind: 'error', error: unknown };
  const past = unknownVariable(catalog, vars, rowCount);
  if (past !== null) return { id: metric.id, kind: 'cells-error', error: past };
  const own: string[] = [];
  const refs: number[] = [];
  for (const name of vars) {
    const k = rowReference(name);
    if (k !== null) refs.push(k);
    else if (catalog.vectorVars.includes(name)) own.push(name);
  }
  return { id: metric.id, kind: 'ok', evaluate: (env) => result.compiled.evaluate(env), own, refs };
}

function isFinite(v: number | null | undefined): v is number {
  return v !== null && v !== undefined && Number.isFinite(v);
}

/** The indices where every column is finite. */
function finiteIndices(columns: readonly StatColumn[]): number[] {
  const len = Math.min(...columns.map((c) => c.length));
  const keep: number[] = [];
  for (let i = 0; i < len; i++) {
    let ok = true;
    for (const col of columns) {
      if (!isFinite(col[i])) {
        ok = false;
        break;
      }
    }
    if (ok) keep.push(i);
  }
  return keep;
}

/**
 * `values` (sampled at the ascending times `at`) held onto the ascending
 * times `onto`: each output is the last finite value at or before its time,
 * NaN before the first sample.
 */
export function resample(at: StatColumn, values: StatColumn, onto: StatColumn): Float64Array {
  const out = new Float64Array(onto.length);
  let j = 0;
  let held = NaN;
  const n = Math.min(at.length, values.length);
  for (let i = 0; i < onto.length; i++) {
    const t = onto[i];
    if (!isFinite(t)) {
      out[i] = NaN;
      continue;
    }
    while (j < n) {
      const tj = at[j];
      if (!isFinite(tj) || tj > t) break;
      const v = values[j];
      if (isFinite(v)) held = v;
      j++;
    }
    out[i] = held;
  }
  return out;
}

function gather(column: StatColumn, keep: readonly number[]): Float64Array {
  return Float64Array.from(keep, (i) => column[i] as number);
}

/** A column on its own: its finite values in order. */
function finiteValues(column: StatColumn): Float64Array {
  const out: number[] = [];
  for (let i = 0; i < column.length; i++) {
    const v = column[i];
    if (isFinite(v)) out.push(v);
  }
  return Float64Array.from(out);
}

/** The length every own column of a row shares (the shortest, defensively). */
function rowLength(row: StatRow): number {
  let len = Number.POSITIVE_INFINITY;
  for (const col of Object.values(row.columns)) len = Math.min(len, col.length);
  return Number.isFinite(len) ? len : 0;
}

/**
 * Every metric of `metrics` (on or not: the strips need them all) for every
 * row of the frame. A metric whose expression does not compile, or names an
 * unknown variable, is listed in `errors` and every cell of it carries that
 * error with no value.
 */
export function evaluateMetrics(
  catalog: MetricCatalog,
  frame: StatFrame | null,
  metrics: readonly Metric[]
): MetricTable {
  const rows = frame?.rows ?? [];
  const plans = metrics.map((m) => planMetric(catalog, m, rows.length));
  const errors: Record<string, string> = {};
  for (const plan of plans) if (plan.kind === 'error') errors[plan.id] = plan.error;
  if (frame === null) return { rows: [], errors };

  const out = rows.map((row): MetricRow => {
    const cells: Record<string, MetricCell> = {};
    const len = rowLength(row);
    // Joint row sets, keyed by the sorted names they filter on.
    const sets = new Map<string, { keep: number[]; vectors: Record<string, Float64Array> }>();
    for (const plan of plans) {
      if (plan.kind !== 'ok') {
        cells[plan.id] = { value: null, error: plan.error };
        continue;
      }
      // The columns filtered together: the catalog's joint set (`y` always),
      // the row's own columns the expression reads, and a referenced row's
      // `y` of the same length.
      const joint: { name: string; column: StatColumn }[] = [];
      const seen = new Set<string>();
      const take = (name: string, column: StatColumn | undefined) => {
        if (column === undefined || seen.has(name)) return;
        seen.add(name);
        joint.push({ name, column });
      };
      take('y', row.columns.y);
      for (const name of catalog.jointVars) take(name, row.columns[name]);
      for (const name of plan.own) take(name, row.columns[name]);
      const alone: { name: string; column: StatColumn }[] = [];
      for (const k of plan.refs) {
        const other = rows[k - 1];
        if (other === undefined) continue;
        const name = `y${k}`;
        if (other === row) {
          // y<k> naming this very row is its own y.
          if (!seen.has(name)) {
            seen.add(name);
            joint.push({ name, column: row.columns.y });
          }
        } else if (catalog.alignedRows && rowLength(other) === len) take(name, other.columns.y);
        else if (!catalog.alignedRows && catalog.resampleVar !== undefined) {
          const onto = row.columns[catalog.resampleVar];
          const from = other.columns[catalog.resampleVar];
          if (onto !== undefined && from !== undefined) {
            take(name, resample(from, other.columns.y, onto));
          } else alone.push({ name, column: other.columns.y });
        } else alone.push({ name, column: other.columns.y });
      }
      const missing = plan.own.find((name) => row.columns[name] === undefined);
      if (missing !== undefined) {
        cells[plan.id] = { value: null, error: `${missing} is not available here` };
        continue;
      }
      const key = joint
        .map((c) => c.name)
        .sort()
        .join('\n');
      let set = sets.get(key);
      if (set === undefined) {
        const keep = finiteIndices(joint.map((c) => c.column));
        const vectors: Record<string, Float64Array> = {};
        for (const c of joint) vectors[c.name] = gather(c.column, keep);
        set = { keep, vectors };
        sets.set(key, set);
      }
      const env: Record<string, Float64Array | number> = { ...set.vectors, n: set.keep.length };
      for (const c of alone) env[c.name] = finiteValues(c.column);
      // A metric that throws while evaluating (a bug, never an input the
      // compiler accepts) costs its own cell, not the whole table.
      try {
        cells[plan.id] = { value: plan.evaluate(env) };
      } catch (err) {
        cells[plan.id] = { value: null, error: err instanceof Error ? err.message : String(err) };
      }
    }
    const result: MetricRow = { id: row.id, label: row.label, cells };
    if (row.color !== undefined) result.color = row.color;
    if (row.hidden === true) result.hidden = true;
    return result;
  });
  return { rows: out, errors };
}

/** A value to 4 significant digits, "–" when undefined. */
export function formatSig(value: number | null | undefined, units = ''): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '–';
  const exp = value === 0 ? 0 : Math.floor(Math.log10(Math.abs(value)));
  const text =
    value === 0
      ? '0'
      : exp < -3 || exp >= SIGNIFICANT_DIGITS
        ? value.toExponential(SIGNIFICANT_DIGITS - 1)
        : value.toPrecision(SIGNIFICANT_DIGITS);
  const clean = text.replace(/e\+?/, 'e');
  return units === '' ? clean : `${clean} ${units}`;
}

const COUNT_EXPR = /^(n|count\(.*\)|argmin\(.*\)|argmax\(.*\)|at\(i,.*\))$/;

/** The text of one cell: a count or an element index as the integer it is, anything else to 4 significant digits. */
export function cellText(metric: Metric, value: number | null, unit: string): string {
  if (value !== null && Number.isInteger(value) && COUNT_EXPR.test(metric.expr.replace(/\s/g, '')))
    return String(value);
  return formatSig(value, unit);
}

/**
 * Whether the statistics panel would render anything: a strip chart is drawn
 * from the moment it is on (its axes wait for data); the table needs a row
 * and a column.
 */
export function panelHasContent(metrics: readonly Metric[], table: MetricTable): boolean {
  if (metrics.some((m) => m.strip)) return true;
  return shownRows(table).length > 0 && metrics.some((m) => m.on);
}

/** The table's rows that are shown (not hidden), in order. */
export function shownRows(table: MetricTable): MetricRow[] {
  return table.rows.filter((r) => r.hidden !== true);
}
