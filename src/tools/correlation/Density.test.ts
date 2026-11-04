import { describe, expect, it } from 'vitest';
import { densitySeries, hexBin, hexVertices } from './Density';
import { Y_COLORS } from '../shared/colors';

describe('hexBin', () => {
  it('counts every pairwise non-null finite point once', () => {
    const xs = [0, 1, 2, 3, null, 5, Number.NaN, 7];
    const ys = [0, 1e-6, 2e-6, null, 4e-6, 5e-6, 6e-6, 7e-6];
    const bins = hexBin(xs, ys);
    expect(bins.cells.reduce((n, c) => n + c.count, 0)).toBe(5);
    expect(bins.maxCount).toBeGreaterThanOrEqual(1);
  });

  it('puts identical points in one hex', () => {
    const bins = hexBin([1, 1, 1], [2, 2, 2]);
    expect(bins.cells).toHaveLength(1);
    expect(bins.cells[0]).toMatchObject({ count: 3 });
    expect(bins.cells[0].x).toBeCloseTo(1, 12);
    expect(bins.cells[0].y).toBeCloseTo(2, 12);
  });

  it('scales hexes per axis, so amperes against metres still bins finely', () => {
    const xs = Array.from({ length: 100 }, (_, i) => i / 10);
    const ys = xs.map((x) => x * 1e-6);
    const bins = hexBin(xs, ys);
    expect(bins.cells.length).toBeGreaterThan(10);
    const [v0, v3] = [hexVertices(bins.cells[0], bins)[0], hexVertices(bins.cells[0], bins)[3]];
    expect(Math.abs(v0[1] - v3[1])).toBeLessThan(1e-6);
  });

  it('no points: no cells', () => {
    expect(hexBin([], []).cells).toEqual([]);
    expect(hexBin([null], [1]).cells).toEqual([]);
  });

  it('builds a custom series with one datum per cell', () => {
    const bins = hexBin([0, 1, 2], [0, 1, 2]);
    const series = densitySeries(bins, 'Y', Y_COLORS[0]);
    expect(series.type).toBe('custom');
    expect(series.data).toHaveLength(bins.cells.length);
  });
});
