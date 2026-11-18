// Log axes: the fit line and the density are computed in the axis's scale
// (log10 of the values on a log axis), points a log axis cannot show (≤ 0)
// are left out of every series and counted, and the count reaches the health
// line as a suffix.
import { describe, expect, it } from 'vitest';
import type { TableResultDTO } from '@slaclab/canopy-client';
import { drawingThemeFor } from '../../annotationTheme';
import { hexBin, hexVertices } from './Density';
import { healthLine, initialHealth, logAxisNote, withHealthSuffix } from './health';
import { logAxisOmitted, plotOption, type PlotOptionInput } from './plotOption';
import type { FrameLike } from './stats';

function frameOf(xs: (number | null)[], ys: Record<string, (number | null)[]>): FrameLike {
  const tsNs = xs.map((_, i) => i * 1e9);
  const columnPvs: Record<string, string> = { x: 'TEST:SINE' };
  const columns: Record<string, (number | null)[]> = { x: xs };
  for (const [column, cells] of Object.entries(ys)) {
    columnPvs[column] = `DEMO:${column.toUpperCase()}`;
    columns[column] = cells;
  }
  const table: TableResultDTO = { tsNs, columns, inputs: {}, totalRows: xs.length };
  return { table, columnPvs };
}

function input(frame: FrameLike, extra: Partial<PlotOptionInput> = {}): PlotOptionInput {
  return {
    frame,
    view: 'scatter',
    axes: 'shared',
    densityPv: '',
    unitsOf: () => '',
    theme: drawingThemeFor('dark'),
    hidden: new Set(),
    width: 900,
    ...extra,
  };
}

interface SeriesLike {
  type?: string;
  name?: string;
  data?: unknown[];
}

function seriesOf(o: ReturnType<typeof plotOption>): SeriesLike[] {
  return o.series as SeriesLike[];
}

const LOG = { log: true };
const range = (n: number) => Array.from({ length: n }, (_, i) => i);

describe('the fit line on log axes', () => {
  it('log X and log Y: a power law is fitted in log–log space', () => {
    const xs = range(20).map((i) => 10 ** (i / 5));
    const ys = xs.map((x) => 3 * x ** 2);
    const o = plotOption(input(frameOf(xs, { y: ys }), { xScale: LOG, yScale: LOG }));
    const line = seriesOf(o).find((s) => s.type === 'line')!;
    const [[x0, y0], [x1, y1]] = line.data as [number, number][];
    expect(x0).toBeCloseTo(1, 9);
    expect(x1).toBeCloseTo(xs[19], 6);
    expect(y0 / (3 * x0 ** 2)).toBeCloseTo(1, 9);
    expect(y1 / (3 * x1 ** 2)).toBeCloseTo(1, 9);
  });

  it('log Y only: an exponential is fitted on (x, log y)', () => {
    const xs = range(20);
    const ys = xs.map((x) => 2 * 10 ** (x / 4));
    const o = plotOption(input(frameOf(xs, { y: ys }), { yScale: LOG }));
    const line = seriesOf(o).find((s) => s.type === 'line')!;
    const [[x0, y0], [x1, y1]] = line.data as [number, number][];
    expect([x0, x1]).toEqual([0, 19]);
    expect(y0 / 2).toBeCloseTo(1, 9);
    expect(y1 / (2 * 10 ** (19 / 4))).toBeCloseTo(1, 9);
  });

  it('the fit leaves out the points the log axis cannot show', () => {
    const xs = [-5, 0, 1, 10, 100];
    const ys = [7, 7, 1, 10, 100];
    const o = plotOption(input(frameOf(xs, { y: ys }), { xScale: LOG, yScale: LOG }));
    const line = seriesOf(o).find((s) => s.type === 'line')!;
    const [[x0, y0], [x1, y1]] = line.data as [number, number][];
    expect([x0, y0]).toEqual([1, 1]);
    expect(x1).toBeCloseTo(100, 9);
    expect(y1).toBeCloseTo(100, 9);
  });

  it('linear axes draw the fit as before', () => {
    const xs = range(10);
    const o = plotOption(input(frameOf(xs, { y: xs.map((x) => 2 * x + 1) })));
    const line = seriesOf(o).find((s) => s.type === 'line')!;
    expect(line.data).toEqual([
      [0, 1],
      [9, 19],
    ]);
  });
});

describe('points a log axis cannot show', () => {
  // An enum-like Y (0 and 1) and an X with a negative value.
  const xs = [-1, 1, 2, 3, 4, 5];
  const enumY = [0, 1, 0, 1, 1, 0];
  const frame = frameOf(xs, { y1: enumY, y2: [1, 2, 3, 4, 5, 6] });

  it.each(['shared', 'overlay', 'split'] as const)(
    'are left out of the scatter (%s) and counted',
    (axes) => {
      const i = input(frame, { axes, yScale: LOG });
      const scatter = seriesOf(plotOption(i)).filter((s) => s.type === 'scatter');
      for (const s of scatter) {
        for (const [, y] of s.data as [number, number][]) expect(y).toBeGreaterThan(0);
      }
      expect(scatter.find((s) => s.name === 'DEMO:Y1')?.data).toEqual([
        [1, 1],
        [3, 1],
        [4, 1],
      ]);
      expect(logAxisOmitted(i)).toBe(3);
    }
  );

  it('count the X axis too, once per Y it is drawn against', () => {
    expect(logAxisOmitted(input(frame, { xScale: LOG }))).toBe(2);
    expect(logAxisOmitted(input(frame, { xScale: LOG, yScale: LOG }))).toBe(4);
  });

  it('are left out of the faded scatter', () => {
    const i = input(frame, { yScale: LOG, fade: true });
    const points = seriesOf(plotOption(i))
      .filter((s) => s.type === 'scatter' && s.name === 'DEMO:Y1')
      .flatMap((s) => s.data as [number, number][]);
    expect(points).toHaveLength(3);
  });

  it('hidden Ys and Ys the density does not draw are not counted', () => {
    expect(logAxisOmitted(input(frame, { yScale: LOG, hidden: new Set(['DEMO:Y1']) }))).toBe(0);
    expect(
      logAxisOmitted(input(frame, { view: 'density', densityPv: 'DEMO:Y2', xScale: LOG }))
    ).toBe(1);
  });

  it('none on linear axes', () => {
    expect(logAxisOmitted(input(frame))).toBe(0);
  });

  it('split on a log X pins the linked range to the positive X', () => {
    const o = plotOption(input(frame, { axes: 'split', xScale: LOG }));
    for (const a of o.xAxis as { min?: number; max?: number }[]) {
      expect(a.min).toBe(1);
      expect(a.max).toBe(5);
    }
  });
});

describe('the density on log axes', () => {
  // Five decades of X, evenly spread in log space.
  const xs = range(101).map((i) => 10 ** (i / 20));
  const ys = range(101).map((i) => (i % 10) + 1);

  it('bins in log space: every hex has the same width ratio on a log X', () => {
    const bins = hexBin(xs, ys, undefined, { x: true });
    expect(bins.cells.length).toBeGreaterThan(20);
    const ratios = bins.cells.map((cell) => {
      const vx = hexVertices(cell, bins).map(([x]) => x);
      for (const x of vx) expect(x).toBeGreaterThan(0);
      return Math.max(...vx) / Math.min(...vx);
    });
    for (const r of ratios) expect(r).toBeCloseTo(ratios[0], 9);
  });

  it('leaves out the points a log axis cannot show', () => {
    const bins = hexBin([-1, 0, 1, 10, 100], [1, 1, 1, 1, 1], undefined, { x: true });
    expect(bins.cells.reduce((n, c) => n + c.count, 0)).toBe(3);
    for (const c of bins.cells) expect(c.x).toBeGreaterThan(0);
  });

  it('the density view bins in the axes’ scales', () => {
    const frame = frameOf([-1, ...xs], { y: [1, ...ys] });
    const o = plotOption(input(frame, { view: 'density', densityPv: 'DEMO:Y', xScale: LOG }));
    const density = seriesOf(o).find((s) => s.type === 'custom')!;
    const data = density.data as [number, number, number][];
    expect(data.reduce((n, [, , count]) => n + count, 0)).toBe(xs.length);
    expect(data.length).toBe(hexBin(xs, ys, undefined, { x: true }).cells.length);
  });
});

describe('the health suffix', () => {
  it('names the points not shown, before the row rate', () => {
    const line = healthLine(
      { ...initialHealth(), sub: 'live', id: 1, status: 'connected', everOpened: true },
      {
        paused: false,
        trigger: null,
        bindingPvs: {},
        pvs: { status: 'connected', getSnapshot: () => undefined },
        rowsPerS: 4,
      },
      0
    );
    const rate = line.suffixes.at(-1)!;
    expect(rate).toMatch(/^4\S* rows\/s$/);
    const noted = withHealthSuffix(line, logAxisNote(3));
    expect(noted.suffixes).toEqual(['3 points ≤ 0 not shown on a log axis', rate]);
    expect(noted.line).toBe(`${line.text} · 3 points ≤ 0 not shown on a log axis · ${rate}`);
    expect(logAxisNote(1)).toBe('1 point ≤ 0 not shown on a log axis');
    expect(logAxisNote(0)).toBeNull();
    expect(withHealthSuffix(line, null)).toBe(line);
  });

  it('has no place on a line with no subscription', () => {
    const none = healthLine(
      initialHealth(),
      {
        paused: false,
        trigger: null,
        bindingPvs: {},
        pvs: { status: 'connected', getSnapshot: () => undefined },
        rowsPerS: null,
      },
      0
    );
    expect(withHealthSuffix(none, logAxisNote(2))).toBe(none);
  });
});
