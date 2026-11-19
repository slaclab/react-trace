// Correlation's drawing host rules: which Y a new drawing
// belongs to, and why a stored drawing is not drawn right now. Both read the
// same visible-Y list and density fallback `plotOption` draws from, so the
// canvas, the owner rule and the Layers reasons cannot disagree. Pure; tool
// behaviour keys on `DrawingTool.axes`, never on a kind string.

import { xSourceChangedIn, type Annotation } from '../../annotations/model';
import type { Catalog, SamplePoint, SnapHit } from '../../annotations/catalog/types';
import { CORRELATION_CATALOG } from '../../annotations/catalog';
import type { Projection } from '../../plot/geometry';
import { nearestPoint, type NearestSeries } from '../../plot/nearestPoint';
import { densityYOf, visibleYs, type CorrelationAxisInput } from './plotOption';
import { densityY, type CorrelationState } from './query';

/** What `correlationOwnerAxisAt` reads besides the pointer. */
export interface CorrelationOwnerContext {
  /** The chart's axis inputs, as `plotOption` receives them. */
  layout: CorrelationAxisInput;
  /** The chart's current projection; null before the first layout. */
  projection: Projection | null;
}

/**
 * The visible Ys of `layout` (or the given `columns`) as nearest-point series:
 * (x, y) samples, axis = series = PV. The magnet and the owner rule both read it.
 */
export function correlationSnapSeries(
  layout: CorrelationAxisInput,
  columns: readonly string[] = visibleYs(layout).columns
): NearestSeries[] {
  const frame = layout.frame;
  if (frame === null) return [];
  const xCells = frame.table.columns.x ?? [];
  return columns.map((column) => {
    const pv = frame.columnPvs[column];
    const yCells = frame.table.columns[column] ?? [];
    const points: SamplePoint[] = [];
    const len = Math.min(xCells.length, yCells.length);
    for (let i = 0; i < len; i++) {
      const x = xCells[i];
      if (x !== null) points.push([x, yCells[i]]);
    }
    return { id: pv, axisId: pv, points };
  });
}

/**
 * The Y PV a new drawing placed at wrapper-local (`px`, `py`) belongs to,
 * or null to place nothing:
 * - density: the density Y
 * - split: the Y of the grid under the pointer
 * - shared and overlay: the magnet hit's Y; else the Y of the series with the
 *   nearest visible point within 24 px (`nearestPoint`); else the first visible Y
 */
export function correlationOwnerAxisAt(
  px: number,
  py: number,
  snapHit: SnapHit | null,
  { layout, projection }: CorrelationOwnerContext
): string | null {
  const { columns, pvs } = visibleYs(layout);
  if (pvs.length === 0) return null;
  if (layout.view === 'density') return densityYOf(pvs, layout.densityPv) ?? null;
  if (layout.axes === 'split') {
    if (projection === null) return null;
    const grid = projection.gridAt(px, py);
    return grid?.axisIds.find((id) => pvs.includes(id)) ?? null;
  }
  if (snapHit !== null && pvs.includes(snapHit.axisId)) return snapHit.axisId;
  if (projection !== null) {
    const hit = nearestPoint(correlationSnapSeries(layout, columns), projection, px, py);
    if (hit !== null) return hit.axisId;
  }
  return pvs[0];
}

/**
 * Why `drawing` is not drawn over `state`'s chart, or null when it is.
 * Computed at render time, never stored. `drawnX` is the X the canvas
 * plots (the frame's X PV); a tool whose `axes` is `'y'` ignores it.
 */
export function correlationHiddenReason(
  drawing: Annotation,
  state: CorrelationState,
  drawnX: string,
  catalog: Catalog = CORRELATION_CATALOG
): string | null {
  const pv = drawing.axisId;
  if (!state.ys.includes(pv)) return 'series removed';
  if (Object.prototype.hasOwnProperty.call(state.hidden, pv)) return 'series hidden';
  if (state.view === 'density') {
    const visible = state.ys.filter((y) => !Object.prototype.hasOwnProperty.call(state.hidden, y));
    if (densityYOf(visible, densityY(state)) !== pv) return 'not the density Y';
  }
  if (xSourceChangedIn(catalog, drawing, drawnX)) return 'x source changed';
  return null;
}
