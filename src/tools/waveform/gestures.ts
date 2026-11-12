// Waveform's surface for the shared plot gestures (annotations/gestures.ts):
// one grid, the X axis (element index or the X source) and the Live Y axis,
// written to the state's `xScale` and `yScale`. The grid comes from the
// drawing projection, rebuilt on each laid-out frame.
import { useLayoutEffect, useMemo, useRef, type RefObject } from 'react';
import type { EChartsType } from 'echarts';
import { roundExtent, type Extent, type ProjectionStore } from '../../plot/geometry';
import {
  bandAt,
  usePlotGestures,
  type GestureAxis,
  type PlotGestureSurface,
} from '../../plot/gestures';
import type { DragMode } from '../../plot/plotToggles';
import type { WaveformAxisScale, WaveformState } from './query';

/** The width the Y axis band claims left of the grid (the option's grid inset). */
const Y_BAND_PX = 64;

/** `scale` zoomed to `extent` (bounds rounded to readable values): manual, its log flag kept. */
export function zoomedScale(
  scale: WaveformAxisScale | undefined,
  extent: Extent
): WaveformAxisScale {
  const { min, max } = roundExtent(extent, scale?.log === true);
  return { ...scale, auto: false, min, max };
}

/** `scale` back on auto-scale: only its log flag kept; undefined when nothing is left. */
export function autoScale(scale: WaveformAxisScale | undefined): WaveformAxisScale | undefined {
  return scale?.log === true ? { log: true } : undefined;
}

export interface WaveformGestureInputs {
  /** The stage: the gestures' wrapper. */
  stageRef: RefObject<HTMLDivElement | null>;
  chart: RefObject<EChartsType | null>;
  projection: ProjectionStore;
  state: WaveformState;
  update?: (fn: (state: WaveformState) => WaveformState) => void;
  claimsPointer(e: MouseEvent): boolean;
}

/** Mounts the shared plot gestures on Waveform's stage. */
export function useWaveformGestures({
  stageRef,
  chart,
  projection,
  state,
  update,
  claimsPointer,
}: WaveformGestureInputs): void {
  const latest = useRef({ state, update, claimsPointer });
  const axes = useRef<{ x: GestureAxis; y: GestureAxis }>({
    x: { id: 'x', dim: 'x', log: false, auto: true },
    y: { id: 'y', dim: 'y', log: false, auto: true },
  });
  // Rebuilt from the state after each render; a gesture's freeze marks them manual at once.
  useLayoutEffect(() => {
    latest.current = { state, update, claimsPointer };
    const fixed = update === undefined;
    axes.current = {
      x: { id: 'x', dim: 'x', log: false, auto: state.xScale?.auto !== false, fixed },
      y: {
        id: 'y',
        dim: 'y',
        log: state.yScale?.log === true,
        auto: state.yScale?.auto !== false,
        fixed,
      },
    };
  });

  const surface = useMemo<PlotGestureSurface>(() => {
    const live = () => {
      const inst = chart.current;
      return inst && !inst.isDisposed() ? inst : null;
    };
    const grid = () => {
      const proj = projection.get();
      const rect = proj?.grids[0]?.gridRect;
      return rect ? { rect, x: axes.current.x, ys: [axes.current.y] } : null;
    };
    const key = (axis: GestureAxis) => (axis.dim === 'x' ? 'xScale' : 'yScale');
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
      grids() {
        const g = grid();
        return g ? [g] : [];
      },
      axisAt(x, y) {
        const g = grid();
        if (!g) return null;
        return bandAt(x, y, g, [{ axis: g.ys[0], side: 'left', slot: 0 }], Y_BAND_PX);
      },
      extent(axis) {
        const model = (live() as unknown as { getModel?(): unknown } | null)?.getModel?.() as
          | {
              getComponent(
                type: string,
                index: number
              ): { axis?: { scale?: { getExtent?(): [number, number] } } } | undefined;
            }
          | undefined;
        const ext = model
          ?.getComponent(axis.dim === 'x' ? 'xAxis' : 'yAxis', 0)
          ?.axis?.scale?.getExtent?.();
        return ext ? { min: ext[0], max: ext[1] } : null;
      },
      valueAt(axis, _grid, px) {
        const finder = axis.dim === 'x' ? { xAxisIndex: 0 } : { yAxisIndex: 0 };
        const v = live()?.convertFromPixel(finder, px);
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
  usePlotGestures(stageRef, surface);
}
