// Pins the shared 24 px nearest-point search Correlation and Waveform
// snap through: Euclidean pixel distance through one grid, unsorted samples,
// gaps and off-grid axes skipped, ties kept by the earlier series.
import { describe, expect, it } from 'vitest';
import { NEAREST_RADIUS_PX, nearestPoint, type NearestProjection } from './nearestPoint';

// x px = t, y px = 200 - v on axis 'y1'; any other axis is off this grid.
const grid: NearestProjection = {
  tToX: (t) => t,
  vToY: (v, axisId) => (axisId === 'y1' ? 200 - v : NaN),
};

describe('nearestPoint', () => {
  it('defaults to a 24 px radius', () => {
    expect(NEAREST_RADIUS_PX).toBe(24);
  });

  it('finds the nearest sample within 24 px, in unsorted data', () => {
    const hit = nearestPoint(
      [
        {
          id: 's',
          axisId: 'y1',
          points: [
            [150, 50],
            [100, 100],
            [110, 100],
          ],
        },
      ],
      grid,
      104,
      100
    );
    expect(hit).toEqual({ t: 100, v: 100, axisId: 'y1', traceId: 's' });
  });

  it('includes a sample exactly 24 px away and misses one beyond', () => {
    const at = [{ id: 's', axisId: 'y1', points: [[124, 100]] as [number, number][] }];
    expect(nearestPoint(at, grid, 100, 100)?.t).toBe(124);
    const beyond = [
      { id: 's', axisId: 'y1', points: [[100 + 17.5, 100 - 17.5]] as [number, number][] },
    ];
    // sqrt(17.5^2 * 2) ~ 24.7 px
    expect(nearestPoint(beyond, grid, 100, 100)).toBeNull();
    expect(nearestPoint(beyond, grid, 100, 100, 30)).not.toBeNull();
  });

  it('skips gaps, hidden series and samples off the grid', () => {
    expect(
      nearestPoint(
        [
          { id: 'gap', axisId: 'y1', points: [[100, null]] },
          { id: 'hid', axisId: 'y1', points: [[100, 100]], visible: false },
          { id: 'off', axisId: 'y2', points: [[100, 100]] },
        ],
        grid,
        100,
        100
      )
    ).toBeNull();
  });

  it('keeps the earlier series on a tie', () => {
    const hit = nearestPoint(
      [
        { id: 'first', axisId: 'y1', points: [[105, 100]] },
        { id: 'second', axisId: 'y1', points: [[95, 100]] },
      ],
      grid,
      100,
      100
    );
    expect(hit?.traceId).toBe('first');
  });
});
