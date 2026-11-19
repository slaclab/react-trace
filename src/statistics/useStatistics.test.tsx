// @vitest-environment jsdom
//
// The statistics hook: the strip history follows the clock, forgets a metric
// whose expression changed or that left the list (so a reused custom id
// starts empty), and empties on clear.
import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { CORRELATION_METRICS } from '../tools/correlation/metrics';
import type { StatFrame } from './evaluate';
import type { Metric } from './model';
import { useStatistics } from './useStatistics';

const custom = (id: string, expr: string): Metric => ({
  id,
  label: id,
  expr,
  unit: '',
  on: true,
  strip: true,
});
const frame = (y: number[]): StatFrame => ({
  rows: [{ id: 'y1', label: 'A', columns: { x: y.map((_, i) => i), y, t: y.map(() => 0) } }],
});

describe('useStatistics', () => {
  it('appends on an advancing clock and forgets a changed or removed metric', () => {
    let metrics = [custom('c1', 'mean(y)'), custom('c2', 'max(y)')];
    let f = frame([1, 2, 3]);
    let clock = 1000;
    const { result, rerender } = renderHook(() =>
      useStatistics(CORRELATION_METRICS, f, metrics, clock)
    );
    expect(result.current.strips.points).toHaveLength(1);
    f = frame([2, 3, 4]);
    clock = 2000;
    rerender();
    expect(result.current.strips.points.map((p) => p.values.y1.c1)).toEqual([2, 3]);
    // Same clock: nothing appended.
    f = frame([5, 5, 5]);
    rerender();
    expect(result.current.strips.points).toHaveLength(2);
    // c2 leaves the list; c1's expression changes: both histories go.
    metrics = [custom('c1', 'min(y)')];
    f = frame([7, 8, 9]);
    clock = 3000;
    rerender();
    expect(result.current.strips.points.map((p) => p.values.y1)).toEqual([{}, {}, { c1: 7 }]);
    // A new custom reusing c2 starts from its own first point.
    metrics = [custom('c1', 'min(y)'), custom('c2', 'sum(y)')];
    f = frame([7, 8, 9]);
    clock = 4000;
    rerender();
    expect(result.current.strips.points.map((p) => p.values.y1.c2)).toEqual([
      undefined,
      undefined,
      undefined,
      24,
    ]);
    act(() => result.current.clear());
    expect(result.current.strips.points).toHaveLength(0);
  });
});
