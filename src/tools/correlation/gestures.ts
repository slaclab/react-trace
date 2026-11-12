// Correlation's surface for the shared plot gestures (annotations/gestures.ts):
// every drawn grid with its X axis and its distinct Y axes, laid out as the
// option draws them (correlationAxisPlacement), and the X and Y scales of the
// state as the writers. One `yScale` serves every Y axis, so a zoom of any Y
// sets the scale they all draw with. The grids come from the drawing
// projection, rebuilt on each laid-out frame.
import { useMemo, useLayoutEffect, useRef, type RefObject } from 'react';
import type ReactECharts from 'echarts-for-react';
import type { Extent, ProjectionStore } from '../../plot/geometry';
import { roundExtent } from '../../plot/geometry';
import {
  bandAt,
  usePlotGestures,
  type GestureAxis,
  type GestureGrid,
  type PlotGestureSurface,
  type SideAxis,
} from '../../plot/gestures';
import type { DragMode } from '../../plot/plotToggles';
import {
  OVERLAY_AXIS_WIDTH,
  correlationAxisPlacement,
  visibleYs,
  type CorrelationAxisInput,
} from './plotOption';
import type { CorrelationAxisScale, CorrelationState } from './query';

/** The width a Y axis band claims in a grid's side margin. */
const Y_BAND_PX = OVERLAY_AXIS_WIDTH;

type ScaleKey = 'xScale' | 'yScale';

/** `scale` zoomed to `extent` (bounds rounded to readable values): manual, its log flag kept. */
export function zoomedScale(
  scale: CorrelationAxisScale | undefined,
  extent: Extent
): CorrelationAxisScale {
  const { min, max } = roundExtent(extent, scale?.log === true);
  return { ...scale, auto: false, min, max };
}

/** `scale` back on auto-scale: only its log flag kept; undefined when nothing is left. */
export function autoScale(
  scale: CorrelationAxisScale | undefined
): CorrelationAxisScale | undefined {
  return scale?.log === true ? { log: true } : undefined;
}

interface EchartsLike {
  isDisposed?(): boolean;
  getWidth(): number;
  getHeight(): number;
  getZr(): { setCursorStyle(cursor: string): void };
  convertFromPixel(finder: { xAxisIndex: number } | { yAxisIndex: number }, px: number): unknown;
  getModel(): {
    getComponent(
      type: string,
      index: number
    ): { axis?: { scale?: { getExtent?(): [number, number] } } } | undefined;
  };
}

export interface CorrelationGestureInputs {
  /** The chart box: the gestures' wrapper. */
  boxRef: RefObject<HTMLDivElement | null>;
  chart: RefObject<ReactECharts | null>;
  projection: ProjectionStore;
  state: CorrelationState;
  layout: CorrelationAxisInput;
  update?: (fn: (state: CorrelationState) => CorrelationState) => void;
  claimsPointer(e: MouseEvent): boolean;
}

interface Axes {
  /** Each grid's axes by grid index. */
  grids: Map<number, { x: GestureAxis; sides: SideAxis[] }>;
  /** ECharts axis index of each axis. */
  index: Map<GestureAxis, number>;
}

/** Mounts the shared plot gestures on Correlation's chart box. */
export function useCorrelationGestures({
  boxRef,
  chart,
  projection,
  state,
  layout,
  update,
  claimsPointer,
}: CorrelationGestureInputs): void {
  const latest = useRef({ state, update, claimsPointer, layout });
  // The gesture axes, rebuilt from the state after each render; a gesture's
  // freeze marks them manual at once.
  const axes = useRef<Axes>({ grids: new Map(), index: new Map() });
  useLayoutEffect(() => {
    latest.current = { state, update, claimsPointer, layout };
    const xAuto = state.xScale?.auto !== false;
    const yAuto = state.yScale?.auto !== false;
    const fixed = update === undefined;
    const next: Axes = { grids: new Map(), index: new Map() };
    const { pvs, layout: drawn } = visibleYs(layout);
    for (const pv of pvs) {
      const p = correlationAxisPlacement(layout, pv);
      if (!p) continue;
      let g = next.grids.get(p.gridIndex);
      if (!g) {
        const x: GestureAxis = {
          id: `x${p.xAxisIndex}`,
          dim: 'x',
          log: state.xScale?.log === true,
          auto: xAuto,
          fixed,
        };
        next.index.set(x, p.xAxisIndex);
        g = { x, sides: [] };
        next.grids.set(p.gridIndex, g);
      }
      if (g.sides.some((s) => next.index.get(s.axis) === p.yAxisIndex)) continue;
      const y: GestureAxis = {
        id: `y${p.yAxisIndex}`,
        dim: 'y',
        log: state.yScale?.log === true,
        auto: yAuto,
        fixed,
      };
      next.index.set(y, p.yAxisIndex);
      // Overlay: the first Y on the left, each further one on the right, outward.
      const i = g.sides.length;
      const right = drawn === 'overlay' && i > 0;
      g.sides.push({ axis: y, side: right ? 'right' : 'left', slot: right ? i - 1 : 0 });
    }
    axes.current = next;
  });

  const surface = useMemo<PlotGestureSurface>(() => {
    const live = (): EchartsLike | null => {
      const inst = chart.current?.getEchartsInstance() as unknown as EchartsLike | undefined;
      return inst && !inst.isDisposed?.() ? inst : null;
    };
    const grids = (): GestureGrid[] => {
      const proj = projection.get();
      if (!proj) return [];
      const out: GestureGrid[] = [];
      const placed = [...axes.current.grids.entries()].sort(([a], [b]) => a - b);
      // The projection places the same Ys, so its grids come in the same order.
      const rects = proj.grids;
      placed.forEach(([, g], i) => {
        const rect = rects[i]?.gridRect;
        if (rect) out.push({ rect, x: g.x, ys: g.sides.map((s) => s.axis) });
      });
      return out;
    };
    const sidesOf = (grid: GestureGrid) =>
      [...axes.current.grids.values()].find((g) => g.x === grid.x)?.sides ?? [];
    const indexOf = (axis: GestureAxis) => axes.current.index.get(axis) ?? 0;
    const finder = (axis: GestureAxis) =>
      axis.dim === 'x' ? { xAxisIndex: indexOf(axis) } : { yAxisIndex: indexOf(axis) };
    const key = (axis: GestureAxis): ScaleKey => (axis.dim === 'x' ? 'xScale' : 'yScale');
    return {
      chart() {
        const ec = live();
        if (!ec) return null;
        return {
          getWidth: () => ec.getWidth(),
          getHeight: () => ec.getHeight(),
          setCursor: (cursor) => ec.getZr?.()?.setCursorStyle(cursor),
        };
      },
      grids,
      axisAt(x, y) {
        for (const grid of grids()) {
          const hit = bandAt(x, y, grid, sidesOf(grid), Y_BAND_PX);
          if (hit) return hit;
        }
        return null;
      },
      extent(axis) {
        const ec = live();
        const type = axis.dim === 'x' ? 'xAxis' : 'yAxis';
        const ext = ec?.getModel().getComponent(type, indexOf(axis))?.axis?.scale?.getExtent?.();
        return ext ? { min: ext[0], max: ext[1] } : null;
      },
      valueAt(axis, _grid, px) {
        const v = live()?.convertFromPixel(finder(axis), px);
        return typeof v === 'number' ? v : NaN;
      },
      write(axis, extent) {
        const write = latest.current.update;
        if (!write) return false;
        const k = key(axis);
        write((s) => ({ ...s, [k]: zoomedScale(s[k], extent) }));
        return true;
      },
      reset(axis) {
        const k = key(axis);
        latest.current.update?.((s) => ({ ...s, [k]: autoScale(s[k]) }));
      },
      dragMode: (): DragMode => latest.current.state.drag,
      claimsPointer: (e) => latest.current.claimsPointer(e),
    };
  }, [chart, projection]);
  usePlotGestures(boxRef, surface);
}
