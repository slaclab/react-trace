// The strip history (history.ts): every metric of every row per clock tick,
// forgotten per metric when its expression changes, capped at 3600.
import { describe, expect, it } from 'vitest';
import type { MetricTable } from './evaluate';
import { appendStrips, EMPTY_STRIPS, forgetMetrics, STRIP_CAP } from './history';

describe('strips', () => {
  const table = (pv: string, r: number, mean = 1): MetricTable => ({
    rows: [
      {
        id: 'y1',
        label: pv,
        cells: { r: { value: r }, mean: { value: mean }, c1: { value: null } },
      },
    ],
    errors: {},
  });

  it('forgets the values of metrics whose expression changed, and only those', () => {
    const h = appendStrips(
      appendStrips(EMPTY_STRIPS, 100, table('A', 0.5, 7)),
      200,
      table('A', 0.6, 8)
    );
    const pruned = forgetMetrics(h, ['mean', 'c9']);
    expect(pruned.points).toEqual([
      { timeMs: 100, values: { y1: { r: 0.5, c1: null } } },
      { timeMs: 200, values: { y1: { r: 0.6, c1: null } } },
    ]);
    // Nothing to drop: the same history object.
    expect(forgetMetrics(h, ['c9'])).toBe(h);
    expect(forgetMetrics(h, [])).toBe(h);
    expect(forgetMetrics(EMPTY_STRIPS, ['r'])).toBe(EMPTY_STRIPS);
  });

  it('records every metric of every row', () => {
    const h = appendStrips(EMPTY_STRIPS, 100, table('A', 0.5, 7));
    expect(h.points).toEqual([{ timeMs: 100, values: { y1: { r: 0.5, mean: 7, c1: null } } }]);
  });

  it('a repeated or older clock does not append', () => {
    let h = appendStrips(EMPTY_STRIPS, 100, table('A', 0.5));
    expect(h.points).toHaveLength(1);
    const same = appendStrips(h, 100, table('A', 0.9));
    expect(same).toBe(h);
    expect(appendStrips(h, 99, table('A', 0.9))).toBe(h);
    expect(appendStrips(h, null, table('A', 0.9))).toBe(h);
    h = appendStrips(h, 101, table('A', 0.9));
    expect(h.points.map((p) => p.values.y1.r)).toEqual([0.5, 0.9]);
  });

  it('the cap holds at 3600', () => {
    let h = EMPTY_STRIPS;
    for (let i = 1; i <= STRIP_CAP + 50; i++) h = appendStrips(h, i, table('A', 0));
    expect(STRIP_CAP).toBe(3600);
    expect(h.points).toHaveLength(3600);
    expect(h.points[0].timeMs).toBe(51);
    expect(h.points[h.points.length - 1].timeMs).toBe(STRIP_CAP + 50);
  });
});
