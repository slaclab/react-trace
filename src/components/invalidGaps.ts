import type { CustomSeriesRenderItem } from 'echarts';
import type { AlarmSeverity } from '../api/types';

// INVALID samples (#120). Like the legacy ArchiveViewer, the line breaks at an
// INVALID sample and stays broken until the next good one, and the stretch is
// marked in the trace colour under the x-axis. INVALID values aren't plotted;
// the tooltip still shows them.

// One plotted sample. Archive and live points carry severity; formula curves
// and the mock seed don't.
export interface PlotSample {
  time: number;
  value: number;
  severity?: AlarmSeverity;
}

export function isInvalid(p: { severity?: AlarmSeverity }): boolean {
  return p.severity === 'INVALID';
}

// A step line's hold point: not a sample, so it never draws a symbol.
interface HoldPoint {
  value: [number, number];
  symbol: 'none';
}

export type LinePoint = [number, number | null] | HoldPoint;

/**
 * ECharts line data for `points`, with a `[t, null]` break at the first
 * INVALID point of each run (ECharts doesn't connect across nulls). With
 * `hold` (a `step: 'end'` line), the last good value is first held up to the
 * bad point's time. The next good point starts a new segment.
 */
export function gappedLineData<T extends { time: number; severity?: AlarmSeverity }>(
  points: readonly T[],
  y: (p: T) => number,
  hold = false
): LinePoint[] {
  const out: LinePoint[] = [];
  let prev: T | null = null;
  let inGap = false;
  for (const p of points) {
    if (!isInvalid(p)) {
      out.push([p.time, y(p)]);
      prev = p;
      inGap = false;
    } else if (!inGap) {
      if (hold && prev) out.push({ value: [p.time, y(prev)], symbol: 'none' });
      out.push([p.time, null]);
      inGap = true;
    }
  }
  return out;
}

/**
 * `[from, to]` (ms) for each INVALID run: from its first point to the next
 * good one, or to `endMs` when the data ends INVALID.
 */
export function invalidStretches(points: readonly PlotSample[], endMs: number): [number, number][] {
  const out: [number, number][] = [];
  let from: number | null = null;
  for (const p of points) {
    if (isInvalid(p)) from ??= p.time;
    else if (from !== null) {
      out.push([from, p.time]);
      from = null;
    }
  }
  if (from !== null) out.push([from, Math.max(from, endMs)]);
  return out;
}

// Marker geometry, in px below the x-axis line. Each trace with INVALID
// stretches gets its own lane, so overlapping stretches stay distinguishable.
const MARKER_TOP = 2;
const MARKER_HEIGHT = 3;
const MARKER_LANE_PITCH = 4;
// A single bad sample on a long window is still visible.
const MARKER_MIN_WIDTH = 2;
const DEFAULT_LABEL_MARGIN = 8;

// A cartesian2d custom series' `params.coordSys`: the grid's rect in px.
interface GridRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** x-axis label margin that keeps the labels clear of `lanes` marker lanes. */
export function xAxisLabelMargin(lanes: number): number {
  return DEFAULT_LABEL_MARGIN + Math.max(0, lanes - 1) * MARKER_LANE_PITCH;
}

/**
 * Custom series that draws `stretches` as bars under the x-axis. It has no y
 * dimension, so it doesn't affect the y-axis extent. Custom series aren't
 * clipped to the grid, which is what lets it draw below the axis; it clamps
 * itself to the grid's x-range instead.
 */
export function invalidMarkerSeries(opts: {
  id: string;
  name: string;
  color: string;
  yAxisIndex: number;
  lane: number;
  stretches: [number, number][];
  z: number;
}): Record<string, unknown> {
  const top = MARKER_TOP + opts.lane * MARKER_LANE_PITCH;
  const renderItem: CustomSeriesRenderItem = (params, api) => {
    const grid = params.coordSys as typeof params.coordSys & GridRect;
    // Only x is used; 1 is a valid y on any axis type, log included.
    const from = Math.max(api.coord([api.value(0), 1])[0], grid.x);
    const to = Math.min(api.coord([api.value(1), 1])[0], grid.x + grid.width);
    if (to < from) return null;
    const width = Math.max(to - from, MARKER_MIN_WIDTH);
    return {
      type: 'rect',
      shape: {
        x: Math.min(from, grid.x + grid.width - width),
        y: grid.y + grid.height + top,
        width,
        height: MARKER_HEIGHT,
      },
      style: { fill: opts.color },
    };
  };
  return {
    id: opts.id,
    name: opts.name,
    type: 'custom',
    yAxisIndex: opts.yAxisIndex,
    data: opts.stretches,
    encode: { x: [0, 1] },
    renderItem,
    showInLegend: false,
    tooltip: { show: false },
    silent: true,
    animation: false,
    z: opts.z,
  };
}
