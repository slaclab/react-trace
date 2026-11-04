// Waveform's drawing glue: the projection of its one grid,
// bumped through the projection gate, and the render-time hide reason that
// binds a drawing to the x the chart plots and to Δ.
//
// Waveform has one grid, one value x axis (element index or an X-source PV's
// values) and one y axis, whose drawing axis id is WAVEFORM_AXIS_ID. Pure
// apart from the store; reaches ECharts only through duck-typed instances.
import { xSourceChangedIn, type Annotation } from '../../annotations/model';
import type { Catalog } from '../../annotations/catalog/types';
import { WAVEFORM_CATALOG } from '../../annotations/catalog';
import {
  buildProjection,
  createProjectionStore,
  type Projection,
  type ProjectionInstance,
  type ProjectionLayout,
  type ProjectionStore,
} from '../../plot/geometry';
import {
  createProjectionGate,
  readProjectionFrame,
  type GateInstance,
} from '../../plot/projectionGate';

/** The axis id every Waveform drawing names: the one y axis. */
export const WAVEFORM_AXIS_ID = 'y';

/** The insets of `waveformPlotOption`'s grid, the fallback when the model has no rect. */
export const WAVEFORM_GRID_INSETS = { left: 64, right: 24, top: 36, bottom: 48 } as const;

const LAYOUT: ProjectionLayout = {
  axisIndexMap: new Map([[WAVEFORM_AXIS_ID, 0]]),
  gridTop: WAVEFORM_GRID_INSETS.top,
  gridBottom: WAVEFORM_GRID_INSETS.bottom,
  gridLeft: WAVEFORM_GRID_INSETS.left,
  gridRight: WAVEFORM_GRID_INSETS.right,
};

const AXES = [{ id: WAVEFORM_AXIS_ID }] as const;

/** What the projection reads from the chart: the projection and the gate slices. */
export type WaveformChartInstance = ProjectionInstance & GateInstance;

/**
 * The single-grid projection source: x axis 0 (value x — index or the X source),
 * y axis 0 as WAVEFORM_AXIS_ID, the grid's laid-out rect from the instance
 * model, else the option's insets. Null while no live chart exists. Resolves
 * the instance on every call; never caches one.
 */
export function waveformProjectionSource(
  getInstance: () => WaveformChartInstance | null | undefined
): () => Projection | null {
  return () => {
    const instance = getInstance();
    if (!instance || instance.isDisposed?.()) return null;
    return buildProjection(instance, LAYOUT, AXES, () => ({
      gridIndex: 0,
      xAxisIndex: 0,
      yAxisIndex: 0,
    }));
  };
}

/** Waveform's projection store with its bump gate. */
export interface WaveformProjection {
  /** The store the overlay subscribes to. */
  store: ProjectionStore;
  /**
   * Call on ECharts `finished` (and resize): bumps only when the size, the
   * grid rect or an axis extent changed since the last bump. Returns whether
   * it bumped.
   */
  finished(): boolean;
  /** Forget the last frame (e.g. a new instance), so the next `finished` bumps. */
  reset(): void;
}

/** A projection store over the chart `getInstance` returns, bumped through the gate. */
export function createWaveformProjection(
  getInstance: () => WaveformChartInstance | null | undefined
): WaveformProjection {
  const store = createProjectionStore(waveformProjectionSource(getInstance));
  const gate = createProjectionGate(() => store.bump());
  return {
    store,
    finished() {
      const instance = getInstance();
      if (!instance || instance.isDisposed?.()) return false;
      return gate.offer(readProjectionFrame(instance, { grids: 1, xAxes: 1, yAxes: 1 }));
    },
    reset() {
      gate.reset();
    },
  };
}

/** The hide reasons this plot gives. */
export const X_SOURCE_CHANGED = 'x source changed';
export const DELTA_CHANGED = 'Δ changed';

/**
 * Why `drawing` is hidden at render time, else null. `rendered` is
 * `renderedXSource(model, frames)`; `deltaOn` is whether the chart draws Δ.
 *   - "x source changed": the drawing's `xRef` differs from `rendered`. A tool
 *     with `axes === 'y'` (H-line) ignores x, as does a drawing with no `xRef`.
 *   - "Δ changed": Δ on/off differs from the drawing's `delta`.
 * Never mutates; the drawing returns once the context matches again.
 */
export function waveformHiddenReason(
  drawing: Annotation,
  rendered: string,
  deltaOn: boolean,
  catalog: Catalog = WAVEFORM_CATALOG
): string | null {
  if (xSourceChangedIn(catalog, drawing, rendered)) return X_SOURCE_CHANGED;
  if ((drawing.delta === true) !== deltaOn) return DELTA_CHANGED;
  return null;
}
