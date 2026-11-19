// The correlation statistics outside the metric table: the closed-form fit
// statistics and the frame adapter for the shared statistics library
// (src/statistics).
//
// Metrics: the readout table is the state's metric list (the
// `CORRELATION_METRICS` catalog) evaluated by the library's `evaluateMetrics`
// over `correlationStatFrame(frame)`: one row per Y with the columns `x`, `y`
// and `t` (seconds relative to the frame's newest row, ≤ 0). The catalog's
// joint set is `x` and `y`, so a row's evaluation sees the rows where X, its
// Y and every referenced Y are finite.
//
// Fit line: `pairStats` / `fitStats` compute the closed-form statistics the
// fit line and the menu's "Copy fit" use: n, mean (n ≥ 1), sample std,
// ddof = 1 (n ≥ 2), r (n ≥ 3, spread in both, clipped to ±1), slope and
// intercept (n ≥ 2, spread in X), R² = r², over the pairwise non-null rows; a
// Y without a slope draws no fit line. The preset metrics reproduce these
// numbers (golden parity test).
//
// "Spread" matches the reference implementation: a column has none when its
// min equals its max, or when its centred sum of squares underflows to zero.
// No tolerance: r is scale-invariant, so a nano-scale signal is a valid input.
//
// Everything is two-pass (means first, then centred sums), so the numbers
// match numpy's to ~1e-15 relative on well-conditioned data; the oracle
// fixture pins them to golden values at 1e-9.
//
// Rows/s: rows over the trailing 10 s of the data clock (the newest tsNs),
// null until the frame reaches 10 s back; shown in the health line.

import type { TableResultDTO } from '@slaclab/canopy-client';
import type { StatFrame } from '../../statistics/evaluate';

export interface ColumnStats {
  n: number;
  mean: number | null;
  std: number | null;
}

export interface PairStats extends ColumnStats {
  r: number | null;
  r2: number | null;
  slope: number | null;
  intercept: number | null;
  /** X range of the pairwise rows, for the fit line; null with no rows. */
  xMin: number | null;
  xMax: number | null;
}

export interface FitStatsRow<S> {
  column: string;
  pv: string;
  stats: S;
}

/** The closed-form statistics of a frame: X's column stats and each Y's pair stats. */
export interface FitStats {
  x: FitStatsRow<ColumnStats> | null;
  ys: FitStatsRow<PairStats>[];
  /** Rows per second over the trailing 10 s; null until filled. */
  rowsPerS: number | null;
}

/** A frame as the statistics see it: a table and its own column→PV map. */
export interface FrameLike {
  table: TableResultDTO;
  columnPvs: Record<string, string>;
}

export const RATE_WINDOW_NS = 10_000_000_000;

function mean(values: number[]): number {
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

function centredSquares(values: number[], m: number): number {
  let sum = 0;
  for (const v of values) sum += (v - m) * (v - m);
  return sum;
}

/** Whether a column varies enough for a correlation or fit to exist. */
export function hasSpread(values: number[]): boolean {
  if (values.length < 2) return false;
  let min = values[0];
  let max = values[0];
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min === max) return false;
  return centredSquares(values, mean(values)) / (values.length - 1) > 0;
}

/** n, mean, sample std of the non-null cells. */
export function columnStats(cells: (number | null)[]): ColumnStats {
  const values = cells.filter((v): v is number => v !== null && Number.isFinite(v));
  const n = values.length;
  if (n === 0) return { n, mean: null, std: null };
  const m = mean(values);
  const std = n >= 2 ? Math.sqrt(centredSquares(values, m) / (n - 1)) : null;
  return { n, mean: m, std };
}

/** A Y's fit statistics over the pairwise non-null rows of `xCells` and `yCells`. */
export function pairStats(xCells: (number | null)[], yCells: (number | null)[]): PairStats {
  const xs: number[] = [];
  const ys: number[] = [];
  const len = Math.min(xCells.length, yCells.length);
  for (let i = 0; i < len; i++) {
    const x = xCells[i];
    const y = yCells[i];
    if (x === null || y === null || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    xs.push(x);
    ys.push(y);
  }
  const n = xs.length;
  const out: PairStats = {
    n,
    mean: null,
    std: null,
    r: null,
    r2: null,
    slope: null,
    intercept: null,
    xMin: null,
    xMax: null,
  };
  if (n === 0) return out;
  const mx = mean(xs);
  const my = mean(ys);
  out.mean = my;
  out.xMin = Math.min(...xs);
  out.xMax = Math.max(...xs);
  if (n < 2) return out;

  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  out.std = Math.sqrt(syy / (n - 1));
  const xSpread = hasSpread(xs);
  if (xSpread) {
    out.slope = sxy / sxx;
    out.intercept = my - out.slope * mx;
  }
  if (n >= 3 && xSpread && hasSpread(ys)) {
    const r = Math.min(1, Math.max(-1, sxy / Math.sqrt(sxx * syy)));
    out.r = r;
    out.r2 = r * r;
  }
  return out;
}

/** Rows per second over the trailing 10 s of the data clock; null until filled. */
export function rowsPerSecond(tsNs: number[]): number | null {
  if (tsNs.length === 0) return null;
  const newest = tsNs[tsNs.length - 1];
  const from = newest - RATE_WINDOW_NS;
  if (tsNs[0] > from) return null;
  let count = 0;
  for (let i = tsNs.length - 1; i >= 0 && tsNs[i] > from; i--) count++;
  return count / (RATE_WINDOW_NS / 1e9);
}

/** Y columns of a frame in colour order: `y`, or `y1..yk`. */
export function yColumns(columnPvs: Record<string, string>): string[] {
  return Object.keys(columnPvs)
    .filter((c) => c === 'y' || /^y\d+$/.test(c))
    .sort((a, b) => (a === 'y' ? 0 : Number(a.slice(1))) - (b === 'y' ? 0 : Number(b.slice(1))));
}

/** The fit statistics of a frame. */
export function fitStats(frame: FrameLike | null): FitStats {
  if (frame === null) return { x: null, ys: [], rowsPerS: null };
  const { table, columnPvs } = frame;
  const xCells = table.columns.x ?? [];
  const x =
    columnPvs.x !== undefined ? { column: 'x', pv: columnPvs.x, stats: columnStats(xCells) } : null;
  const ys = yColumns(columnPvs).map((column) => ({
    column,
    pv: columnPvs[column],
    stats: pairStats(xCells, table.columns[column] ?? []),
  }));
  return { x, ys, rowsPerS: rowsPerSecond(table.tsNs) };
}

/** The unit of a slope: Y per X. */
export function slopeUnits(yUnits: string, xUnits: string): string {
  if (yUnits === '' && xUnits === '') return '';
  return `${yUnits === '' ? '1' : yUnits}/${xUnits === '' ? '1' : xUnits}`;
}

// ── Metric frame ──────────────────────────────────────────────────────────

/**
 * The frame as the statistics library sees it: one row per Y (`id` the
 * column, `label` the PV) with `x`, `y` and `t` over the table's rows.
 */
export function correlationStatFrame(frame: FrameLike | null): StatFrame | null {
  if (frame === null) return null;
  const { table, columnPvs } = frame;
  const xCells = table.columns.x ?? [];
  const newest = table.tsNs.length === 0 ? 0 : table.tsNs[table.tsNs.length - 1];
  const t = Float64Array.from(table.tsNs, (ts) => (ts - newest) / 1e9);
  const rows = yColumns(columnPvs).map((column) => ({
    id: column,
    label: columnPvs[column],
    columns: { x: xCells, y: table.columns[column] ?? [], t },
  }));
  return { rows };
}
