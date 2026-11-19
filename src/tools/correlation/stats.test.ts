import { describe, expect, it } from 'vitest';
import goldenRaw from './__fixtures__/golden.json?raw';
import ormFrameRaw from './__fixtures__/orm-frame.json?raw';
import { evaluateMetrics, formatSig, type MetricTable } from '../../statistics/evaluate';
import {
  columnStats,
  correlationStatFrame,
  fitStats,
  hasSpread,
  pairStats,
  rowsPerSecond,
  slopeUnits,
  yColumns,
  type FrameLike,
} from './stats';
import { CORRELATION_METRICS } from './metrics';
import { defaultMetrics, type Metric } from '../../statistics/model';

// The oracle fixtures are byte-pinned; __fixtures__/README.md names their
// generator and the other test that pins the same digests.
const GOLDEN_SHA256 = 'bd092873f4943dd44615e4b5e49f4be1e8db203e989974953accdbfa8f42fc67';
const ORM_FRAME_SHA256 = 'e4b5ba681c6294a9562dfaa25b3a3129ec6735a5149d91558dd5be9b97fc912d';

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Relative 1e-9, absolute 1e-15 near zero. */
function expectClose(actual: number | null, expected: number) {
  expect(actual).not.toBeNull();
  const tol = Math.max(1e-9 * Math.abs(expected), 1e-15);
  expect(Math.abs((actual as number) - expected)).toBeLessThanOrEqual(tol);
}

describe('fit statistics degenerate cases', () => {
  it('no rows: n 0, everything undefined', () => {
    const s = pairStats([], []);
    expect(s).toMatchObject({ n: 0, mean: null, std: null, r: null, slope: null, intercept: null });
    expect(columnStats([])).toEqual({ n: 0, mean: null, std: null });
  });

  it('one pair: mean only', () => {
    const s = pairStats([1], [2]);
    expect(s).toMatchObject({
      n: 1,
      mean: 2,
      std: null,
      r: null,
      r2: null,
      slope: null,
      intercept: null,
    });
    expect(columnStats([3])).toEqual({ n: 1, mean: 3, std: null });
  });

  it('two pairs with X spread: std, slope and intercept, but no r', () => {
    const s = pairStats([0, 2], [1, 5]);
    expect(s.n).toBe(2);
    expect(s.std).toBeCloseTo(Math.SQRT2 * 2, 12);
    expect(s.slope).toBeCloseTo(2, 12);
    expect(s.intercept).toBeCloseTo(1, 12);
    expect(s.r).toBeNull();
    expect(s.r2).toBeNull();
  });

  it('three pairs, X constant: no slope, no intercept, no r', () => {
    const s = pairStats([4, 4, 4], [1, 2, 3]);
    expect(s).toMatchObject({ n: 3, mean: 2, r: null, slope: null, intercept: null });
    expect(s.std).toBeCloseTo(1, 12);
  });

  it('three pairs, Y constant: slope 0, but no r', () => {
    const s = pairStats([1, 2, 3], [7, 7, 7]);
    expect(s.slope).toBe(0);
    expect(s.intercept).toBe(7);
    expect(s.r).toBeNull();
    expect(s.std).toBe(0);
  });

  it('a perfect line: r clipped into ±1, R² = r²', () => {
    const xs = [0.1, 0.2, 0.3, 0.7];
    const s = pairStats(
      xs,
      xs.map((x) => 3 * x)
    );
    expect(s.r).not.toBeNull();
    expect(s.r as number).toBeLessThanOrEqual(1);
    expect(s.r).toBeCloseTo(1, 12);
    expect(s.r2).toBe((s.r as number) * (s.r as number));
    const neg = pairStats(
      xs,
      xs.map((x) => -3 * x)
    );
    expect(neg.r as number).toBeGreaterThanOrEqual(-1);
  });

  it('pairwise non-null: a null in either column drops the row', () => {
    const s = pairStats([1, null, 3, 4, 5], [2, 4, null, 8, 10]);
    expect(s.n).toBe(3);
    expect(s.slope).toBeCloseTo(2, 12);
    expect(s.xMin).toBe(1);
    expect(s.xMax).toBe(5);
    expect(columnStats([1, null, 3])).toMatchObject({ n: 2, mean: 2 });
  });

  it('tiny but real spread is spread (no tolerance)', () => {
    expect(hasSpread([1e-12, 2e-12, 3e-12])).toBe(true);
    expect(hasSpread([5, 5])).toBe(false);
    expect(hasSpread([5])).toBe(false);
  });

  it('formats 4 significant digits with units, "–" for undefined', () => {
    expect(formatSig(null)).toBe('–');
    expect(formatSig(Number.NaN)).toBe('–');
    expect(formatSig(4.456650566e-6, 'm/A')).toBe('4.457e-6 m/A');
    expect(formatSig(12345.6)).toBe('1.235e4');
    expect(formatSig(0.5, 'A')).toBe('0.5000 A');
    expect(formatSig(0)).toBe('0');
    expect(slopeUnits('m', 'A')).toBe('m/A');
    expect(slopeUnits('', '')).toBe('');
  });

  it('rows/s over the trailing 10 s, "–" until the frame reaches back 10 s', () => {
    const s = 1_000_000_000;
    const base = 1_790_000_000_000_000_000;
    expect(rowsPerSecond([])).toBeNull();
    expect(rowsPerSecond([base, base + 5 * s])).toBeNull();
    const ts = Array.from({ length: 21 }, (_, i) => base + i * 0.5 * s);
    // newest = base + 10 s; rows strictly newer than base: 20 rows over 10 s.
    expect(rowsPerSecond(ts)).toBe(2);
  });

  it('fitStats takes names from the frame and orders Ys y1..yk', () => {
    expect(yColumns({ y10: 'j', x: 'a', y2: 'c', y1: 'b' })).toEqual(['y1', 'y2', 'y10']);
    expect(fitStats(null)).toEqual({ x: null, ys: [], rowsPerS: null });
  });
});

describe('fitStats on the oracle fixture', () => {
  it('fixtures are unchanged (sha256)', async () => {
    expect(await sha256(goldenRaw)).toBe(GOLDEN_SHA256);
    expect(await sha256(ormFrameRaw)).toBe(ORM_FRAME_SHA256);
  });

  it('matches the numpy goldens within relative 1e-9 / absolute 1e-15', () => {
    const frame = JSON.parse(ormFrameRaw) as FrameLike;
    const golden = JSON.parse(goldenRaw) as {
      x: { pv: string; n: number; mean: number; std: number };
      ys: Record<
        string,
        { pv: string; n: number } & Record<
          'mean' | 'std' | 'r' | 'r2' | 'slope' | 'intercept',
          number
        >
      >;
    };
    const r = fitStats(frame);
    expect(r.x?.pv).toBe(golden.x.pv);
    expect(r.x?.stats.n).toBe(golden.x.n);
    expectClose(r.x?.stats.mean ?? null, golden.x.mean);
    expectClose(r.x?.stats.std ?? null, golden.x.std);
    expect(r.ys.map((y) => y.column)).toEqual(Object.keys(golden.ys));
    for (const row of r.ys) {
      const g = golden.ys[row.column];
      expect(row.pv).toBe(g.pv);
      expect(row.stats.n).toBe(g.n);
      for (const key of ['mean', 'std', 'r', 'r2', 'slope', 'intercept'] as const) {
        expectClose(row.stats[key], g[key]);
      }
    }
  });
});

const S = 1_000_000_000;
const BASE = 1_790_000_000_000_000_000;

function synthetic(columns: Record<string, (number | null)[]>, dtS = 1): FrameLike {
  const rows = columns.x.length;
  const tsNs = Array.from({ length: rows }, (_, i) => BASE + i * dtS * S);
  const columnPvs: Record<string, string> = {};
  for (const c of Object.keys(columns)) columnPvs[c] = `${c.toUpperCase()}:PV`;
  return { table: { tsNs, columns, inputs: {}, totalRows: rows }, columnPvs };
}

function custom(id: string, expr: string, over: Partial<Metric> = {}): Metric {
  return { id, label: id, expr, unit: '', on: true, strip: false, ...over };
}

/** The value of metric `id` for Y column `column`. */
function cell(table: MetricTable, column: string, id: string): number | null {
  const row = table.rows.find((r) => r.id === column);
  expect(row).toBeDefined();
  return row?.cells[id]?.value ?? null;
}

describe('evaluateMetrics', () => {
  it('the presets reproduce fitStats() on the golden fixture (1e-12)', () => {
    const frame = JSON.parse(ormFrameRaw) as FrameLike;
    const table = evaluateMetrics(
      CORRELATION_METRICS,
      correlationStatFrame(frame),
      defaultMetrics(CORRELATION_METRICS)
    );
    const old = fitStats(frame);
    expect(table.errors).toEqual({});
    expect(table.rows.map((r) => [r.id, r.label])).toEqual(old.ys.map((y) => [y.column, y.pv]));
    const ids = {
      mean: 'mean',
      std: 'std',
      r: 'r',
      r2: 'r2',
      slope: 'slope',
      intercept: 'intercept',
    };
    for (const y of old.ys) {
      expect(cell(table, y.column, 'n')).toBe(y.stats.n);
      for (const [key, id] of Object.entries(ids) as [keyof typeof ids, string][]) {
        const expected = y.stats[key];
        expect(expected).not.toBeNull();
        const actual = cell(table, y.column, id);
        expect(actual).not.toBeNull();
        const tol = Math.max(1e-12 * Math.abs(expected as number), 1e-15);
        expect(Math.abs((actual as number) - (expected as number))).toBeLessThanOrEqual(tol);
      }
    }
  });

  it('evaluates every metric, on or not, for every Y; rows are Ys only', () => {
    const frame = synthetic({ x: [0, 1, 2, 3], y1: [1, 3, 5, 7], y2: [0, -1, -2, -3] });
    const metrics = defaultMetrics(CORRELATION_METRICS);
    const table = evaluateMetrics(CORRELATION_METRICS, correlationStatFrame(frame), metrics);
    expect(table.rows.map((r) => r.id)).toEqual(['y1', 'y2']);
    for (const row of table.rows) expect(Object.keys(row.cells)).toEqual(metrics.map((m) => m.id));
    expect(cell(table, 'y1', 'slope')).toBeCloseTo(2, 12);
    expect(cell(table, 'y1', 'intercept')).toBeCloseTo(1, 12);
    expect(cell(table, 'y2', 'xmean')).toBeCloseTo(1.5, 12);
    expect(evaluateMetrics(CORRELATION_METRICS, correlationStatFrame(null), metrics)).toEqual({
      rows: [],
      errors: {},
    });
  });

  it('cross-Y references: y2 - y1 over the rows where x, this Y, y1 and y2 are finite', () => {
    const frame = synthetic({
      x: [0, 1, 2, 3, 4],
      y1: [1, 2, 3, 4, null],
      y2: [11, null, 13, 14, 15],
    });
    const table = evaluateMetrics(CORRELATION_METRICS, correlationStatFrame(frame), [
      custom('c1', 'mean(y2 - y1)'),
      custom('c2', 'n'),
    ]);
    // Rows 0, 2, 3 for both Ys: differences 10, 10, 10.
    expect(cell(table, 'y1', 'c1')).toBe(10);
    expect(cell(table, 'y2', 'c1')).toBe(10);
    // `n` alone references nothing: it counts this Y's pairwise rows.
    expect(cell(table, 'y1', 'c2')).toBe(4);
    expect(cell(table, 'y2', 'c2')).toBe(4);
  });

  it('row filtering: a null in X or in this Y drops the row for every metric of that Y', () => {
    const frame = synthetic({
      x: [0, null, 2, 3, 4, 5],
      y1: [0, 1, null, 3, 4, 5],
      y2: [0, 1, 2, 3, 4, Number.NaN],
    });
    const table = evaluateMetrics(
      CORRELATION_METRICS,
      correlationStatFrame(frame),
      defaultMetrics(CORRELATION_METRICS)
    );
    expect(cell(table, 'y1', 'n')).toBe(4);
    expect(cell(table, 'y1', 'mean')).toBe(3);
    expect(cell(table, 'y2', 'n')).toBe(4);
    expect(cell(table, 'y2', 'mean')).toBe(2.25);
    expect(cell(table, 'y2', 'xmean')).toBe(2.25);
  });

  it('t is seconds relative to the newest row: slope(t, y) is the drift of a ramp', () => {
    const t = Array.from({ length: 21 }, (_, i) => i * 0.5);
    const frame = synthetic({ x: t.map(() => 1), y1: t.map((s) => 3 + 0.25 * s) }, 0.5);
    const table = evaluateMetrics(CORRELATION_METRICS, correlationStatFrame(frame), [
      custom('c1', 'slope(t, y)'),
      custom('c2', 'max(t)'),
      custom('c3', 'min(t)'),
      custom('c4', 'last(y)'),
    ]);
    expect(cell(table, 'y1', 'c1')).toBeCloseTo(0.25, 12);
    expect(cell(table, 'y1', 'c2')).toBe(0);
    expect(cell(table, 'y1', 'c3')).toBe(-10);
    expect(cell(table, 'y1', 'c4')).toBe(5.5);
  });

  it('a compile error or unknown variable marks the column; a y<k> past the Ys marks its cells', () => {
    const frame = synthetic({ x: [0, 1, 2], y1: [0, 1, 2], y2: [2, 1, 0] });
    const table = evaluateMetrics(CORRELATION_METRICS, correlationStatFrame(frame), [
      custom('c1', 'mean('),
      custom('c2', 'mean(foo)'),
      custom('c3', 'mean(y3)'),
      custom('c4', 'mean(y)'),
    ]);
    expect(Object.keys(table.errors)).toEqual(['c1', 'c2']);
    expect(table.errors.c2).toBe('Unknown variable foo');
    for (const row of table.rows) {
      expect(row.cells.c1).toEqual({ value: null, error: table.errors.c1 });
      expect(row.cells.c2.value).toBeNull();
      expect(row.cells.c3).toEqual({ value: null, error: 'Unknown variable y3: only 2 Y PVs' });
      expect(row.cells.c4.error).toBeUndefined();
    }
    expect(cell(table, 'y2', 'c4')).toBe(1);
    // Errors are known without a frame.
    expect(
      Object.keys(
        evaluateMetrics(CORRELATION_METRICS, correlationStatFrame(null), [custom('c1', '1 +')])
          .errors
      )
    ).toEqual(['c1']);
  });
});
