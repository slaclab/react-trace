// Trace's sample snap: the magnet over the plot's time-sorted line data.
import type { LinePoint } from '../../../components/traceGaps';
import type { SnapHit, SnapProjection } from '../../../plot/geometry';

/** A curve the snap may land on: its data key, its y axis and whether it is shown. */
export interface SnapTrace {
  id: string;
  axisId: string;
  visible?: boolean;
}

/** Default snap radius in CSS pixels. */
export const SNAP_RADIUS_PX = 24;

/** First index whose time is `>= tMs` (or `> tMs` when `strict`). Data is sorted by time. */
export function lowerBound(data: readonly LinePoint[], tMs: number, strict: boolean): number {
  let lo = 0;
  let hi = data.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (strict ? data[mid][0] <= tMs : data[mid][0] < tMs) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The sample nearest to the pixel `(x, y)` across every visible curve, within
 * `radiusPx` (Euclidean, in pixels), or null when none is that close.
 *
 * Each curve is binary-searched (the search of `nearestSample` in
 * `components/traceGaps.ts`) for the time slice under `x ± radius` and only that slice is
 * projected, so a pointer move costs O(log n + slice) per curve, not O(n) —
 * this runs on every mousemove over a plot holding archive-sized data. Gap
 * markers (`[t, null]`) and samples whose projected y is not finite (e.g. a
 * non-positive value on a log axis) never win. Ties keep the earlier curve.
 */
export function snapToSample(
  traceData: ReadonlyMap<string, readonly LinePoint[]>,
  visibleTraces: readonly SnapTrace[],
  projection: SnapProjection,
  x: number,
  y: number,
  radiusPx: number = SNAP_RADIUS_PX
): SnapHit | null {
  const ta = projection.xToT(x - radiusPx);
  const tb = projection.xToT(x + radiusPx);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null;
  const tLo = Math.min(ta, tb);
  const tHi = Math.max(ta, tb);
  const r2 = radiusPx * radiusPx;
  let best: SnapHit | null = null;
  let bestD2 = Infinity;
  for (const trace of visibleTraces) {
    if (trace.visible === false) continue;
    const data = traceData.get(trace.id);
    if (!data || data.length === 0) continue;
    const end = lowerBound(data, tHi, true);
    for (let i = lowerBound(data, tLo, false); i < end; i++) {
      const [t, v] = data[i];
      if (v === null) continue;
      const py = projection.vToY(v, trace.axisId);
      if (!Number.isFinite(py)) continue;
      const dx = projection.tToX(t) - x;
      const dy = py - y;
      const d2 = dx * dx + dy * dy;
      if (d2 <= r2 && d2 < bestD2) {
        bestD2 = d2;
        best = { t, v, axisId: trace.axisId, traceId: trace.id };
      }
    }
  }
  return best;
}
