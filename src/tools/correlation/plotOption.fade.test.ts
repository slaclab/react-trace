// Fade older points: fade off draws one scatter
// series per Y; fade on draws five age-bucket series per Y, in large mode at
// every n, with opacity rising to opaque for the newest rows, and the buckets
// together hold exactly the unfaded points. Density ignores fade.

import { describe, expect, it } from 'vitest';
import type { TableResultDTO } from '@slaclab/canopy-client';
import { drawingThemeFor } from '../../annotationTheme';
import { FADE_BUCKETS, plotOption, type PlotOptionInput } from './plotOption';
import type { FrameLike } from './stats';

const PVS = { x: 'X:PV', y1: 'Y1:PV', y2: 'Y2:PV', y3: 'Y3:PV' };

function frame(columnPvs: Record<string, string> = PVS, rows = 10): FrameLike {
  const tsNs = Array.from({ length: rows }, (_, i) => i * 1e9);
  const columns: Record<string, (number | null)[]> = { x: tsNs.map((_, i) => i + 1) };
  Object.keys(columnPvs)
    .filter((c) => c !== 'x')
    .forEach((c, k) => {
      columns[c] = tsNs.map((_, i) => (k + 1) * (i + 1) + 1);
    });
  const table: TableResultDTO = { tsNs, columns, inputs: {}, totalRows: rows };
  return { table, columnPvs };
}

function option(extra: Partial<PlotOptionInput> = {}) {
  return plotOption({
    frame: frame(),
    view: 'scatter',
    axes: 'shared',
    densityPv: '',
    unitsOf: () => '',
    theme: drawingThemeFor('dark'),
    hidden: new Set(),
    width: 900,
    ...extra,
  });
}

interface SeriesLike {
  type?: string;
  name?: string;
  color?: string;
  large?: boolean;
  largeThreshold?: number;
  yAxisIndex?: number;
  itemStyle?: { opacity?: number };
  data?: unknown[];
}

const seriesOf = (o: ReturnType<typeof plotOption>) => (o.series ?? []) as SeriesLike[];
const scatter = (o: ReturnType<typeof plotOption>) =>
  seriesOf(o).filter((s) => s.type === 'scatter');
const pointCount = (ss: SeriesLike[]) => ss.reduce((n, s) => n + (s.data?.length ?? 0), 0);

describe('plotOption fade', () => {
  it('is off by default: one scatter series per Y', () => {
    const s = scatter(option());
    expect(s.map((x) => x.name)).toEqual(['Y1:PV', 'Y2:PV', 'Y3:PV']);
    expect(scatter(option({ fade: false }))).toHaveLength(3);
  });

  it('fade on draws five bucket series per Y, opacity rising, large mode at every n', () => {
    const s = scatter(option({ fade: true }));
    expect(FADE_BUCKETS).toBe(5);
    expect(s).toHaveLength(3 * 5);
    for (const pv of ['Y1:PV', 'Y2:PV', 'Y3:PV']) {
      const mine = s.filter((x) => x.name === pv);
      expect(mine).toHaveLength(5);
      const opacities = mine.map((x) => x.itemStyle?.opacity ?? NaN);
      for (let k = 1; k < opacities.length; k++)
        expect(opacities[k]).toBeGreaterThan(opacities[k - 1]);
      expect(opacities[4]).toBe(1);
      for (const b of mine) {
        expect(b.large).toBe(true);
        expect(b.largeThreshold).toBe(1);
      }
      // One colour per Y across its buckets.
      expect(new Set(mine.map((x) => x.color)).size).toBe(1);
    }
  });

  it('the buckets together hold exactly the unfaded points', () => {
    for (const rows of [1, 7, 10, 503]) {
      const f = frame(PVS, rows);
      expect(pointCount(scatter(option({ frame: f, fade: true })))).toBe(
        pointCount(scatter(option({ frame: f })))
      );
    }
  });

  it('drops null cells from the buckets as the unfaded series does', () => {
    const f = frame(PVS, 10);
    f.table.columns.y1[9] = null;
    f.table.columns.x[0] = null;
    const faded = scatter(option({ frame: f, fade: true }));
    const plain = scatter(option({ frame: f }));
    expect(pointCount(faded)).toBe(pointCount(plain));
    const y1 = faded.filter((s) => s.name === 'Y1:PV');
    expect(pointCount(y1)).toBe(8);
  });

  it('buckets follow row age on the data clock: newest rows are in the opaque bucket', () => {
    // 10 rows at 0..9 s: five equal time slices of 2 rows each.
    const y1 = scatter(option({ fade: true })).filter((s) => s.name === 'Y1:PV');
    expect(y1.map((s) => s.data?.length)).toEqual([2, 2, 2, 2, 2]);
    // Newest row (x = 10) sits in the last, opaque bucket; the oldest (x = 1) in the first.
    expect(y1[4].data).toContainEqual([10, 11]);
    expect(y1[0].data).toContainEqual([1, 2]);
  });

  it('buckets by time, not by row count', () => {
    const f = frame({ x: 'X:PV', y1: 'Y1:PV' }, 6);
    // Five old rows at 0..4 s, one fresh row 100 s later.
    f.table.tsNs = [0, 1e9, 2e9, 3e9, 4e9, 100e9];
    const y1 = scatter(option({ frame: f, fade: true }));
    expect(y1.map((s) => s.data?.length)).toEqual([5, 0, 0, 0, 1]);
  });

  it('a single timestamp puts every row in the newest bucket', () => {
    const f = frame({ x: 'X:PV', y1: 'Y1:PV' }, 4);
    f.table.tsNs = [5e9, 5e9, 5e9, 5e9];
    const y1 = scatter(option({ frame: f, fade: true }));
    expect(y1.map((s) => s.data?.length)).toEqual([0, 0, 0, 0, 4]);
  });

  it('keeps the legend at one entry per Y and the fit line per Y', () => {
    const o = option({ fade: true });
    expect((o.legend as { data?: string[] }).data).toEqual(['Y1:PV', 'Y2:PV', 'Y3:PV']);
    expect(seriesOf(o).filter((s) => s.type === 'line')).toHaveLength(3);
  });

  it('bucket series keep their Y axis in the overlay layout', () => {
    const s = scatter(option({ fade: true, axes: 'overlay' }));
    expect(s.filter((x) => x.name === 'Y2:PV').every((x) => x.yAxisIndex === 1)).toBe(true);
  });

  it('hidden Ys draw no buckets; eight Ys stay within 40 series', () => {
    expect(scatter(option({ fade: true, hidden: new Set(['Y2:PV']) }))).toHaveLength(10);
    const eight: Record<string, string> = { x: 'X:PV' };
    for (let i = 1; i <= 8; i++) eight[`y${i}`] = `Y${i}:PV`;
    expect(scatter(option({ frame: frame(eight), fade: true })).length).toBeLessThanOrEqual(40);
  });

  it('density view ignores fade', () => {
    const on = seriesOf(option({ view: 'density', densityPv: 'Y1:PV', fade: true }));
    const off = seriesOf(option({ view: 'density', densityPv: 'Y1:PV' }));
    // Density series carry render closures; compare their serialised shape.
    expect(JSON.stringify(on)).toBe(JSON.stringify(off));
    expect(on.filter((s) => s.type === 'scatter')).toHaveLength(0);
  });
});
