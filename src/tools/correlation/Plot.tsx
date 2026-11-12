// The correlation display: the scatter or density
// chart with fit lines, the statistics table and the strip charts. The
// statistics are the state's metric list evaluated over the frame on screen
// (the library's `evaluateMetrics`); the table shows the metrics that are `on`, the
// strips the ones with `strip`, and both sit in one "Statistics" section that
// collapses when neither renders.
//
// The canvas is `CorrelationCanvas`: the chart, the readout and the strips,
// drawn from the tool's state alone. Pause, Clear and the exports are actions
// in the workbench's actions bar (tools/correlation/actions.ts) and the view
// controls (Plot as, Density Y, Layout) are fields of the plot's Display and
// Axes sections; the canvas has no toolbar.
//
// Y layout (query key `axes`): `shared` puts every Y on one Y axis;
// `overlay` gives each Y its own colour-coded Y axis (first left, the rest
// right, offset outward) in one plot; `split` draws one panel per Y in one
// ECharts instance — a grid per Y, wrapped to the width, every panel's X axis
// set to the same range. The layout applies to the scatter; the density view
// always uses one axis pair. One instance in every layout keeps the legend and
// the PNG export (what is shown) as they are.
//
// Input is the frame `useTable` hands out — frozen while paused — with its own
// column→PV map, so legend, readout, strips and CSV never relabel a frozen
// frame. Everything below works on the frame on screen: that frame after the
// Clear cut (`useCorrelationFrame`). Pause only flips the caller's `paused`
// flag (client-side; the subscription is untouched), Clear records the newest
// tsNs on screen as the cut and resets the strips, and works while paused.
//
// ECharts: `animation:false`; the scatter is `large:true` statically — at the
// default N = 1000 it stays under ECharts' 2000-point large threshold, so
// per-point hover keeps working. With `bench=1` in the page URL,
// `corr:rendered` is marked on every ECharts `finished` event: the render
// benchmark hook of the e2e specs (../shared/renderMark.ts).
//
// Drawings: on the workbench the canvas
// mounts the drawing host over the document App.tsx builds. The layers sit
// inside `.correlation-plot__box`, so they scroll with a split chart; the rail
// and the status line sit outside the scroller, so the rail stays in view.
// The box carries the host's wrapper listeners. The config is memoized on what
// its rules read (X, the drawn X, Ys, hidden, density Y, view, layout) and
// reads the frame only through getters; a `frames` store is bumped on each new
// frame for the measure card. The projection is rebuilt only through a
// `projectionGate` on ECharts `finished` and on resize, so a new frame with
// unchanged extents commits nothing in the overlay.

import {
  attachReadoutDrag,
  createReadoutDock,
  projectionArea,
  type ReadoutDock,
} from '../../plot/readoutDock';
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
  type RefObject,
} from 'react';
import ReactECharts from 'echarts-for-react';
import { useChartFont } from '@slaclab/canopy-shell';
import { CORRELATION_CATALOG } from '../../annotations/catalog';
import type { HostConfig, ShedStore } from '../../annotations/catalog/types';
import { VALUE_X_AXIS } from '../../annotations/catalog/xAxis';
import {
  buildProjection,
  createProjectionStore,
  type OwnedProjectionStore,
  type ProjectionInstance,
  type ProjectionLayout,
} from '../../plot/geometry';
import { DrawingLayers, DrawingRailFor } from '../../annotations/host/DrawingOverlay';
import type { PlotView } from '../../plot/plotToggles';
import { DrawingStatusLine } from '../../annotations/host/DrawingStatusLine';
import { createFrameStore } from '../../annotations/host/frameStore';
import type { DrawingDocument } from '../../annotations/host/useDrawingDocument';
import {
  useDrawingHost,
  useDrawingPlotMenu,
  useDrawingWrapperListeners,
  type DrawingHost,
  type PlotPoint,
} from '../../annotations/host/useDrawingHost';
import { useLatest } from '../../workbench/useLatest';
import { useContextMenu } from '../../workbench/contextMenu/context';
import { LegendMenu } from '../contextMenu';
import { correlationPointMenu } from './menu';
import { correlationItemId } from './schema';
import { ignoresXIn, type Annotation } from '../../annotations/model';
import { nearestPoint } from '../../plot/nearestPoint';
import {
  createProjectionGate,
  readProjectionFrame,
  type GateInstance,
} from '../../plot/projectionGate';
import { drawingThemeFor, type ChartDrawingTheme } from '../../annotationTheme';
import { correlationHiddenReason, correlationOwnerAxisAt, correlationSnapSeries } from './drawings';
import { createCorrelationMeasure } from './measure';
import { useCorrelationGestures } from './gestures';
import { yColorMap } from './colors';
import {
  DEFAULT_AXES,
  densityY,
  type CorrelationAxes,
  type CorrelationState,
  type CorrelationView,
} from './query';
import {
  correlationAxisPlacement,
  densityYOf,
  PLOT_MIN_HEIGHT,
  plotOption,
  splitGeometry,
  visibleYs,
  type CorrelationAxisInput,
  type PlotOptionInput,
} from './plotOption';
import { StatisticsPanel } from '../../statistics/StatisticsPanel';
import type { StatFrame } from '../../statistics/evaluate';
import type { StripHistory } from '../../statistics/history';
import { useStatistics } from '../../statistics/useStatistics';
import { correlationStatFrame, slopeUnits, yColumns, type FrameLike } from './stats';
import type { MetricTable } from '../../statistics/evaluate';
import { CORRELATION_METRICS } from './metrics';
import { type Metric } from '../../statistics/model';
import { applyCut, exportFileName, newestTsNs } from './export';
import { useElementWidth } from '../../hooks/useElementWidth';
import { chartPngSource, downloadHref } from '../shared/chartImage';
import { markRendered } from '../shared/renderMark';

export const RENDERED_MARK = 'corr:rendered';

/**
 * What the tool's state draws beyond the frame, view and layout: colours,
 * markers, the toggles, the axis scales and the hidden Ys.
 */
export type CorrelationPlotSettings = Pick<
  PlotOptionInput,
  | 'colors'
  | 'markers'
  | 'fit'
  | 'legend'
  | 'grid'
  | 'crosshair'
  | 'tooltip'
  | 'xScale'
  | 'yScale'
  | 'fade'
> & {
  /** Hidden Y PVs (the state's `hidden`); none when absent. */
  hidden?: ReadonlySet<string>;
};

/** The chart settings `state` draws. Pure. */
// eslint-disable-next-line react-refresh/only-export-components -- shared with the Code tabs through App.tsx
export function plotSettingsOf(state: CorrelationState): CorrelationPlotSettings {
  return {
    colors: yColorMap(state),
    markers: state.markers,
    fit: state.fit,
    legend: state.legend,
    grid: state.grid,
    crosshair: state.crosshair,
    tooltip: state.tooltip,
    xScale: state.xScale,
    yScale: state.yScale,
    fade: state.fade,
    hidden: new Set(Object.keys(state.hidden)),
  };
}

/** The width the option is built for: only the split scatter places panels by it. */
function layoutWidthOf(view: CorrelationView, axes: CorrelationAxes, width: number): number {
  return view !== 'density' && axes === 'split' ? width : 0;
}

/**
 * The chart-option input of `state` over the frame on screen — exactly what
 * the canvas's chart receives — for the Code tabs. Pure.
 */
// eslint-disable-next-line react-refresh/only-export-components -- shared with the Code tabs through App.tsx
export function correlationPlotInput(
  state: CorrelationState,
  frame: FrameLike | null,
  {
    unitsOf,
    theme,
    width,
  }: { unitsOf: (pv: string) => string; theme: ChartDrawingTheme; width: number }
): PlotOptionInput {
  const { hidden = new Set<string>(), ...settings } = plotSettingsOf(state);
  return {
    ...settings,
    frame,
    view: state.view,
    axes: state.axes,
    densityPv: densityY(state),
    unitsOf,
    theme,
    hidden,
    width: layoutWidthOf(state.view, state.axes, width),
  };
}

export interface CorrelationPlotProps {
  /** The frame on screen (already cut). */
  frame: FrameLike | null;
  view: CorrelationView;
  /** The scatter's Y layout; `shared` by default. */
  axes?: CorrelationAxes;
  /** The density view's Y PV (`densityY(state)`). */
  densityPv: string;
  unitsOf: (pv: string) => string;
  /** Chart colours; Trace's dark chart theme by default. */
  chartTheme?: ChartDrawingTheme;
  chartRef?: Ref<ReactECharts>;
  /** What the tool's state draws; the option's defaults when absent. */
  settings?: CorrelationPlotSettings;
  /** The drawing host's parts that live in the chart box (the workbench canvas only). */
  drawing?: CorrelationPlotDrawing;
}

/** What `CorrelationPlot` places for the drawing host. */
export interface CorrelationPlotDrawing {
  host: DrawingHost;
  projection: CorrelationProjection;
  /** The chart box: the host's wrapper (listeners, focus). */
  boxRef: RefObject<HTMLDivElement | null>;
  /** Receives the chart box element (`boxRef`'s writer). */
  setBox(el: HTMLDivElement | null): void;
  /** The data read-out's dock. */
  dock: ReadoutDock;
}

// Hidden Ys are the state's (`settings.hidden`): the card eye is visibility's
// one home and the legend is not clickable (plotOption `selectedMode: false`).
// It is visual only — the readout, strips and CSV keep every Y.
export function CorrelationPlot({
  frame,
  view,
  axes = DEFAULT_AXES,
  densityPv,
  unitsOf,
  chartTheme = drawingThemeFor('dark'),
  chartRef,
  settings,
  drawing,
}: CorrelationPlotProps) {
  const hidden = settings?.hidden ?? EMPTY_HIDDEN;
  const [widthRef, width, boxEl] = useElementWidth();
  // The box is also the drawing host's wrapper.
  const setDrawingBox = drawing?.setBox;
  const boxRef = useCallback(
    (el: HTMLDivElement | null) => {
      assignRef(widthRef, el);
      setDrawingBox?.(el);
    },
    [widthRef, setDrawingBox]
  );
  // The latest drawing parts, for the mount-once `finished` handler.
  const drawingRef = useRef(drawing);
  useLayoutEffect(() => {
    drawingRef.current = drawing;
  });
  // The resize path: a new box width may move the grids.
  useEffect(() => {
    drawingRef.current?.projection.offer();
  }, [width]);
  // Canvas text does not inherit CSS: the chart draws in the family the box
  // computes, named only once it has loaded so the option changes then and
  // ECharts redraws with the real face.
  const chartFont = useChartFont(boxEl);
  const fontFamily = chartFont.ready ? chartFont.fontFamily : undefined;

  const layout = view === 'density' ? 'shared' : axes;
  const ys = frame === null ? 0 : yColumns(frame.columnPvs).length;
  // The chart fills its box; only the split layout, whose panels
  // stack, asks for its own height and lets the box scroll.
  const height: number | string =
    layout === 'split' && ys > 0 ? splitGeometry(ys, width).height : '100%';
  // Width only places split panels; other layouts ignore it, so a resize
  // does not rebuild their option.
  const layoutWidth = layoutWidthOf(view, axes, width);
  const option = useMemo(
    () => ({
      ...plotOption({
        ...settings,
        frame,
        view,
        axes,
        densityPv,
        unitsOf,
        theme: chartTheme,
        hidden,
        width: layoutWidth,
        readoutDock: drawing?.dock,
      }),
      textStyle: { fontFamily },
    }),
    [
      settings,
      frame,
      view,
      axes,
      densityPv,
      unitsOf,
      chartTheme,
      hidden,
      layoutWidth,
      fontFamily,
      drawing?.dock,
    ]
  );
  // The read-out's grip, on the chart's own element.
  const dock = drawing?.dock;
  useEffect(() => {
    const dom = drawing?.boxRef.current?.querySelector<HTMLElement>('.correlation-plot__chart');
    return dock && dom ? attachReadoutDrag(dom, dock) : undefined;
  }, [dock, drawing?.boxRef]);
  // A right-click on a legend entry: that Y's menu.
  const menus = useContextMenu();
  const onLegend = useCallback(
    (name: string, e: MouseEvent): boolean => {
      if (menus === null) return false;
      const at = { x: e.clientX, y: e.clientY, target: e.view?.document.body };
      return menus.openSignals([correlationItemId('y', name)], at);
    },
    [menus]
  );
  const legendMenu = useLatest(onLegend);
  // A left-click on a legend entry toggles nothing (`LegendMenu`).
  const [legend] = useState(() => new LegendMenu((name, e) => legendMenu.current(name, e)));
  const onEvents = useMemo(
    () => ({
      ...legend.events,
      finished: () => {
        markRendered(RENDERED_MARK);
        // The projection follows the laid-out frame only when it moved.
        drawingRef.current?.projection.offer();
      },
    }),
    [legend]
  );
  const style = useMemo(() => ({ height, minHeight: PLOT_MIN_HEIGHT }), [height]);
  return (
    <div
      ref={boxRef}
      className="correlation-plot__box stats-canvas__fill"
      onClickCapture={(e) => legend.blockClick(e.nativeEvent)}
    >
      <ReactECharts
        ref={chartRef}
        className="correlation-plot__chart"
        style={style}
        notMerge
        option={option}
        onEvents={onEvents}
      />
      {drawing && <PlotDrawingParts host={drawing.host} boxRef={drawing.boxRef} />}
    </div>
  );
}

/** Sets `ref` to `value`, whether it is a callback or an object ref. */
function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (typeof ref === 'function') ref(value);
  else if (ref) (ref as { current: T | null }).current = value;
}

/**
 * The drawing parts inside the chart box: the per-grid svgs and the note
 * editor's slot, with the host's wrapper listeners on the box. Memoized: its
 * props change only with the host, so a new frame commits nothing here.
 */
const PlotDrawingParts = memo(function PlotDrawingParts({
  host,
  boxRef,
}: {
  host: DrawingHost;
  boxRef: RefObject<HTMLDivElement | null>;
}) {
  useDrawingWrapperListeners(boxRef, host);
  return <DrawingLayers host={host} />;
});

// ───────────────────────────────────────────────────────────── drawings ──

/**
 * The single-grid insets of the scatter (plotOption's shared grid): the
 * projection's last fallback when the chart model gives no grid rect.
 */
const PROJECTION_LAYOUT: ProjectionLayout = {
  axisIndexMap: new Map(),
  gridTop: 36,
  gridBottom: 56,
  gridLeft: 80,
  gridRight: 24,
};

/** The chart's projection: a store rebuilt only through the gate. */
export interface CorrelationProjection {
  store: OwnedProjectionStore;
  /** After a laid-out frame or a resize: rebuild when the layout moved. */
  offer(): void;
  /** Forget the last layout, so the next offer rebuilds (the axis mapping changed). */
  reset(): void;
}

type ChartInstance = ProjectionInstance & GateInstance;

/** The grid and axis counts the option lays out for `layout`. */
function projectionCounts(layout: CorrelationAxisInput) {
  const { pvs, layout: drawn } = visibleYs(layout);
  const n = Math.max(1, pvs.length);
  if (drawn === 'split') return { grids: n, xAxes: n, yAxes: n };
  if (drawn === 'overlay') return { grids: 1, xAxes: 1, yAxes: n };
  return { grids: 1, xAxes: 1, yAxes: 1 };
}

/**
 * The projection of the chart `getInstance` returns, over the axis inputs
 * `getLayout` returns at bump time: each visible Y on the grid and axes
 * `correlationAxisPlacement` names.
 */
// eslint-disable-next-line react-refresh/only-export-components -- the projection is shared with its unit test
export function createCorrelationProjection(
  getInstance: () => ChartInstance | null,
  getLayout: () => CorrelationAxisInput
): CorrelationProjection {
  const live = () => {
    const inst = getInstance();
    if (!inst || inst.isDisposed?.()) return null;
    if (typeof inst.getWidth !== 'function' || typeof inst.getHeight !== 'function') return null;
    return inst;
  };
  const store = createProjectionStore(() => {
    const inst = live();
    if (!inst) return null;
    const layout = getLayout();
    const axes = visibleYs(layout).pvs.map((id) => ({ id }));
    return buildProjection(inst, PROJECTION_LAYOUT, axes, (pv) =>
      correlationAxisPlacement(layout, pv)
    );
  });
  const gate = createProjectionGate(() => store.bump());
  return {
    store,
    offer() {
      const inst = live();
      if (inst) gate.offer(readProjectionFrame(inst, projectionCounts(getLayout())));
    },
    reset: () => gate.reset(),
  };
}

/** A value the getters read at call time, replaced after each commit. */
function createLatest<T>(initial: T): { get(): T; set(next: T): void } {
  let value = initial;
  return {
    get: () => value,
    set(next) {
      value = next;
    },
  };
}

/**
 * `next` with every drawing that is not in `prev` stamped with the drawn X
 * (`xRef`), unless its tool ignores X (`axes: 'y'`) or it already has
 * one. `next` itself when nothing was stamped.
 */
// eslint-disable-next-line react-refresh/only-export-components -- pure; pinned by its unit test
export function stampXRef(
  prev: readonly Annotation[],
  next: Annotation[],
  drawnX: string
): Annotation[] {
  const known = new Set(prev.map((a) => a.id));
  let stamped = false;
  const out = next.map((a) => {
    if (known.has(a.id) || a.xRef !== undefined) return a;
    if (ignoresXIn(CORRELATION_CATALOG, a.kind)) return a;
    stamped = true;
    return { ...a, xRef: drawnX };
  });
  return stamped ? out : next;
}

/** What App.tsx hands the canvas for its drawings. */
export interface CorrelationDrawingInputs {
  /** The drawing document over the state's `drawings`. */
  document: DrawingDocument;
  /** What the last link shed; the status line shows it. */
  shed: ShedStore;
}

interface DrawingHostInputs {
  state: CorrelationState;
  shown: FrameLike | null;
  drawnX: string;
  hidden: ReadonlySet<string>;
  unitsOf: (pv: string) => string;
  chartTheme: ChartDrawingTheme;
  chart: RefObject<ReactECharts | null>;
  inputs: CorrelationDrawingInputs;
}

/** The canvas's drawing host and the parts it places. */
function useCorrelationDrawingHost({
  state,
  shown,
  drawnX,
  hidden,
  unitsOf,
  chartTheme,
  chart,
  inputs,
}: DrawingHostInputs) {
  const densityPv = densityY(state);
  const axisInput = useMemo<CorrelationAxisInput>(
    () => ({ frame: shown, view: state.view, axes: state.axes, densityPv, hidden }),
    [shown, state.view, state.axes, densityPv, hidden]
  );
  // The live inputs the getters read, mirrored after each commit.
  const [live] = useState(() => createLatest(axisInput));
  useLayoutEffect(() => {
    live.set(axisInput);
  }, [live, axisInput]);
  // The drawn Ys' colours and names, read by the style panel when it renders.
  const swatchList = useMemo(
    () =>
      [...yColorMap(state)]
        .filter(([pv]) => !hidden.has(pv))
        .map(([pv, color]) => ({ color, name: pv })),
    [state, hidden]
  );
  const [swatches] = useState(() => createLatest(swatchList));
  useLayoutEffect(() => {
    swatches.set(swatchList);
  }, [swatches, swatchList]);

  const liveChart = useCallback(() => {
    const inst = chart.current?.getEchartsInstance();
    if (!inst || inst.isDisposed?.()) return null;
    return inst;
  }, [chart]);
  const [projection] = useState(() =>
    createCorrelationProjection(
      () => liveChart() as unknown as ChartInstance | null,
      () => live.get()
    )
  );
  const [frames] = useState(createFrameStore);
  const [measure] = useState(() => createCorrelationMeasure(() => live.get().frame));

  // After the mirror above (effects run in order): the card re-reads the new frame.
  const seenFrame = useRef(shown);
  useLayoutEffect(() => {
    if (seenFrame.current === shown) return;
    seenFrame.current = shown;
    frames.bump();
  }, [shown, frames]);

  // A new axis mapping (view, layout, the visible Ys): the next laid-out frame
  // rebuilds the projection even when its extents did not move.
  const { pvs } = visibleYs(axisInput);
  const mappingKey = `${state.view}|${state.axes}|${densityPv}|${pvs.join('\n')}`;
  useLayoutEffect(() => {
    projection.reset();
    projection.offer();
  }, [mappingKey, projection]);

  const { shed } = inputs;
  // Keyed on what the rules read, never on the frame (read through `live`).
  const config = useMemo<HostConfig>(
    () => ({
      catalog: CORRELATION_CATALOG,
      xAxis: VALUE_X_AXIS,
      snap: { snap: (x, y, grid) => nearestPoint(correlationSnapSeries(live.get()), grid, x, y) },
      measure,
      frames,
      shed,
      ownerAxisAt: (px, py, hit) =>
        correlationOwnerAxisAt(px, py, hit, {
          layout: live.get(),
          projection: projection.store.get(),
        }),
      hiddenReason: (a) => correlationHiddenReason(a, state, drawnX),
      swatches: () => swatches.get(),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `state` is read only through the fields listed
    [
      measure,
      frames,
      shed,
      projection,
      drawnX,
      state.x,
      state.ys,
      state.hidden,
      state.dy,
      state.view,
      state.axes,
    ]
  );

  // The host's axes: the drawn Ys (the density Y alone in the density view).
  const shownPvs =
    state.view === 'density' ? [densityYOf(pvs, densityPv)].filter((p) => p !== undefined) : pvs;
  const axesKey = shownPvs.join('\n');
  const axes = useMemo(
    () =>
      axesKey === ''
        ? []
        : axesKey.split('\n').map((pv) => ({ id: pv, name: pv, units: unitsOf(pv) || undefined })),
    [axesKey, unitsOf]
  );
  const host = useDrawingHost(config, inputs.document, projection.store, {
    axes,
    theme: chartTheme,
    chart: liveChart,
  });
  const point = useCallback(
    (p: PlotPoint) => correlationPointMenu(p, state, unitsOf),
    [state, unitsOf]
  );
  useDrawingPlotMenu(host, { point });
  return { host, projection };
}

/** The frame on screen and what follows it; see `useCorrelationFrame`. */
export interface CorrelationFrame {
  /** The frame after the Clear cut; null while there is none. */
  shown: FrameLike | null;
  /** The Clear cut: the newest tsNs on screen at the last Clear, or null. */
  cut: number | null;
  /** The statistics frame of `shown` (null while statistics are off), for the distribution block. */
  statFrame: StatFrame | null;
  /** Every metric of the list for every Y of `shown`. */
  table: MetricTable;
  /** The strip history: every metric per Y over the frames shown. */
  strips: StripHistory;
  /** Clear: cut at the newest row on screen and reset the strips; works while paused. */
  clear(): void;
}

/**
 * The frame on screen after the Clear cut, its metric table and its strip
 * history. `metrics` should keep its identity across renders (the state's
 * list): the table is recomputed when it changes.
 */
// eslint-disable-next-line react-refresh/only-export-components -- the frame on screen is shared with the actions App.tsx registers
export function useCorrelationFrame(
  frame: FrameLike | null,
  metrics: readonly Metric[],
  /** Show statistics: off, nothing is evaluated or recorded. */
  enabled = true
): CorrelationFrame {
  const [cut, setCut] = useState<number | null>(null);
  const shown = useMemo(() => applyCut(frame, cut), [frame, cut]);
  const statFrame = useMemo(() => (enabled ? correlationStatFrame(shown) : null), [shown, enabled]);
  // The strips' clock is the data clock: the newest row on screen, in ms.
  const newest = newestTsNs(shown);
  const stats = useStatistics(
    CORRELATION_METRICS,
    statFrame,
    metrics,
    newest === null ? null : newest / 1e6
  );
  const clearStrips = stats.clear;
  const clear = useCallback(() => {
    const newest = newestTsNs(shown);
    if (newest !== null) setCut(newest);
    clearStrips();
  }, [shown, clearStrips]);
  return { shown, cut, statFrame, table: stats.table, strips: stats.strips, clear };
}

/**
 * Download the chart as drawn, as a PNG named for the newest row of `shown`,
 * with its drawings composed on top unless `drawingsHidden`.
 * Without drawings to compose the download happens in the same event.
 */
// eslint-disable-next-line react-refresh/only-export-components -- Export PNG is an action App.tsx registers
export function downloadChartPng(
  chart: ReactECharts | null,
  shown: FrameLike | null,
  chartTheme: ChartDrawingTheme,
  drawingsHidden = false
): void {
  const instance = chart?.getEchartsInstance();
  if (!instance) return;
  const fileName = exportFileName(shown, 'png');
  const result = chartPngSource(instance, drawingsHidden).getDataURL({
    type: 'png',
    pixelRatio: 2,
    backgroundColor: chartTheme.bg,
  });
  if (typeof result === 'string') downloadHref(result, fileName);
  else void result.then((href) => downloadHref(href, fileName));
}

export interface CorrelationCanvasProps {
  /** The tool's state: view, layout and what it draws. */
  state: CorrelationState;
  /** The frame on screen (`useCorrelationFrame`). */
  frame: CorrelationFrame;
  /** Units of a PV; '' when unknown. */
  unitsOf: (pv: string) => string;
  chartTheme: ChartDrawingTheme;
  chartRef?: Ref<ReactECharts>;
  /** The drawing document and shed store; no drawing parts without it. */
  drawing?: CorrelationDrawingInputs;
  /** The tool's writer (App's `update`): the strip's view toggles and the zoom write through it. */
  update?: (fn: (state: CorrelationState) => CorrelationState) => void;
}

/**
 * The workbench canvas: the chart, the statistics table (under the state's
 * readout toggle, columns from its metrics) and the strips, from state and
 * the frame on screen alone. No
 * toolbar: its actions are the tool's actions bar, its view controls are
 * Properties fields.
 */
export function CorrelationCanvas(props: CorrelationCanvasProps) {
  return props.drawing ? (
    <CorrelationDrawingCanvas {...props} drawing={props.drawing} />
  ) : (
    <CanvasBody {...props} />
  );
}

/**
 * The plot settings of `state`, rebuilt only when a plot-relevant field's
 * reference changes: a drawing commit keeps the option.
 */
function useCorrelationPlotSettings(state: CorrelationState): CorrelationPlotSettings {
  const {
    ys,
    colors,
    markers,
    fit,
    legend,
    grid,
    crosshair,
    tooltip,
    xScale,
    yScale,
    fade,
    hidden,
  } = state;
  return useMemo(
    () =>
      plotSettingsOf({
        ...state,
        ys,
        colors,
        markers,
        fit,
        legend,
        grid,
        crosshair,
        tooltip,
        xScale,
        yScale,
        fade,
        hidden,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- plotSettingsOf reads only the fields listed
    [ys, colors, markers, fit, legend, grid, crosshair, tooltip, xScale, yScale, fade, hidden]
  );
}

/** The canvas with the drawing host mounted. */
function CorrelationDrawingCanvas(
  props: CorrelationCanvasProps & { drawing: CorrelationDrawingInputs }
) {
  const { state, frame, unitsOf, chartTheme, chartRef, drawing, update } = props;
  const settings = useCorrelationPlotSettings(state);
  const view = useMemo<PlotView>(
    () => ({ tooltip: state.tooltip, drag: state.drag }),
    [state.tooltip, state.drag]
  );
  const onView = useMemo(
    () => (update ? (patch: Partial<PlotView>) => update((s) => ({ ...s, ...patch })) : undefined),
    [update]
  );
  const chart = useRef<ReactECharts | null>(null);
  const setChart = useCallback(
    (inst: ReactECharts | null) => {
      chart.current = inst;
      assignRef(chartRef, inst);
    },
    [chartRef]
  );
  // A held object, written by the box's ref callback, read by the listeners.
  const [boxRef] = useState<{ current: HTMLDivElement | null }>(() => ({ current: null }));
  const setBox = useCallback(
    (el: HTMLDivElement | null) => {
      boxRef.current = el;
    },
    [boxRef]
  );
  const drawnX = frame.shown?.columnPvs.x ?? state.x;
  // A new drawing is placed against the X drawn when it is committed.
  const drawnXRef = useRef(drawnX);
  useLayoutEffect(() => {
    drawnXRef.current = drawnX;
  }, [drawnX]);
  const given = drawing.document;
  const document = useMemo<DrawingDocument>(
    () => ({
      ...given,
      commit: (fn, label) =>
        given.commit((list) => stampXRef(list, fn(list), drawnXRef.current), label),
    }),
    [given]
  );
  const inputs = useMemo(() => ({ document, shed: drawing.shed }), [document, drawing.shed]);
  const { host, projection } = useCorrelationDrawingHost({
    state,
    shown: frame.shown,
    drawnX,
    hidden: settings.hidden ?? EMPTY_HIDDEN,
    unitsOf,
    chartTheme,
    chart,
    inputs,
  });
  const [dock] = useState(() => createReadoutDock({ grid: projectionArea(projection.store) }));
  const plotDrawing = useMemo<CorrelationPlotDrawing>(
    () => ({ host, projection, boxRef, setBox, dock }),
    [host, projection, boxRef, setBox, dock]
  );
  const focusBox = useCallback(() => boxRef.current?.focus({ preventScroll: true }), [boxRef]);
  // The shared plot gestures on the chart box; zooms write the state's scales.
  const hidden = settings.hidden ?? EMPTY_HIDDEN;
  const layout = useMemo<CorrelationAxisInput>(
    () => ({
      frame: frame.shown,
      view: state.view,
      axes: state.axes,
      densityPv: densityY(state),
      hidden,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- densityY reads state.dy and state.ys
    [frame.shown, state.view, state.axes, state.dy, state.ys, hidden]
  );
  useCorrelationGestures({
    boxRef,
    chart,
    projection: projection.store,
    state,
    layout,
    update,
    claimsPointer: host.claimsPointer,
  });
  return (
    <CanvasBody
      {...props}
      chartRef={setChart}
      settings={settings}
      plotDrawing={plotDrawing}
      rail={<DrawingRailFor host={host} focusRoot={focusBox} view={view} onView={onView} />}
      statusLine={<DrawingStatusLine host={host} />}
    />
  );
}

const EMPTY_HIDDEN: ReadonlySet<string> = new Set();

function CanvasBody({
  state,
  frame,
  unitsOf,
  chartTheme,
  chartRef,
  settings: given,
  plotDrawing,
  rail,
  statusLine,
}: CorrelationCanvasProps & {
  settings?: CorrelationPlotSettings;
  plotDrawing?: CorrelationPlotDrawing;
  rail?: ReactNode;
  statusLine?: ReactNode;
}) {
  const own = useCorrelationPlotSettings(state);
  const settings = given ?? own;
  const xPv = frame.shown?.columnPvs.x ?? state.x;
  const panel = useStatisticsPanelInputs(frame.table, settings.colors, unitsOf, xPv);
  const stage = (
    <div className="stats-canvas__stage correlation-plot__stage">
      <CorrelationPlot
        frame={frame.shown}
        view={state.view}
        axes={state.axes}
        densityPv={densityY(state)}
        unitsOf={unitsOf}
        chartTheme={chartTheme}
        chartRef={chartRef}
        settings={settings}
        drawing={plotDrawing}
      />
    </div>
  );
  return (
    <section className="correlation-plot stats-canvas" aria-label="Correlation plot">
      {plotDrawing ? (
        <div className="correlation-plot__frame">
          {stage}
          {rail}
        </div>
      ) : (
        stage
      )}
      {statusLine}
      <StatisticsPanel
        show={state.readout}
        catalog={CORRELATION_METRICS}
        metrics={state.metrics}
        table={panel.table}
        strips={frame.strips}
        unitOf={panel.unitOf}
        chartTheme={chartTheme}
        distribution={state.dist}
        frame={frame.statFrame}
      />
    </section>
  );
}

/**
 * The panel's inputs over the frame on screen: the table with the state's
 * colours stamped on its rows, the strip rows, and the unit of a metric's
 * kind for a row (the Y's unit, the X's, Y per X, or none).
 */
function useStatisticsPanelInputs(
  input: MetricTable,
  colors: ReadonlyMap<string, string> | undefined,
  unitsOf: (pv: string) => string,
  xPv: string
) {
  const table = useMemo<MetricTable>(() => {
    if (colors === undefined || colors.size === 0) return input;
    return {
      ...input,
      rows: input.rows.map((row) => {
        const color = colors.get(row.label);
        return color === undefined ? row : { ...row, color };
      }),
    };
  }, [input, colors]);
  const unitOf = useCallback(
    (rowId: string, unit: string): string => {
      const pv = table.rows.find((r) => r.id === rowId)?.label ?? '';
      const yUnits = pv === '' ? '' : unitsOf(pv);
      const xUnits = xPv === '' ? '' : unitsOf(xPv);
      switch (unit) {
        case 'y':
          return yUnits;
        case 'x':
          return xUnits;
        case 'y/x':
          return slopeUnits(yUnits, xUnits);
        default:
          return '';
      }
    },
    [table, unitsOf, xPv]
  );
  return { table, unitOf };
}
