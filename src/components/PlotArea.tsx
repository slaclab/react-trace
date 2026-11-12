import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import ReactECharts from 'echarts-for-react';
import { useChartFont, useColorMode } from '@slaclab/canopy-shell';
import { useChartTheme } from '@slaclab/canopy-charts';
import { useDrawingTheme } from '../annotationTheme';
import { Add, Close, ColumnDependency, Grid, Launch, Login, Maximize } from '@carbon/icons-react';
import type { Axis, Plot } from '../types';
import type { ArchiveSeriesResult } from '../hooks/useArchiveSeries';
import type { LiveSeriesResult } from '../hooks/useLiveSeries';
import type { FormulaSeriesResult } from '../hooks/useFormulaSeries';
import {
  isAtNow,
  nsToMs,
  relativeSpanFor,
  resolveTimeWindow,
  windowMsToNs,
  windowNsToMs,
  type TimeWindowMs,
  type TimeWindowNs,
} from '../api/time';
import {
  buildProjection,
  createProjectionStore,
  isPlotChrome,
  stretchFactorX,
  type ProjectionInstance,
} from '../plot/geometry';
import { attachReadoutDrag, createReadoutDock, projectionArea } from '../plot/readoutDock';
import type { OverlayHandle } from '../annotations/AnnotationLayer';
import type { Annotation } from '../annotations/model';
import { AxisBadges } from '../tools/trace/plot/AxisBadges';
import { DrawingRail } from '../annotations/DrawingRail';
import { AxisMenu, TimeBandMenu } from '../tools/trace/plot/menus';
import { BUILTIN_CATALOG } from '../annotations/catalog';
import { DrawingLayers, DrawingRailFor } from '../annotations/host/DrawingOverlay';
import { DrawingStatusLine } from '../annotations/host/DrawingStatusLine';
import {
  useDrawingHost,
  useDrawingPlotMenu,
  type DrawingHost,
} from '../annotations/host/useDrawingHost';
import { useTraceHostConfig } from '../tools/trace/drawing/useTraceHostConfig';
import { tracePlotView } from '../tools/trace/plotView';
import type { PlotView } from '../plot/plotToggles';
import { useTraceDrawingDocument } from '../tools/trace/drawing/document';
import { RangeControls } from '../tools/trace/plot/RangeControls';
import { DEFAULT_TOOL_PREFS, type AnnotationToolPrefs } from '../annotations/tools';
import { isNavigationCommand, PAN_STEP, ZOOM_STEP } from '../annotations/keys';
import { resolveKey } from '../tools/trace/drawing/builtin';
import {
  allLoadedXAxis,
  panTime,
  stretchTimeRightAnchored,
  zoomTimeAt,
  type LoadedResults,
} from '../tools/trace/drawing/time';
import { traceLabel } from '../traceLabel';
import { useLatest } from '../workbench/useLatest';
import { useContextMenu } from '../workbench/contextMenu/context';
import { LegendMenu, quietLegendHover } from '../tools/contextMenu';
import { TraceCursorContext, tracePointMenu } from '../tools/trace/menu';
import { useElementWidth } from '../hooks/useElementWidth';
import type { PngSource } from '../io/exportPlotImage';
import { PLOT_CAPTURE_PIXEL_RATIO, composePlotCapture } from '../capturePlot';
import { StatisticsPanel } from '../statistics/StatisticsPanel';
import { useStatistics } from '../statistics/useStatistics';
import {
  frameClockMs,
  plotMetrics,
  TRACE_METRICS,
  traceStatFrame,
  traceUnitOf,
} from '../tools/trace/metrics';
import {
  bandAt,
  usePlotGestures,
  type GestureAxis,
  type GestureGrid,
  type PlotGestureSurface,
  type SideAxis,
  type XBandDrag,
} from '../plot/gestures';
import {
  AXIS_OFFSET,
  hitTestAxis,
  hitTestTimeBand,
  type AxisHitZone,
  type GridBand,
} from './axisHitTest';
import {
  notArchivedPvs,
  buildPlotOption,
  GRID_BOTTOM,
  GRID_TOP,
  plotLayout,
  useTraceData,
  useTraceSamples,
} from './plotOption';
import { refreshIntervalMs } from '../hooks/useAutoScrollTimers';
import { useFollowNow } from '../hooks/useFollowNow';

/** The id of Trace's one X axis, the time window, as the gesture layer names it. */
const TIME_AXIS_ID = 'time';

interface PlotAreaProps extends AnnotationChannel {
  plots: Plot[];
  activePlotId: string;
  viewMode: 'tabs' | 'grid';
  archiveResultsByPlot: Map<string, Map<string, ArchiveSeriesResult>>;
  liveResultsByPlot: Map<string, Map<string, LiveSeriesResult>>;
  formulaResultsByPlot: Map<string, Map<string, FormulaSeriesResult>>;
  onSetActivePlot: (id: string) => void;
  onAddPlot: () => void;
  onRemovePlot: (id: string) => void;
  onSetViewMode: (mode: 'tabs' | 'grid') => void;
  onPopOutPlot: (id: string) => void;
  /** Plot IDs currently detached into their own windows. */
  detachedPlotIds: string[];
  onDetachPlot: (id: string) => void;
  onReattachPlot: (id: string) => void;
  /**
   * The one window-write path: gesture tasks call it with the new
   * visible window; `follow` records the display window only.
   */
  onViewWindowChange?: (plotId: string, window: TimeWindowNs, opts?: { follow?: boolean }) => void;
  /**
   * Each plot's display window (TraceApp's `displayWindowByPlotId`): the
   * controlled `viewWindowNs` of every mount, so the chart shows exactly it.
   */
  displayWindowByPlotId: ReadonlyMap<string, TimeWindowNs>;
  /** The instant each plot's time axis ends at (TraceApp's `axisEndFor`, see axisEndMs). */
  axisEndFor?: (plotId: string) => number;
  /** Whether each plot tracks "now" (TraceApp's `followingFor`, see isFollowing). */
  followingFor?: (plotId: string) => boolean;
  onAxisRangesChange?: (plotId: string, ranges: Map<string, [number, number]>) => void;
  /** Commits a per-axis min/max (or autoScale flip) from a direct axis pan/zoom. */
  onUpdateAxis?: (plotId: string, axisId: string, updates: Partial<Axis>) => void;
  /**
   * Writes a plot's x-axis (a range pick: All, a follow-live stretch, a chip).
   * The new `xAxis` identity drops the plot's view window and re-enables
   * autoscroll.
   */
  onApplyXAxis?: (plotId: string, xAxis: Plot['xAxis']) => void;
  /** Publishes each plot's ECharts instance for PNG capture (active=false on unmount). */
  onChartInstance?: (plotId: string, instance: PngSource, active: boolean) => void;
  /**
   * Each plot's statistics window (TraceApp's `statsWindowByPlotId`: the
   * debounced fetch window, else its relative range against the frozen "now");
   * a plot absent from it resolves its own, quantised to the second.
   */
  statsWindowByPlotId?: ReadonlyMap<string, TimeWindowNs>;
  /** The last relative range each plot showed this session (TraceApp's `lastRelativeSpan`), Now's target. */
  lastRelativeSpanFor?: (plotId: string) => string | undefined;
  /**
   * The host's tile bar draws the verbs, the layout toggle among them: no Tab
   * view / Grid view pair in-frame; Add plot and the range controls stay.
   */
  hostBar?: boolean;
}

/**
 * The drawing channel TraceApp holds for every plot; each
 * mount gets its own plot's slice through `annotationMountProps`.
 */
export interface AnnotationChannel {
  /** Plot ids whose drawings are hidden (TraceApp's `ui.annotationsHidden`). */
  annotationsHiddenPlotIds?: ReadonlySet<string>;
  /** Each plot's drawing-tool prefs (TraceApp's `annotationPrefs`); absent = defaults. */
  annotationPrefsByPlot?: ReadonlyMap<string, AnnotationToolPrefs>;
  /** Patches one plot's drawing-tool prefs (tool, stay, magnet). */
  onAnnotationPrefs?: (plotId: string, patch: Partial<AnnotationToolPrefs>) => void;
  /** The selected drawing's id (an `item`/`annotation` selection), else null. */
  selectedAnnotationId?: string | null;
  /** Selects a drawing of `plotId` (`null` = none) on TraceApp's selection store. */
  onSelectAnnotation?: (plotId: string, id: string | null) => void;
  /**
   * Applies one drawing gesture to `plotId`'s list:
   * TraceApp runs `update()` with `withAnnotations(plot, fn(plot.annotations))`.
   */
  onCommitAnnotations?: (
    plotId: string,
    fn: (list: Annotation[]) => Annotation[],
    label: string
  ) => void;
  /** Writes one plot's hide-all (TraceApp's `ui.setAnnotationsHidden`). */
  onAnnotationsHidden?: (plotId: string, on: boolean) => void;
  /** Patches one plot's view settings (the strip's tooltip and drag mode). */
  onPlotView?: (plotId: string, patch: Partial<PlotView>) => void;
}

/** The drawing props of one plot's mount, from the channel (tab, grid, fullscreen, detached). */
// eslint-disable-next-line react-refresh/only-export-components -- shared by TraceApp's fullscreen and detached mounts
export function annotationMountProps(
  plotId: string,
  channel: AnnotationChannel
): Pick<
  SinglePlotProps,
  | 'annotationsHidden'
  | 'annotationPrefs'
  | 'onAnnotationPrefs'
  | 'selectedAnnotationId'
  | 'onSelectAnnotation'
  | 'onCommitAnnotations'
  | 'onAnnotationsHidden'
  | 'onPlotView'
> {
  const {
    onAnnotationPrefs,
    onSelectAnnotation,
    onCommitAnnotations,
    onAnnotationsHidden,
    onPlotView,
  } = channel;
  return {
    annotationsHidden: channel.annotationsHiddenPlotIds?.has(plotId) === true,
    annotationPrefs: channel.annotationPrefsByPlot?.get(plotId) ?? DEFAULT_TOOL_PREFS,
    onAnnotationPrefs: onAnnotationPrefs
      ? (patch: Partial<AnnotationToolPrefs>) => onAnnotationPrefs(plotId, patch)
      : undefined,
    selectedAnnotationId: channel.selectedAnnotationId ?? null,
    onSelectAnnotation: onSelectAnnotation
      ? (id: string | null) => onSelectAnnotation(plotId, id)
      : undefined,
    onCommitAnnotations: onCommitAnnotations
      ? (fn: (list: Annotation[]) => Annotation[], label: string) =>
          onCommitAnnotations(plotId, fn, label)
      : undefined,
    onAnnotationsHidden: onAnnotationsHidden
      ? (on: boolean) => onAnnotationsHidden(plotId, on)
      : undefined,
    onPlotView: onPlotView ? (patch: Partial<PlotView>) => onPlotView(plotId, patch) : undefined,
  };
}

// Shown in the main window where a detached plot's chart would otherwise be.
function DetachedPlaceholder({ title, onReattach }: { title: string; onReattach: () => void }) {
  return (
    <div className="plot-detached-placeholder">
      <Launch size={24} />
      <span className="plot-detached-placeholder__title">{title} is detached</span>
      <span className="plot-detached-placeholder__hint">Open in its own window</span>
      <button className="plot-detached-placeholder__btn" onClick={onReattach}>
        <Login size={16} />
        Reattach
      </button>
    </div>
  );
}

interface SinglePlotProps {
  plot: Plot;
  archiveResults: Map<string, ArchiveSeriesResult>;
  liveResults: Map<string, LiveSeriesResult>;
  formulaResults: Map<string, FormulaSeriesResult>;
  /**
   * Writes a new visible window. Only gesture handlers call it; the
   * chart itself never reports a window (the inside dataZoom is retired).
   */
  onViewWindowChange?: (window: TimeWindowNs, opts?: { follow?: boolean }) => void;
  /**
   * The controlled visible window: the x axis spans exactly it and every
   * series is cut to it. TraceApp feeds it from `displayWindowByPlotId`; it is
   * never re-resolved from the clock here. Absent (tests, a mount without a
   * window yet) the chart shows the plot's configured range.
   */
  viewWindowNs?: TimeWindowNs;
  /**
   * The instant the plot's time range ends at, from the app (see axisEndMs):
   * the plot's autoscroll clock, or the newest live sample past it while
   * following. The chart never reads the wall clock for it, so a re-render
   * can't move the axis.
   */
  endMs?: number;
  /**
   * True while the plot tracks "now" (see isFollowing). The axis then also
   * scrolls on animation frames between clock ticks (useFollowNow), and
   * `viewWindowNs` is the configured range ending at the scrolled instant.
   */
  following?: boolean;
  /** The resolved window the statistics are computed over (PlotWithStatistics). */
  statsWindowNs?: TimeWindowNs;
  onAxisRangesChange?: (ranges: Map<string, [number, number]>) => void;
  /**
   * Commits a per-axis min/max (or autoScale flip) when the user drags or wheels
   * directly on a Y-axis band. See the per-axis pointer listeners in SinglePlot.
   */
  onUpdateAxis?: (axisId: string, updates: Partial<Axis>) => void;
  /**
   * Writes this plot's x-axis; the new identity resets the view window and
   * re-enables autoscroll.
   */
  onApplyXAxis?: (xAxis: Plot['xAxis']) => void;
  /**
   * True when this instance is the fullscreen (popped-out) copy of a plot. The
   * in-window copy stays mounted underneath with the same `data-plot-id`, so
   * this marks which one a print snapshot should capture; see capturePlotPng.
   */
  fullscreen?: boolean;
  /**
   * Publishes this plot's live ECharts instance so the app can capture it as a
   * PNG for e-log posting. Called with active=true after mount, active=false on
   * unmount; the same instance object is passed both times so a registry can
   * match by identity (a plot can be mounted twice, e.g. grid + fullscreen).
   */
  onChartInstance?: (instance: PngSource, active: boolean) => void;
  /**
   * The drawing channel, read by the drawing overlay.
   * `annotationsHidden`: this plot's drawings are hidden (hide-all, session
   * only — no `Plot` field). `annotationPrefs`: this plot's tool prefs;
   * `onAnnotationPrefs` patches them. `selectedAnnotationId`: the selected
   * drawing, if any; `onSelectAnnotation` selects one (`null` = none).
   */
  annotationsHidden?: boolean;
  annotationPrefs?: AnnotationToolPrefs;
  onAnnotationPrefs?: (patch: Partial<AnnotationToolPrefs>) => void;
  selectedAnnotationId?: string | null;
  onSelectAnnotation?: (id: string | null) => void;
  /** Applies one drawing gesture's edit to this plot's drawings. */
  onCommitAnnotations?: (fn: (list: Annotation[]) => Annotation[], label: string) => void;
  /** Writes this plot's hide-all from the drawing rail. */
  onAnnotationsHidden?: (on: boolean) => void;
  /** Patches this plot's view settings from the strip (tooltip, drag mode). */
  onPlotView?: (patch: Partial<PlotView>) => void;
}

/**
 * What the drawing overlay exposes to its plot: `AnnotationLayer` attaches it
 * to the `overlayRef` SinglePlot owns, via useImperativeHandle. While no overlay is mounted the ref stays null and nothing
 * is claimed.
 */
export type { OverlayHandle };

export function SinglePlot({
  plot,
  archiveResults,
  liveResults,
  formulaResults,
  viewWindowNs: viewWindowProp,
  endMs,
  following = false,
  onViewWindowChange,
  onAxisRangesChange,
  onUpdateAxis,
  onApplyXAxis,
  fullscreen,
  onChartInstance,
  annotationsHidden,
  annotationPrefs,
  onAnnotationPrefs,
  selectedAnnotationId,
  onSelectAnnotation,
  onCommitAnnotations,
  onAnnotationsHidden,
  onPlotView,
}: SinglePlotProps) {
  // The canopy-charts theme of the current canopy-shell colour mode, with
  // the drawing colours layered on (annotationTheme.ts).
  const { colorMode } = useColorMode();
  const theme = useDrawingTheme();
  const visibleAxes = plot.axes.filter((a) => a.visible);
  // One line-data map per result change, shared by the option builder and the
  // drawing overlay instead of recomputed on every render; the samples feed the
  // tooltip and the INVALID markers.
  const traceData = useTraceData(plot.traces, archiveResults, liveResults, formulaResults);
  const samples = useTraceSamples(plot.traces, archiveResults, liveResults, formulaResults);
  // The overlay's curves (magnet candidates, the measure's adopted curve, the
  // style panel's curve colours) and the binned-archive facts its measure
  // card reads.
  const overlayTraces = useMemo(
    () =>
      plot.traces
        .filter((t) => t.visible)
        .map((t) => ({
          id: t.id,
          axisId: t.axisId,
          color: t.color,
          name: t.displayName || t.pvName,
        })),
    [plot.traces]
  );
  const { binnedTraceIds, archiveEndMs } = useMemo(() => {
    const ids = new Set<string>();
    const ends = new Map<string, number>();
    for (const [id, result] of archiveResults) {
      if (result.mode !== 'binned') continue;
      ids.add(id);
      const last = result.mean[result.mean.length - 1];
      if (last) ends.set(id, last.time);
    }
    return {
      binnedTraceIds: ids as ReadonlySet<string>,
      archiveEndMs: ends as ReadonlyMap<string, number>,
    };
  }, [archiveResults]);

  const chartRef = useRef<ReactECharts>(null);
  // Our own wrapper around the chart; the per-axis pointer listeners attach
  // here because it survives echarts-for-react's dispose/recreate cycles.
  // `wrapCallbackRef` attaches it and follows its width, which republishes the
  // projection on a resize.
  const [wrapCallbackRef, width, wrapRef] = useElementWidth();
  // The drawing rail stops pointerdown, so the wrapper's focus-on-press never
  // sees a rail press: arming focuses the root here.
  const focusPlotRoot = useCallback(() => {
    wrapRef.current?.focus({ preventScroll: true });
  }, [wrapRef]);
  // Canvas text does not inherit CSS: the chart draws in the family the
  // wrapper computes, named only once it has loaded so the option changes
  // then and ECharts redraws with the real face.
  const chartFont = useChartFont(wrapRef);

  // Projection + cursor stores, one each per mount; the overlay, axis badges
  // and status line subscribe.
  // The projection is rebuilt only from `finished` and the resize path, never
  // during render, and each rebuild resolves the *live* instance because
  // echarts-for-react disposes and recreates it. The layout it projects through
  // (and its live-instance lookup) is installed as the store's source after
  // each render. The cursor store is the drawing host's own (one per mount);
  // the wrapper's mousemove writes it, so a pointer move
  // re-renders only its readers.
  const [projectionStore] = useState(createProjectionStore);
  // The data read-out's dock (pinned: the top-right corner), and its grip.
  const [readoutDock] = useState(() =>
    createReadoutDock({ grid: projectionArea(projectionStore) })
  );
  useLayoutEffect(() => {
    readoutDock.setPinned(plot.pinDataWindow === true);
  }, [readoutDock, plot.pinDataWindow]);
  useEffect(() => {
    const dom = chartRef.current?.getEchartsInstance()?.getDom?.();
    return dom ? attachReadoutDrag(dom, readoutDock) : undefined;
  }, [readoutDock]);

  // Per-axis screen geometry + metadata, recomputed each render and read by the
  // (mount-once) pointer listeners so hit-testing always reflects the current
  // axis layout without re-subscribing. See the option builder for the matching
  // grid/offset math.
  const axisLayoutRef = useRef<AxisHitZone[]>([]);
  const gridBandRef = useRef<GridBand>({ top: 40, bottom: 60, left: 70, right: 20 });

  // What the chart shows. A following plot scrolls smoothly on animation
  // frames between clock ticks (useFollowNow), so its window is the configured
  // range ending at the scrolled instant; any other plot shows `viewWindowNs`.
  const getWindow = useCallback(
    () => wrapRef.current?.ownerDocument.defaultView ?? null,
    [wrapRef]
  );
  const getWidthPx = useCallback(
    () =>
      (wrapRef.current?.clientWidth ?? 0) - gridBandRef.current.left - gridBandRef.current.right,
    [wrapRef]
  );
  const follows = following && endMs !== undefined;
  const spanWindow = resolveTimeWindow(plot.xAxis, endMs ?? 0).window;
  const shownEndMs = useFollowNow({
    following: follows,
    anchorMs: endMs ?? 0,
    spanMs: nsToMs(spanWindow.toNs - spanWindow.fromNs),
    getWindow,
    getWidthPx,
  });
  const viewWindowNs = follows ? resolveTimeWindow(plot.xAxis, shownEndMs).window : viewWindowProp;
  // Latest onUpdateAxis, so the mount-once listeners always call the current one.
  const onUpdateAxisRef = useRef(onUpdateAxis);
  // Latest onApplyXAxis, for the mount-once listeners (range gestures).
  const onApplyXAxisRef = useRef(onApplyXAxis);
  // Time-window wheel state. The latest window
  // prop, its writer and the configured range mirror into refs for the
  // mount-once wheel router. Wheel results accumulate in `pendingWindowRef`
  // (epoch ms), which stands in for the prop until the prop catches up, and
  // flush once per animation frame through onViewWindowChange.
  const viewWindowRef = useRef(viewWindowNs);
  const onViewWindowChangeRef = useRef(onViewWindowChange);
  const xAxisRef = useRef(plot.xAxis);
  const pendingWindowRef = useRef<TimeWindowMs | null>(null);
  const windowFrameRef = useRef<number | null>(null);
  // Time-band gestures: the refresh interval decides whether a window "ends at
  // now" (isAtNow), and the loaded buffers + visible curve ids feed the
  // double-click All.
  const refreshIntervalRef = useRef(refreshIntervalMs(plot));
  // The open context menu, set by the wrapper's contextmenu listener. `target`
  // is the wrapper's own document body and x/y that document's client
  // coordinates, so a detached plot's menu opens in its own window. The
  // interior plot menu is the drawing host's; one menu is open at a time, so
  // opening either closes the other.
  const [contextMenu, setContextMenu] = useState<
    | null
    | { kind: 'axis'; axisId: string; target: Element; x: number; y: number }
    | { kind: 'time'; all: Plot['xAxis'] | null; target: Element; x: number; y: number }
  >(null);
  const loadedRef = useRef<{ results: LoadedResults; visibleTraceIds: string[] }>({
    results: { archive: archiveResults, live: liveResults, formula: formulaResults },
    visibleTraceIds: [],
  });
  // What a left-drag in the plot does (the strip's drag mode).
  const dragModeRef = useRef(tracePlotView(plot).drag);
  // The drawing host: Trace's config (built once per mount; live data read
  // through a ref, frames bumped on traceData) over a document adapting the
  // AnnotationChannel props. The host owns the overlay's handle: the interior
  // pan never starts while it claims the press, and the overlay forwards the
  // cursor to the *live* chart instance while it covers the canvas.
  const drawingConfig = useTraceHostConfig({
    traceData,
    traces: overlayTraces,
    binnedTraceIds,
    archiveEndMs,
    axes: visibleAxes,
  });
  const drawingDocument = useTraceDrawingDocument({
    annotations: plot.annotations,
    annotationsHidden,
    annotationPrefs,
    onAnnotationPrefs,
    selectedAnnotationId,
    onSelectAnnotation,
    onCommitAnnotations,
    onAnnotationsHidden,
  });
  const liveChart = useCallback(() => {
    const inst = chartRef.current?.getEchartsInstance();
    if (!inst || inst.isDisposed?.()) return null;
    return inst;
  }, []);
  const host = useDrawingHost(drawingConfig, drawingDocument, projectionStore, {
    axes: visibleAxes,
    theme,
    chart: liveChart,
  });
  const { cursorStore } = host;
  // The cursor's time while it is inside the plot: "Copy value at cursor"
  // from a row or the legend reads the last one.
  const recordCursor = useContext(TraceCursorContext);
  const plotId = plot.id;
  useEffect(() => {
    if (recordCursor === null) return;
    return cursorStore.subscribe(() => {
      const c = cursorStore.get();
      const proj = projectionStore.get();
      const grid = c && proj ? proj.gridAt(c.x, c.y) : undefined;
      const t = grid && c ? grid.xToT(c.x) : Number.NaN;
      if (Number.isFinite(t)) recordCursor(plotId, t);
    });
  }, [cursorStore, projectionStore, recordCursor, plotId]);
  // The plot menu's drawing entries are disabled without a commit writer
  // (today's rule): with no writer, they are read through a host whose owner
  // rule places nothing.
  const canCommit = onCommitAnnotations !== undefined;
  const menuHost = useMemo<DrawingHost>(
    () => (canCommit ? host : { ...host, config: { ...host.config, ownerAxisAt: () => null } }),
    [host, canCommit]
  );
  // The status line keeps today's slots: no armed-tool hint (Trace never
  // passed the tool), so it reads a document whose tool is the cursor.
  const statusHost = useMemo<DrawingHost>(
    () => ({
      ...host,
      document: { ...host.document, prefs: { ...host.document.prefs, tool: 'cursor' } },
    }),
    [host]
  );
  // The latest host for the mount-once listeners. Alt+tool arms only when
  // there is a prefs writer (claimed only then); Esc and Delete go through
  // the host and are claimed only when consumed, so an Esc with nothing to
  // cancel falls through to the workbench's Escape reset. primary+Z stays the
  // TraceApp document listener.
  const drawingRef = useRef({ host, canArm: onAnnotationPrefs !== undefined });
  useLayoutEffect(() => {
    drawingRef.current = { host, canArm: onAnnotationPrefs !== undefined };
  });

  // Publish a stable PngSource proxy up to the app for PNG capture; clear on
  // unmount so a captured-but-gone plot (closed tab, reattached window) isn't
  // stale. The proxy resolves the *live* ECharts instance on each call instead
  // of capturing one at mount: echarts-for-react disposes and recreates its
  // internal instance across some re-renders, so a snapshotted reference goes
  // stale and getDataURL() silently returns undefined on the dead instance.
  useEffect(() => {
    const source: PngSource = {
      async getDataURL(opts) {
        const inst = chartRef.current?.getEchartsInstance();
        const root = wrapRef.current;
        if (!inst || !inst.getDom() || !root) return '';
        // The layer renders no svg while drawings are hidden, so none is composed.
        return composePlotCapture(
          root,
          inst,
          opts?.backgroundColor ?? theme.bg,
          opts?.pixelRatio ?? PLOT_CAPTURE_PIXEL_RATIO
        );
      },
    };
    onChartInstance?.(source, true);
    return () => onChartInstance?.(source, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- register once per mount; the callback is stable
  }, []);

  const handleFinished = useCallback(() => {
    // Every finished layout republishes the projection, whoever else listens.
    projectionStore.bump();
    if (!onAxisRangesChange) return;
    const inst = chartRef.current?.getEchartsInstance();
    // `finished` can fire mid-mount or after disposal when the DOM and model
    // aren't both ready; bail in those cases instead of crashing.
    if (!inst || !inst.getDom()) return;
    type AxisModel = { axis: { scale: { getExtent: () => [number, number] } } };
    const model = (
      inst as unknown as {
        getModel: () => { getComponent: (n: string, i: number) => AxisModel } | undefined;
      }
    ).getModel();
    if (!model) return;
    const next = new Map<string, [number, number]>();
    visibleAxes.forEach((axis, idx) => {
      const ext = model.getComponent('yAxis', idx)?.axis?.scale?.getExtent();
      if (ext) next.set(axis.id, [ext[0], ext[1]]);
    });
    onAxisRangesChange(next);
  }, [onAxisRangesChange, visibleAxes, projectionStore]);

  // Pointer position for the status line, in wrapper-local pixels. Its own
  // listener, kept out of the gesture effect: it only writes the cursor store.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const onMove = (e: MouseEvent) => {
      if (isPlotChrome(e.target)) return;
      const r = wrap.getBoundingClientRect();
      cursorStore.set({ x: e.clientX - r.left, y: e.clientY - r.top });
    };
    const onLeave = () => cursorStore.set(null);
    wrap.addEventListener('mousemove', onMove);
    wrap.addEventListener('mouseleave', onLeave);
    return () => {
      wrap.removeEventListener('mousemove', onMove);
      wrap.removeEventListener('mouseleave', onLeave);
    };
  }, [wrapRef, cursorStore]);

  // The plot gestures (annotations/gestures.ts) — the same drags, wheel and
  // double-clicks as every plot tool — over Trace's surface: one grid whose X
  // axis is the time window and whose Y axes are the visible axes. The time
  // band's drag stays Trace's own (anchored at its right edge, following now).
  // Context menus and keys are Trace's and stay below.
  //
  // Listeners live on OUR wrapper div (and its window), never on the ECharts /
  // zrender instance: echarts-for-react 3.x initializes asynchronously. It
  // measures with a throwaway instance that it disposes right after the first
  // `finished` event, then builds the real chart, and also disposes/rebuilds on
  // some prop changes. Anything subscribed to a zrender instance at mount time
  // dies within the first frame. The wrapper div is stable for the lifetime of
  // this component, so each handler resolves the *live* instance on demand.
  type Ecm = {
    convertFromPixel: (fh: { yAxisIndex: number }, px: number) => number;
    convertToPixel: (fh: { yAxisIndex: number }, val: number) => number;
    getModel: () => {
      getComponent: (
        n: string,
        i: number
      ) => { axis: { scale: { getExtent: () => [number, number] } } } | undefined;
    };
    getWidth: () => number;
    getHeight: () => number;
    getZr: () => { setCursorStyle: (cursor: string) => void };
    isDisposed: () => boolean;
  };
  const liveEc = useCallback((): Ecm | null => {
    const inst = chartRef.current?.getEchartsInstance() as unknown as Ecm | undefined;
    return inst && !inst.isDisposed() ? inst : null;
  }, []);

  // Grid rectangle in canvas px (left/top/width/height).
  const gridRectOf = (ec: Ecm) => {
    const g = gridBandRef.current;
    return {
      left: g.left,
      top: g.top,
      width: ec.getWidth() - g.left - g.right,
      height: ec.getHeight() - g.top - g.bottom,
    };
  };

  // The window a gesture acts on: the pending one while a write is in flight,
  // else the prop, else the configured range (no controlled window).
  const currentWindowMs = useCallback((): TimeWindowMs => {
    if (pendingWindowRef.current) return pendingWindowRef.current;
    const w = viewWindowRef.current ?? resolveTimeWindow(xAxisRef.current, Date.now()).window;
    return windowNsToMs(w);
  }, []);

  // Queue a window and flush it once per frame: any number of
  // wheel events between two frames reach the app as ONE onViewWindowChange.
  const queueWindow = useCallback(
    (next: TimeWindowMs) => {
      if (!Number.isFinite(next.from) || !Number.isFinite(next.to) || next.to <= next.from) return;
      pendingWindowRef.current = next;
      if (windowFrameRef.current !== null) return;
      const win = wrapRef.current?.ownerDocument.defaultView ?? window;
      windowFrameRef.current = win.requestAnimationFrame(() => {
        windowFrameRef.current = null;
        const w = pendingWindowRef.current;
        if (!w) return;
        onViewWindowChangeRef.current?.(windowMsToNs(w));
      });
    },
    [wrapRef]
  );

  // A drag of the time band: the window captured at mousedown is scaled about
  // its RIGHT edge by the total horizontal drag, one write per animation
  // frame. `follow` is fixed at mousedown: a window that ends at now keeps
  // following, so its frames write `{ follow: true }` and the gesture ends
  // with ONE relative xAxis. The end (mouseup, a lost release, blur, cleanup)
  // delivers a still-pending frame; a follow drag ALWAYS performs its final
  // write from the newest window it knows of, so no plot is left holding a
  // follow window with autoscroll on. That write is one relative xAxis, or a
  // plain frozen window when the span is under the relative floor or no xAxis
  // writer is wired.
  const timeBandDrag = useCallback((): XBandDrag | null => {
    if (!onViewWindowChangeRef.current) return null;
    const win = wrapRef.current?.ownerDocument.defaultView ?? window;
    const captured = currentWindowMs();
    const follow = isAtNow(captured, Date.now(), refreshIntervalRef.current);
    let active = false;
    let latest: TimeWindowMs | null = null;
    let frame: number | null = null;
    let pendingDx: number | null = null;
    const stretched = (dx: number) => {
      const factor = stretchFactorX(dx);
      if (factor === 1) return null;
      const next = stretchTimeRightAnchored(captured, factor);
      if (!Number.isFinite(next.from) || !(next.to > next.from)) return null;
      return next;
    };
    const flush = () => {
      const dx = pendingDx;
      pendingDx = null;
      if (dx === null) return;
      const next = stretched(dx);
      if (!next) return;
      latest = next;
      if (follow) onViewWindowChangeRef.current?.(windowMsToNs(next), { follow: true });
      else onViewWindowChangeRef.current?.(windowMsToNs(next));
    };
    const cancelFrame = () => {
      if (frame !== null) win.cancelAnimationFrame(frame);
      frame = null;
    };
    return {
      move(dx) {
        active = true;
        pendingDx = dx;
        if (frame !== null) return;
        frame = win.requestAnimationFrame(() => {
          frame = null;
          flush();
        });
      },
      end(commit) {
        cancelFrame();
        if (commit && !follow) flush();
        else if (follow && pendingDx !== null) latest = stretched(pendingDx) ?? latest;
        pendingDx = null;
        if (!follow || !active || !latest) return;
        const span = relativeSpanFor(latest);
        const apply = onApplyXAxisRef.current;
        if (span && apply) apply({ ...xAxisRef.current, timeRange: span });
        else onViewWindowChangeRef.current?.(windowMsToNs(latest));
      },
    };
  }, [wrapRef, currentWindowMs]);

  // The gesture axes, kept across events so a freeze marks them manual at
  // once; rebuilt from the plot after each render.
  const gestureAxesRef = useRef<{
    x: GestureAxis;
    sides: SideAxis[];
    indexOf: Map<string, number>;
  }>({
    x: { id: TIME_AXIS_ID, dim: 'x', log: false, auto: false },
    sides: [],
    indexOf: new Map(),
  });
  const gestureSurface = useMemo<PlotGestureSurface>(() => {
    const gridOf = (ec: Ecm): GestureGrid => {
      const { x, sides } = gestureAxesRef.current;
      return { rect: gridRectOf(ec), x, ys: sides.map((s) => s.axis) };
    };
    return {
      chart() {
        const ec = liveEc();
        if (!ec) return null;
        return {
          getWidth: () => ec.getWidth(),
          getHeight: () => ec.getHeight(),
          setCursor: (cursor) => ec.getZr().setCursorStyle(cursor),
        };
      },
      grids() {
        const ec = liveEc();
        return ec ? [gridOf(ec)] : [];
      },
      axisAt(x, y) {
        const ec = liveEc();
        if (!ec) return null;
        return bandAt(x, y, gridOf(ec), gestureAxesRef.current.sides, AXIS_OFFSET);
      },
      extent(axis) {
        if (axis.dim === 'x') {
          const w = currentWindowMs();
          return { min: w.from, max: w.to };
        }
        const ec = liveEc();
        const idx = gestureAxesRef.current.indexOf.get(axis.id);
        if (!ec || idx === undefined) return null;
        const ext = ec.getModel().getComponent('yAxis', idx)?.axis?.scale?.getExtent();
        return ext ? { min: ext[0], max: ext[1] } : null;
      },
      valueAt(axis, grid, px) {
        if (axis.dim === 'x') {
          // From the window being zoomed, never convertFromPixel, which lags
          // until the next `finished`.
          const w = currentWindowMs();
          return w.from + ((px - grid.rect.left) / grid.rect.width) * (w.to - w.from);
        }
        const ec = liveEc();
        const idx = gestureAxesRef.current.indexOf.get(axis.id);
        if (!ec || idx === undefined) return NaN;
        return ec.convertFromPixel({ yAxisIndex: idx }, px);
      },
      write(axis, { min, max }, { freeze, wheel }) {
        if (axis.dim === 'x') {
          const next = { from: min, to: max };
          // A wheel burst flushes once per frame; a drag frame writes at once.
          if (wheel) queueWindow(next);
          else onViewWindowChangeRef.current?.(windowMsToNs(next));
          return true;
        }
        onUpdateAxisRef.current?.(axis.id, freeze ? { autoScale: false, min, max } : { min, max });
        // Context menus read the same zone: it is manual from now on.
        const zone = axisLayoutRef.current.find((a) => a.axisId === axis.id);
        if (zone && freeze) zone.autoScale = false;
        return true;
      },
      reset(axis) {
        if (axis.dim === 'y') {
          onUpdateAxisRef.current?.(axis.id, { autoScale: true });
          const zone = axisLayoutRef.current.find((a) => a.axisId === axis.id);
          if (zone) zone.autoScale = true;
          return;
        }
        // The time band's All: earliest loaded sample to now as a relative
        // span, applied whenever it exists.
        const { results, visibleTraceIds } = loadedRef.current;
        const all = allLoadedXAxis(xAxisRef.current, results, visibleTraceIds, Date.now());
        if (all) onApplyXAxisRef.current?.(all);
      },
      dragMode: () => dragModeRef.current,
      claimsPointer: (e) => drawingRef.current.host.claimsPointer(e),
      xBandDrag: () => timeBandDrag(),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refs only; built once per mount
  }, []);
  usePlotGestures(wrapRef, gestureSurface);

  // Context menus and keys (Trace's own; the gestures are the layer's above).
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;

    // Wrapper-local coordinates. The wrapper exactly overlays the chart canvas
    // (both fill 100% × 100% with no padding), so these are canvas pixels.
    const toLocal = (e: MouseEvent) => {
      const r = wrap.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    const hitTest = (ec: Ecm, x: number, y: number) =>
      hitTestAxis(x, y, ec.getWidth(), ec.getHeight(), gridBandRef.current, axisLayoutRef.current);

    // Right-click: a Y axis opens the AxisMenu, the time
    // strip the TimeBandMenu, with All resolved from the loaded buffers now.
    // The grid interior opens the PlotMenu; chrome keeps the native menu.
    const onContextMenu = (e: MouseEvent) => {
      if (isPlotChrome(e.target)) return;
      const ec = liveEc();
      if (!ec) return;
      const { x, y } = toLocal(e);
      const target = wrap.ownerDocument.body;
      const hit = hitTest(ec, x, y);
      if (hit) {
        e.preventDefault();
        drawingRef.current.host.menu.set(null);
        setContextMenu({ kind: 'axis', axisId: hit.axisId, target, x: e.clientX, y: e.clientY });
        return;
      }
      if (!hitTestTimeBand(x, y, ec.getWidth(), ec.getHeight(), gridBandRef.current)) {
        const grid = gridRectOf(ec);
        const inside =
          x >= grid.left &&
          x <= grid.left + grid.width &&
          y >= grid.top &&
          y <= grid.top + grid.height;
        if (!inside) return;
        e.preventDefault();
        setContextMenu(null);
        drawingRef.current.host.openPlotMenu({
          localX: x,
          localY: y,
          clientX: e.clientX,
          clientY: e.clientY,
          target,
        });
        return;
      }
      e.preventDefault();
      drawingRef.current.host.menu.set(null);
      const { results, visibleTraceIds } = loadedRef.current;
      const all = allLoadedXAxis(xAxisRef.current, results, visibleTraceIds, Date.now());
      setContextMenu({ kind: 'time', all, target, x: e.clientX, y: e.clientY });
    };

    // Keys: a press focuses the root so its keymap is live —
    // with preventScroll, and only when it is not already focused, so a partly
    // visible grid cell or the embedding iframe never scrolls under the pointer.
    const onPointerDownFocus = () => {
      if (wrap.ownerDocument.activeElement === wrap) return;
      wrap.focus({ preventScroll: true });
    };
    // Shift-measure: a shift+press inside the
    // grid hands the pointer to the overlay. pointerdown precedes mousedown, so
    // the gesture layer then sees the claim and never pans.
    const onPointerDownMeasure = (e: PointerEvent) => {
      if (!e.shiftKey || e.button !== 0 || isPlotChrome(e.target)) return;
      const ec = liveEc();
      if (!ec) return;
      const grid = gridRectOf(ec);
      if (grid.width <= 0 || grid.height <= 0) return;
      const { x, y } = toLocal(e);
      if (x < grid.left || x > grid.left + grid.width) return;
      if (y < grid.top || y > grid.top + grid.height) return;
      drawingRef.current.host.beginModifierGesture(e);
    };
    // ONE native keydown listener on the root: it runs before the workbench's
    // React-delegated Escape handler. Navigation goes through the wheel
    // window's rAF flush; drawing commands go to the host's
    // handleDrawingKey and are claimed only when it reports them consumed.
    const onKeyDown = (e: KeyboardEvent) => {
      const cmd = resolveKey(e);
      if (cmd === null) return;
      if (!isNavigationCommand(cmd)) {
        const { host: h, canArm } = drawingRef.current;
        if (cmd.kind === 'arm' && !canArm) return;
        if (h.handleDrawingKey(cmd)) e.preventDefault();
        return;
      }
      e.preventDefault();
      const w = currentWindowMs();
      const span = w.to - w.from;
      if (cmd.kind === 'pan') {
        queueWindow(panTime(w, cmd.dir * PAN_STEP * span));
      } else {
        const factor = cmd.dir === 'in' ? 1 / ZOOM_STEP : ZOOM_STEP;
        queueWindow(zoomTimeAt(w, w.from + span / 2, factor));
      }
    };

    wrap.addEventListener('pointerdown', onPointerDownFocus);
    wrap.addEventListener('pointerdown', onPointerDownMeasure);
    wrap.addEventListener('keydown', onKeyDown);
    wrap.addEventListener('contextmenu', onContextMenu);

    return () => {
      wrap.removeEventListener('contextmenu', onContextMenu);
      wrap.removeEventListener('pointerdown', onPointerDownFocus);
      wrap.removeEventListener('pointerdown', onPointerDownMeasure);
      wrap.removeEventListener('keydown', onKeyDown);
      const win = wrap.ownerDocument.defaultView ?? window;
      if (windowFrameRef.current !== null) {
        win.cancelAnimationFrame(windowFrameRef.current);
        windowFrameRef.current = null;
      }
      pendingWindowRef.current = null;
    };
    // wrapRef is a stable ref object (useElementWidth's useRef): still mount-once.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the helpers read refs only
  }, [wrapRef]);

  const layout = plotLayout(visibleAxes);
  const { axisIndexMap, sideIndexMap, gridLeft, gridRight } = layout;

  // Install what the projection projects through (read on finished/resize).
  useEffect(() => {
    projectionStore.setSource(() => {
      const inst = chartRef.current?.getEchartsInstance() as unknown as
        | ProjectionInstance
        | undefined;
      if (!inst || inst.isDisposed?.()) return null;
      return buildProjection(inst, layout, visibleAxes);
    });
  });

  // The resize path: a new wrapper width moves the grid, so republish. Declared
  // after the source install above so the mount-time bump already sees the layout.
  useEffect(() => {
    projectionStore.bump();
  }, [width, projectionStore]);

  // Publish per-axis metadata for the pointer listeners. The listener claims the
  // whole out-of-grid margin per side and slots it by sideIndex, so we only need
  // each axis's side and its position within that side here.
  const axisHitZones: AxisHitZone[] = visibleAxes.map((axis) => ({
    axisId: axis.id,
    yAxisIndex: axisIndexMap.get(axis.id) ?? 0,
    logScale: axis.logScale,
    autoScale: axis.autoScale,
    side: axis.orientation,
    sideIndex: sideIndexMap.get(axis.id) ?? 0,
  }));

  // Sync the render-computed geometry + callback into refs the mount-once
  // pointer listeners read. Done in an effect (not during render) so ref writes
  // don't fight React's render rules; listeners only read them on later events.
  useEffect(() => {
    axisLayoutRef.current = axisHitZones;
    gestureAxesRef.current = {
      x: {
        id: TIME_AXIS_ID,
        dim: 'x',
        log: false,
        auto: false,
        fixed: onViewWindowChange === undefined,
      },
      sides: axisHitZones.map((z) => ({
        axis: { id: z.axisId, dim: 'y', log: z.logScale, auto: z.autoScale },
        side: z.side,
        slot: z.sideIndex,
      })),
      indexOf: new Map(axisHitZones.map((z) => [z.axisId, z.yAxisIndex])),
    };
    dragModeRef.current = tracePlotView(plot).drag;
    gridBandRef.current = { top: GRID_TOP, bottom: GRID_BOTTOM, left: gridLeft, right: gridRight };
    onUpdateAxisRef.current = onUpdateAxis;
    onApplyXAxisRef.current = onApplyXAxis;
    onViewWindowChangeRef.current = onViewWindowChange;
    xAxisRef.current = plot.xAxis;
    refreshIntervalRef.current = refreshIntervalMs(plot);
    loadedRef.current = {
      results: { archive: archiveResults, live: liveResults, formula: formulaResults },
      visibleTraceIds: plot.traces.filter((t) => t.visible).map((t) => t.id),
    };
    const prev = viewWindowRef.current;
    viewWindowRef.current = viewWindowNs;
    // The prop caught up (or someone else moved the window): drop the pending
    // window unless a frame still has to deliver a newer one.
    if (
      pendingWindowRef.current &&
      windowFrameRef.current === null &&
      (prev?.fromNs !== viewWindowNs?.fromNs || prev?.toNs !== viewWindowNs?.toNs)
    ) {
      pendingWindowRef.current = null;
    }
  });

  const built = buildPlotOption({
    plot,
    archiveResults,
    liveResults,
    formulaResults,
    theme,
    fontFamily: chartFont.ready ? chartFont.fontFamily : undefined,
    viewWindow: viewWindowNs,
    endMs,
    traceData,
    samples,
    readoutDock,
  });
  // No curve highlights from its (selectable) legend entry (`LegendMenu`).
  const option = { ...built, series: quietLegendHover(built.series as object[]) };
  const missingPvs = notArchivedPvs(plot, archiveResults, liveResults);
  const plotView = tracePlotView(plot);
  // The axis an open AxisMenu edits, read fresh so its checkmarks track the
  // plot; an axis hidden or removed meanwhile simply drops the menu.
  const contextMenuAxis =
    contextMenu?.kind === 'axis' ? visibleAxes.find((a) => a.id === contextMenu.axisId) : undefined;
  const closeContextMenu = () => setContextMenu(null);
  // The interior plot menu: the point menu with the host's add entries and
  // Reset view. The xAxis contract carries nothing but the configured range,
  // so re-applying it drops any wheel/pan window; each manual axis goes back
  // to auto-scale.
  const resetView = () => {
    onApplyXAxis?.({ ...plot.xAxis });
    for (const axis of plot.axes) {
      if (!axis.autoScale) onUpdateAxis?.(axis.id, { autoScale: true });
    }
  };
  useDrawingPlotMenu(menuHost, {
    point: (p) =>
      tracePointMenu(p, {
        plot,
        window: viewWindowNs,
        colorMode,
        drawingsHidden: annotationsHidden === true,
        resetView,
      }),
  });
  // A right-click on a legend entry: that curve's menu.
  const menus = useContextMenu();
  const onLegend = (name: string, e: MouseEvent): boolean => {
    const trace = plot.traces.find((t) => traceLabel(t, plot.traces) === name);
    if (menus === null || trace === undefined) return false;
    return menus.openSignals([trace.id], {
      x: e.clientX,
      y: e.clientY,
      target: wrapRef.current?.ownerDocument.body,
    });
  };
  const legendMenu = useLatest(onLegend);
  // A left-click on a legend entry toggles nothing (`LegendMenu`).
  const [legend] = useState(() => new LegendMenu((name, e) => legendMenu.current(name, e)));
  const chartEvents = legend.events;
  return (
    // data-plot-id lets capturePlotPng find this chart's ECharts instance in
    // the document (print snapshots). Detached plots live in another window's
    // document, so they're naturally out of scope. data-fullscreen marks the
    // popped-out copy so capture targets it over the in-window one, which
    // shares the same data-plot-id.
    // The flex column puts the status line BELOW the wrapper: the wrapper
    // keeps the remaining height and still exactly overlays the canvas.
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', width: '100%' }}>
      <div
        ref={wrapCallbackRef}
        data-plot-id={plot.id}
        data-fullscreen={fullscreen ? 'true' : undefined}
        // Focusable so the plot keymap receives keys; no ring.
        tabIndex={0}
        style={{
          position: 'relative',
          flex: '1 1 0',
          minHeight: 0,
          width: '100%',
          outline: 'none',
        }}
      >
        {/* data-chart-host: capturePlotPng resolves the ECharts host as its
            child, wherever chrome mounts in the wrapper. */}
        <div data-chart-host="" style={{ height: '100%', width: '100%' }}>
          <ReactECharts
            ref={chartRef}
            option={option}
            replaceMerge={['series', 'yAxis']}
            onEvents={{ ...chartEvents, finished: handleFinished }}
            style={{ height: '100%', width: '100%' }}
            opts={{ renderer: 'canvas' }}
          />
        </div>
        {missingPvs.length > 0 && (
          <div
            data-testid="archive-empty-notice"
            style={{
              position: 'absolute',
              inset: 0,
              pointerEvents: 'none',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              color: theme.axisLabel,
              fontSize: 13,
            }}
          >
            {missingPvs.map(({ pv, notice }) => (
              <div key={pv}>{`${notice}: ${pv}`}</div>
            ))}
          </div>
        )}
        {/* Plot chrome mounts after the chart; capture finds
            the chart through [data-chart-host], not by position. */}
        <DrawingLayers host={host} />
        <AxisBadges
          projectionStore={projectionStore}
          axes={visibleAxes}
          layout={{ sideIndexMap, gridRight, axisOffset: AXIS_OFFSET }}
          theme={theme}
          onUpdateAxis={onUpdateAxis}
        />
        {/* The rail mounts only with a writer; without a prefs writer its
            tools stay disabled and only hide-all is live. */}
        {onAnnotationPrefs ? (
          <DrawingRailFor
            host={host}
            focusRoot={focusPlotRoot}
            view={plotView}
            onView={onPlotView}
          />
        ) : (
          (onAnnotationsHidden || onPlotView) && (
            <DrawingRail
              catalog={BUILTIN_CATALOG}
              prefs={annotationPrefs ?? DEFAULT_TOOL_PREFS}
              hidden={annotationsHidden === true}
              onHiddenChange={onAnnotationsHidden}
              view={plotView}
              onView={onPlotView}
              focusRoot={focusPlotRoot}
            />
          )
        )}
        {contextMenuAxis && contextMenu?.kind === 'axis' && (
          <AxisMenu
            axis={contextMenuAxis}
            target={contextMenu.target}
            x={contextMenu.x}
            y={contextMenu.y}
            onUpdateAxis={onUpdateAxis}
            onClose={closeContextMenu}
          />
        )}
        {contextMenu?.kind === 'time' && (
          <TimeBandMenu
            xAxis={plot.xAxis}
            all={contextMenu.all}
            target={contextMenu.target}
            x={contextMenu.x}
            y={contextMenu.y}
            onApplyXAxis={onApplyXAxis}
            onClose={closeContextMenu}
          />
        )}
      </div>
      {plot.showStatusLine !== false && <DrawingStatusLine host={statusHost} />}
    </div>
  );
}

/**
 * A plot with its statistics panel docked underneath: the
 * chart fills the stage, the panel (when the plot's Show statistics is on)
 * takes the bottom. The frame is the plot's curves inside its view window —
 * the caller's resolved window, else the panned window, else the relative
 * range against the second-quantised clock — and the strips tick on the
 * newest sample. The window's bounds must be stable between frames: one
 * resolved from the clock on every render would make a new frame each time
 * and the statistics hook's render-phase update would chase it.
 */
export function PlotWithStatistics(props: SinglePlotProps) {
  const {
    plot,
    archiveResults,
    liveResults,
    formulaResults,
    viewWindowNs,
    statsWindowNs,
    ...rest
  } = props;
  const theme = useChartTheme();
  const metrics = useMemo(() => plotMetrics(plot), [plot]);
  const window =
    statsWindowNs ??
    viewWindowNs ??
    // eslint-disable-next-line react-hooks/purity -- the second-quantised clock is the stable fallback described above
    resolveTimeWindow(plot.xAxis, Math.floor(Date.now() / 1000) * 1000).window;
  const frame = useMemo(
    () =>
      plot.showStats === true
        ? traceStatFrame(
            plot,
            { archive: archiveResults, live: liveResults, formula: formulaResults },
            window
          )
        : null,
    // The window's identity may change per render; its bounds are what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [plot, archiveResults, liveResults, formulaResults, window.fromNs, window.toNs]
  );
  const stats = useStatistics(TRACE_METRICS, frame, metrics, frameClockMs(frame));
  const unitOf = useCallback(
    (rowId: string, unit: string) => traceUnitOf(plot, rowId, unit),
    [plot]
  );
  return (
    <div className="stats-canvas" data-testid="plot-with-statistics">
      <div className="stats-canvas__stage">
        <div className="stats-canvas__fill">
          <SinglePlot
            {...rest}
            plot={plot}
            archiveResults={archiveResults}
            liveResults={liveResults}
            formulaResults={formulaResults}
            viewWindowNs={viewWindowNs}
          />
        </div>
      </div>
      <StatisticsPanel
        show={plot.showStats === true}
        catalog={TRACE_METRICS}
        metrics={metrics}
        table={stats.table}
        strips={stats.strips}
        unitOf={unitOf}
        rowHeading="Curve"
        chartTheme={theme}
        distribution={plot.showDist === true}
        frame={frame}
      />
    </div>
  );
}

const EMPTY_RESULTS: Map<string, ArchiveSeriesResult> = new Map();
const EMPTY_LIVE_RESULTS: Map<string, LiveSeriesResult> = new Map();
const EMPTY_FORMULA_RESULTS: Map<string, FormulaSeriesResult> = new Map();

export function PlotArea({
  plots,
  activePlotId,
  viewMode,
  archiveResultsByPlot,
  liveResultsByPlot,
  formulaResultsByPlot,
  onSetActivePlot,
  onAddPlot,
  onRemovePlot,
  onSetViewMode,
  onPopOutPlot,
  detachedPlotIds,
  onDetachPlot,
  onReattachPlot,
  onViewWindowChange,
  displayWindowByPlotId,
  axisEndFor,
  followingFor,
  onAxisRangesChange,
  onUpdateAxis,
  onApplyXAxis,
  onChartInstance,
  statsWindowByPlotId,
  lastRelativeSpanFor,
  hostBar = false,
  // Every AnnotationChannel field rides through untouched: slicing them out by
  // name once dropped a newly added one (onCommitAnnotations) from the tab and
  // grid mounts while the fullscreen/detached mounts still had it.
  ...annotationChannel
}: PlotAreaProps) {
  const activePlot = plots.find((p) => p.id === activePlotId) ?? plots[0];
  const isDetached = (id: string) => detachedPlotIds.includes(id);
  const channel: AnnotationChannel = annotationChannel;

  // The range chips for one plot: the tab bar's for the
  // active plot, each grid cell's for its own.
  const rangeControlsFor = (plot: Plot) => (
    <RangeControls
      xAxis={plot.xAxis}
      viewWindowNs={displayWindowByPlotId.get(plot.id)}
      results={{
        archive: archiveResultsByPlot.get(plot.id),
        live: liveResultsByPlot.get(plot.id),
        formula: formulaResultsByPlot.get(plot.id),
      }}
      visibleTraceIds={plot.traces.filter((t) => t.visible).map((t) => t.id)}
      getLastRelativeSpan={lastRelativeSpanFor ? () => lastRelativeSpanFor(plot.id) : undefined}
      onApplyXAxis={onApplyXAxis ? (x) => onApplyXAxis(plot.id, x) : undefined}
    />
  );

  // Near-square tiling: columns = ceil(sqrt(n)), rows = ceil(n / columns). This
  // keeps every cell a real, evenly-sized tile so no plot collapses to a sliver
  // (the old fixed 2-col/1-row logic left a 3rd plot with no row to fill).
  const gridColCount = Math.ceil(Math.sqrt(plots.length));
  const gridRowCount = Math.ceil(plots.length / gridColCount);

  return (
    <div className="plot-area">
      {/* Tab bar */}
      <div className="plot-tab-bar">
        <div className="plot-tab-bar__tabs">
          {viewMode === 'tabs' &&
            plots.map((plot) => (
              <div
                key={plot.id}
                className={`plot-tab ${plot.id === activePlotId ? 'plot-tab--active' : 'plot-tab--inactive'}${isDetached(plot.id) ? ' plot-tab--detached' : ''}`}
                onClick={() => onSetActivePlot(plot.id)}
              >
                <span>{plot.title}</span>
                <button
                  className="plot-tab__action-btn"
                  title="Fullscreen"
                  onClick={(e) => {
                    e.stopPropagation();
                    onPopOutPlot(plot.id);
                  }}
                >
                  <Maximize size={12} />
                </button>
                <button
                  className="plot-tab__action-btn"
                  title={isDetached(plot.id) ? 'Reattach' : 'Detach to window'}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (isDetached(plot.id)) onReattachPlot(plot.id);
                    else onDetachPlot(plot.id);
                  }}
                >
                  {isDetached(plot.id) ? <Login size={12} /> : <Launch size={12} />}
                </button>
                {plots.length > 1 && (
                  <button
                    className="plot-tab__action-btn plot-tab__action-btn--close"
                    title="Close plot"
                    onClick={(e) => {
                      e.stopPropagation();
                      onRemovePlot(plot.id);
                    }}
                  >
                    <Close size={12} />
                  </button>
                )}
              </div>
            ))}
          {viewMode === 'grid' && (
            <span style={{ fontSize: 12, color: 'var(--cds-text-secondary)', padding: '0 8px' }}>
              Grid View ({plots.length} plots)
            </span>
          )}
        </div>

        <div className="plot-tab-bar__controls">
          {viewMode === 'tabs' && (
            <div data-range-site="tab" style={{ marginRight: 6 }}>
              {rangeControlsFor(activePlot)}
            </div>
          )}
          {hostBar ? null : (
            <>
              <button
                className={`canopy-btn view-mode-btn${viewMode === 'tabs' ? ' view-mode-btn--active' : ''}`}
                title="Tab view"
                onClick={() => onSetViewMode('tabs')}
              >
                <ColumnDependency size={16} />
              </button>
              <button
                className={`canopy-btn view-mode-btn${viewMode === 'grid' ? ' view-mode-btn--active' : ''}`}
                title="Grid view"
                onClick={() => onSetViewMode('grid')}
              >
                <Grid size={16} />
              </button>
            </>
          )}
          <button
            className="canopy-btn view-mode-btn"
            title="Add plot"
            onClick={onAddPlot}
            style={{ marginLeft: 4 }}
          >
            <Add size={16} />
          </button>
        </div>
      </div>

      {/* Plot content */}
      <div className="plot-content">
        {viewMode === 'tabs' ? (
          isDetached(activePlot.id) ? (
            <DetachedPlaceholder
              title={activePlot.title}
              onReattach={() => onReattachPlot(activePlot.id)}
            />
          ) : (
            <PlotWithStatistics
              key={activePlot.id}
              plot={activePlot}
              archiveResults={archiveResultsByPlot.get(activePlot.id) ?? EMPTY_RESULTS}
              liveResults={liveResultsByPlot.get(activePlot.id) ?? EMPTY_LIVE_RESULTS}
              formulaResults={formulaResultsByPlot.get(activePlot.id) ?? EMPTY_FORMULA_RESULTS}
              onViewWindowChange={
                onViewWindowChange
                  ? (w, opts) => onViewWindowChange(activePlot.id, w, opts)
                  : undefined
              }
              viewWindowNs={displayWindowByPlotId.get(activePlot.id)}
              endMs={axisEndFor?.(activePlot.id)}
              following={followingFor?.(activePlot.id)}
              statsWindowNs={statsWindowByPlotId?.get(activePlot.id)}
              onAxisRangesChange={
                onAxisRangesChange ? (r) => onAxisRangesChange(activePlot.id, r) : undefined
              }
              onUpdateAxis={
                onUpdateAxis ? (id, u) => onUpdateAxis(activePlot.id, id, u) : undefined
              }
              onApplyXAxis={onApplyXAxis ? (x) => onApplyXAxis(activePlot.id, x) : undefined}
              onChartInstance={
                onChartInstance
                  ? (inst, active) => onChartInstance(activePlot.id, inst, active)
                  : undefined
              }
              {...annotationMountProps(activePlot.id, channel)}
            />
          )
        ) : (
          <div
            className="plot-grid"
            style={{
              gridTemplateColumns: `repeat(${gridColCount}, 1fr)`,
              gridTemplateRows: `repeat(${gridRowCount}, 1fr)`,
            }}
          >
            {plots.map((plot) => (
              // A pointer-down anywhere in the cell activates its plot.
              // The event is never stopped, so axis drag/zoom and the cell
              // buttons below still receive it.
              <div
                key={plot.id}
                className={`plot-grid__cell${plot.id === activePlot.id ? ' plot-grid__cell--active' : ''}`}
                onPointerDownCapture={() => {
                  if (plot.id !== activePlotId) onSetActivePlot(plot.id);
                }}
              >
                <button
                  className="plot-grid__cell-btn plot-grid__cell-btn--maximize"
                  title="Fullscreen"
                  onClick={() => onPopOutPlot(plot.id)}
                >
                  <Maximize size={14} />
                </button>
                <button
                  className="plot-grid__cell-btn plot-grid__cell-btn--detach"
                  title={isDetached(plot.id) ? 'Reattach' : 'Detach to window'}
                  onClick={() =>
                    isDetached(plot.id) ? onReattachPlot(plot.id) : onDetachPlot(plot.id)
                  }
                >
                  {isDetached(plot.id) ? <Login size={14} /> : <Launch size={14} />}
                </button>
                {plots.length > 1 && (
                  <button
                    className="plot-grid__cell-btn plot-grid__cell-btn--close"
                    title="Remove plot"
                    onClick={() => onRemovePlot(plot.id)}
                  >
                    <Close size={14} />
                  </button>
                )}
                {/* The cell's own range chips, acting on this plot. */}
                <div
                  data-range-site="grid"
                  style={{
                    position: 'absolute',
                    top: 8,
                    right: plots.length > 1 ? 40 : 8,
                    zIndex: 10,
                  }}
                >
                  {rangeControlsFor(plot)}
                </div>
                {isDetached(plot.id) ? (
                  <DetachedPlaceholder
                    title={plot.title}
                    onReattach={() => onReattachPlot(plot.id)}
                  />
                ) : (
                  <PlotWithStatistics
                    plot={plot}
                    archiveResults={archiveResultsByPlot.get(plot.id) ?? EMPTY_RESULTS}
                    liveResults={liveResultsByPlot.get(plot.id) ?? EMPTY_LIVE_RESULTS}
                    formulaResults={formulaResultsByPlot.get(plot.id) ?? EMPTY_FORMULA_RESULTS}
                    onViewWindowChange={
                      onViewWindowChange
                        ? (w, opts) => onViewWindowChange(plot.id, w, opts)
                        : undefined
                    }
                    viewWindowNs={displayWindowByPlotId.get(plot.id)}
                    endMs={axisEndFor?.(plot.id)}
                    following={followingFor?.(plot.id)}
                    statsWindowNs={statsWindowByPlotId?.get(plot.id)}
                    onAxisRangesChange={
                      onAxisRangesChange ? (r) => onAxisRangesChange(plot.id, r) : undefined
                    }
                    onUpdateAxis={
                      onUpdateAxis ? (id, u) => onUpdateAxis(plot.id, id, u) : undefined
                    }
                    onApplyXAxis={onApplyXAxis ? (x) => onApplyXAxis(plot.id, x) : undefined}
                    onChartInstance={
                      onChartInstance
                        ? (inst, active) => onChartInstance(plot.id, inst, active)
                        : undefined
                    }
                    {...annotationMountProps(plot.id, channel)}
                  />
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
