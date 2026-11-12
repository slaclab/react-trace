// The 24 px pixel-space nearest-point search. Correlation and Waveform
// snap through it, and Correlation's owner-axis rule uses it to find the
// series nearest the pointer. Unlike Trace's `snapToSample` it does not assume
// x-sorted data: a correlation series is a scatter, so every sample is
// projected. Pure.
import type { GridProjection, SamplePoint, SnapHit } from './geometry';

/** Default search radius in CSS pixels; the same as Trace's `SNAP_RADIUS_PX`. */
export const NEAREST_RADIUS_PX = 24;

/** A series the search may land on: its id, its y axis and its samples. */
export interface NearestSeries {
  id: string;
  axisId: string;
  points: readonly SamplePoint[];
  /** `false` skips the series. */
  visible?: boolean;
}

/** The slice of a grid projection the search needs. */
export type NearestProjection = Pick<GridProjection, 'tToX' | 'vToY'>;

/**
 * The sample nearest the wrapper-local pixel `(x, y)` across `series`, within
 * `radiusPx` (Euclidean, inclusive), mapped through `grid`, or null when none is
 * that close. Gap markers (`null` y) and samples whose projected pixel is not
 * finite (an axis outside the grid, a non-positive value on a log axis) never
 * win. Ties keep the earlier series (and, within one, the earlier sample).
 */
export function nearestPoint(
  series: readonly NearestSeries[],
  grid: NearestProjection,
  x: number,
  y: number,
  radiusPx: number = NEAREST_RADIUS_PX
): SnapHit | null {
  const r2 = radiusPx * radiusPx;
  let best: SnapHit | null = null;
  let bestD2 = Infinity;
  for (const s of series) {
    if (s.visible === false) continue;
    for (const [t, v] of s.points) {
      if (v === null) continue;
      const px = grid.tToX(t);
      const py = grid.vToY(v, s.axisId);
      if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
      const dx = px - x;
      const dy = py - y;
      const d2 = dx * dx + dy * dy;
      if (d2 <= r2 && d2 < bestD2) {
        bestD2 = d2;
        best = { t, v, axisId: s.axisId, traceId: s.id };
      }
    }
  }
  return best;
}
