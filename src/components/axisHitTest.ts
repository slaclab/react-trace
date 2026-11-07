// Per-Y-axis pointer hit-testing for SinglePlot (issue 45). Kept in its own
// module (not PlotArea.tsx) so it can be unit-tested and so PlotArea stays a
// component-only file for React Fast Refresh.

// Pixels each stacked axis is pushed outward past the previous one on the same
// side. Must match the `offset` step used when laying axes out in PlotArea.
export const AXIS_OFFSET = 80;

// Screen geometry + metadata for one Y axis, consumed by the per-axis pointer
// listeners in SinglePlot.
export interface AxisHitZone {
  axisId: string;
  yAxisIndex: number;
  logScale: boolean;
  autoScale: boolean;
  side: 'left' | 'right';
  /** Position within its side, 0 = innermost (nearest the plot grid). */
  sideIndex: number;
}

// Grid insets (px) of the plot area within the chart canvas.
export interface GridBand {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

// Resolve which Y axis a pointer at (x, y) in canvas pixels is interacting with,
// or null if it's inside the plot grid (where the plot's own X pan/zoom wins) or
// outside the vertical band. We claim the whole margin OUTSIDE the grid on each
// side and split it into AXIS_OFFSET-wide slots by stack position, so this does
// not depend on pixel-exact axis-line placement.
export function hitTestAxis(
  x: number,
  y: number,
  width: number,
  height: number,
  grid: GridBand,
  zones: AxisHitZone[]
): AxisHitZone | null {
  if (y < grid.top || y > height - grid.bottom) return null;
  if (x < grid.left) {
    const slot = Math.floor((grid.left - x) / AXIS_OFFSET);
    return zones.find((a) => a.side === 'left' && a.sideIndex === slot) ?? null;
  }
  if (x > width - grid.right) {
    const slot = Math.floor((x - (width - grid.right)) / AXIS_OFFSET);
    return zones.find((a) => a.side === 'right' && a.sideIndex === slot) ?? null;
  }
  return null;
}

// Extent + pixel mapping of one Y axis frozen at mousedown. pxMin/pxMax are the
// pixel rows of min/max: pxMin > pxMax because screen y grows downward.
export interface FrozenExtent {
  min: number;
  max: number;
  pxMin: number;
  pxMax: number;
  logScale: boolean;
}

// Pan the frozen extent by a pixel delta (dy > 0 = pointer moved down) so the
// value grabbed at mousedown stays glued to the cursor; the ticks and curves
// follow the drag. The value that must now sit at pixel p is the one the frozen
// mapping had at (p - dy); dragging down therefore RAISES min/max. Log axes pan
// in log space so the shift preserves ratios. Returns null on a degenerate
// zero-height mapping.
export function panExtent(ext: FrozenExtent, dy: number): [number, number] | null {
  const pxSpan = ext.pxMin - ext.pxMax;
  if (pxSpan === 0) return null;
  if (ext.logScale) {
    const lMin = Math.log(ext.min);
    const lMax = Math.log(ext.max);
    const at = (p: number) => lMin + (lMax - lMin) * ((ext.pxMin - p) / pxSpan);
    return [Math.exp(at(ext.pxMin - dy)), Math.exp(at(ext.pxMax - dy))];
  }
  const at = (p: number) => ext.min + (ext.max - ext.min) * ((ext.pxMin - p) / pxSpan);
  return [at(ext.pxMin - dy), at(ext.pxMax - dy)];
}

// Scale [min, max] about `anchor` (the value under the cursor, which stays
// fixed) by `factor`: > 1 spreads the bounds away from the anchor (zoom out),
// < 1 pulls them in (zoom in). Log axes scale in log space so one wheel step
// zooms by a constant ratio anywhere on the axis.
export function zoomExtent(
  min: number,
  max: number,
  anchor: number,
  factor: number,
  logScale: boolean
): [number, number] {
  if (logScale) {
    const la = Math.log(anchor);
    const lMin = Math.log(min);
    const lMax = Math.log(max);
    return [Math.exp(la + (lMin - la) * factor), Math.exp(la + (lMax - la) * factor)];
  }
  return [anchor + (min - anchor) * factor, anchor + (max - anchor) * factor];
}
