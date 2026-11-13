import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ECharts,
  EChartsOption,
  LegendComponentOption,
  TooltipComponentOption,
} from 'echarts';
import {
  CanopyChart,
  baseChartOption,
  chartAxisStyle,
  formatAxisTick,
  formatValue,
  useChartTheme,
} from '@slaclab/canopy-charts';
import { effectiveBackground } from '../plotBackground';
import { registerPlotChart } from '../capturePlot';
import { Add, Close, ColumnDependency, Grid, Launch, Login, Maximize } from '@carbon/icons-react';
import type { Axis, Plot, PVTrace } from '../types';
import type { ArchiveSeriesResult } from '../hooks/useArchiveSeries';
import type { LiveSeriesResult } from '../hooks/useLiveSeries';
import type { FormulaSeriesResult } from '../hooks/useFormulaSeries';
import type { TimeWindowNs } from '../api/time';
import { msToNs, nsToMs, resolveTimeWindow } from '../api/time';
import { echartsLineType, echartsSymbol } from '../curveStyle';
import { isFollowing } from '../hooks/useAutoScrollTimers';
import { useFollowNow } from '../hooks/useFollowNow';
import { traceLabel } from '../traceLabel';
import { ErrorBoundary } from '@slaclab/canopy-shell';
import type { PngSource } from '../io/exportPlotImage';
import {
  gappedLineData,
  invalidMarkerSeries,
  invalidStretches,
  isInvalid,
  xAxisLabelMargin,
  type PlotSample,
} from './invalidGaps';
import {
  AXIS_OFFSET,
  hitTestAxis,
  panExtent,
  zoomExtent,
  type AxisHitZone,
  type GridBand,
} from './axisHitTest';

// Signature of the user-chosen range. Bumps when picking a new time range so
// dataZoom resets to full extent — otherwise the previous zoom stays clipped
// over the new range.
function rangeKeyFor(plot: Plot): string {
  return plot.xAxis.timeRange;
}

// The slice of ECharts' chart model that axis reads use.
type AxisModel = { axis?: { scale?: { getExtent: () => [number, number] } } };
type ChartModel = { getComponent: (mainType: string, idx: number) => AxisModel | undefined };

// The chart's model, or null while it has none: echarts-for-react's throwaway
// measuring instance can fire events before its model exists, and dispose()
// drops it. ECharts leaves getModel() out of its typings, so this is the one
// place that reaches past them.
function chartModel(chart: ECharts): ChartModel | null {
  return (chart as unknown as { getModel: () => ChartModel | null | undefined }).getModel() ?? null;
}

// An axis's current computed [min, max], or null when the chart has no model
// yet or no such axis.
function getAxisExtent(
  chart: ECharts,
  axisType: 'xAxis' | 'yAxis',
  idx: number
): [number, number] | null {
  const ext = chartModel(chart)?.getComponent(axisType, idx)?.axis?.scale?.getExtent();
  return ext ? [ext[0], ext[1]] : null;
}

interface PlotAreaProps {
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
  onViewWindowChange?: (plotId: string, window: TimeWindowNs) => void;
  /** A following plot was panned/zoomed; freeze it where its axis ends. */
  onFollowStop?: (plotId: string) => void;
  /** Saved per-plot view window; seeds dataZoom across remounts (e.g. popout). */
  viewWindowByPlot: Map<string, TimeWindowNs>;
  /** The instant each plot's time axis ends at; see axisEndMs. */
  axisEndFor: (plotId: string) => number;
  onAxisRangesChange?: (plotId: string, ranges: Map<string, [number, number]>) => void;
  /** Commits a per-axis min/max (or autoScale flip) from a direct axis pan/zoom. */
  onUpdateAxis?: (plotId: string, axisId: string, updates: Partial<Axis>) => void;
  /** Publishes each plot's ECharts instance for PNG capture (active=false on unmount). */
  onChartInstance?: (plotId: string, instance: PngSource, active: boolean) => void;
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
  /**
   * The instant the plot's time range ends at, from the app (see axisEndMs):
   * the plot's autoscroll clock, or the newest live sample past it while
   * following. The chart never reads the wall clock, so a re-render can't move
   * the axis.
   */
  endMs: number;
  /** True while the plot tracks "now" (see isFollowing). */
  following?: boolean;
  /**
   * Called on the first genuine pan/zoom while following, so the app can
   * freeze the plot at `endMs` right away instead of after the view-window
   * debounce.
   */
  onFollowStop?: () => void;
  archiveResults: Map<string, ArchiveSeriesResult>;
  liveResults: Map<string, LiveSeriesResult>;
  formulaResults: Map<string, FormulaSeriesResult>;
  onViewWindowChange?: (window: TimeWindowNs) => void;
  /**
   * Last known visible window from a prior mount of this plot. Seeds the inside
   * dataZoom on first render so popping a plot out (or reattaching) preserves
   * whatever sub-range the user had wheel-zoomed into. Only consulted on mount.
   */
  initialViewWindowNs?: TimeWindowNs;
  onAxisRangesChange?: (ranges: Map<string, [number, number]>) => void;
  /**
   * Commits a per-axis min/max (or autoScale flip) when the user drags or wheels
   * directly on a Y-axis band. See the per-axis pointer listeners in SinglePlot.
   */
  onUpdateAxis?: (axisId: string, updates: Partial<Axis>) => void;
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
}

function formatCrosshairTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

function safeTooltipColor(color: string): string {
  return /^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(color) ? color : '#000000';
}

// Human-readable signed offset between the cursor and the sample we're showing.
// "0s" when within ±0.5s; otherwise "−12s", "+3m", "+1.4h" etc.
function formatTimeOffset(deltaMs: number): string {
  const abs = Math.abs(deltaMs);
  if (abs < 500) return '0s';
  const sign = deltaMs < 0 ? '−' : '+';
  if (abs < 60_000) return `${sign}${Math.round(abs / 1000)}s`;
  if (abs < 3_600_000) return `${sign}${Math.round(abs / 60_000)}m`;
  if (abs < 86_400_000) return `${sign}${(abs / 3_600_000).toFixed(1)}h`;
  return `${sign}${(abs / 86_400_000).toFixed(1)}d`;
}

// Anchor points of a frozen plot's extension line. A two-point line would vanish
// under a zoom that sits inside it: weakFilter keeps a point only if it's in the
// window, so the line needs anchors this dense to survive any zoom depth.
const EXTENSION_ANCHORS = 2048;

// Line series data as a flat [t0, v0, t1, v1, ...] typed array. ECharts treats
// typed-array data as primitive, so setOption neither deep-clones it nor runs
// each point through its option preprocessors. With plain [t, v] pairs that was
// most of the cost of an update, and a following plot updates on every scroll
// step as well as on every live batch.
//
// Typed data is flat, so it can't say how many values make a point: every
// series given xyData (or other flat data) must declare XY_DIMENSIONS. Without
// it ECharts' development build asserts ("dimensions must be given if data is
// TypedArray."), which the production build strips. The x and y dimensions map
// to the axes in order, time then value; [t, v] pairs read the same way.
const XY_DIMENSIONS = ['x', 'y'];

function xyData(points: readonly PlotSample[]): Float64Array {
  const out = new Float64Array(points.length * 2);
  for (let i = 0; i < points.length; i++) {
    out[2 * i] = points[i].time;
    out[2 * i + 1] = points[i].value;
  }
  return out;
}

function traceSamples(
  trace: PVTrace,
  archive: ArchiveSeriesResult | undefined,
  live: LiveSeriesResult | undefined,
  formula: FormulaSeriesResult | undefined
): readonly PlotSample[] {
  // Formula curves are evaluated server-side (the Formula Engine); their points are the only
  // source — no archive/live merge, no mock seed.
  if (trace.kind === 'formula') {
    return formula ? formula.points.map(([time, value]) => ({ time, value })) : [];
  }
  // Mirror old Trace's independent toggles. Archive feeds the past, live
  // feeds the present; with both on, archive runs up to the last archive
  // sample and live takes over afterwards (de-duped at the seam). Both keep
  // their per-sample severity.
  const archivePts = trace.useArchive && archive && archive.mean.length > 0 ? archive.mean : null;
  const livePts = trace.useLive && live && live.points.length > 0 ? live.points : null;

  if (archivePts && livePts) {
    const seamMs = archivePts[archivePts.length - 1].time;
    let head = 0;
    while (head < livePts.length && livePts[head].time <= seamMs) head++;
    return head === 0 ? archivePts.concat(livePts) : archivePts.concat(livePts.slice(head));
  }
  if (archivePts) return archivePts;
  if (livePts) return livePts;
  // Live-capable trace that has no live yet (pre-connect or no samples) and
  // no archive: render nothing rather than the mock seed. Mock data stays
  // for traces with neither toggle on, since there's no other source to show.
  if (trace.useLive || trace.useArchive) return [];
  return trace.data;
}

// Binary search for the sample whose `time` is nearest to `tMs`. Series are
// always sorted ascending by time (archive buffer + mock generator both honor
// this), so we don't sort here.
function nearestSample(data: readonly PlotSample[], tMs: number): PlotSample | undefined {
  if (data.length === 0) return undefined;
  let lo = 0;
  let hi = data.length - 1;
  if (tMs <= data[lo].time) return data[lo];
  if (tMs >= data[hi].time) return data[hi];
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (data[mid].time <= tMs) lo = mid;
    else hi = mid;
  }
  const pickHi = data[hi].time - tMs < tMs - data[lo].time;
  return pickHi ? data[hi] : data[lo];
}

export function SinglePlot({
  plot,
  endMs,
  following = false,
  onFollowStop,
  archiveResults,
  liveResults,
  formulaResults,
  onViewWindowChange,
  initialViewWindowNs,
  onAxisRangesChange,
  onUpdateAxis,
  fullscreen,
  onChartInstance,
}: SinglePlotProps) {
  // Carbon g10/g100 chart colors for the current canopy-shell color mode.
  const theme = useChartTheme();

  // Everything derived from the samples and the plot's traces and axes. It's
  // memoized apart from the display clock: while a plot scrolls (useFollowNow)
  // it re-renders on animation frames with these inputs unchanged, so the
  // remapped samples and the band and line series stay the same objects, and
  // the option compare short-circuits on them. Only the x-axis extent, the
  // extension lines and the INVALID markers depend on the clock.
  const {
    visibleAxes,
    visibleTraces,
    labels,
    axisIndexMap,
    orderedTraces,
    traceData,
    baseSeries,
    tracesWithInvalid,
  } = useMemo(() => {
    const visibleAxes = plot.axes.filter((a) => a.visible);
    const visibleTraces = plot.traces.filter((t) => t.visible);
    const labels = new Map(plot.traces.map((t) => [t.id, traceLabel(t, plot.traces)]));

    // ECharts links series to axes by index, so we track index per axis id.
    const axisIndexMap = new Map<string, number>();
    visibleAxes.forEach((axis, idx) => axisIndexMap.set(axis.id, idx));

    // Per-trace samples; series rendering and the tooltip formatter both
    // read from this map. Sorted ascending by time.
    const traceData = new Map<string, readonly PlotSample[]>();
    for (const trace of visibleTraces) {
      traceData.set(
        trace.id,
        traceSamples(
          trace,
          archiveResults.get(trace.id),
          liveResults.get(trace.id),
          formulaResults.get(trace.id)
        )
      );
    }

    // Order traces by axis (in panel order) then by their position within
    // each axis. Earlier axis / earlier trace draws on top — assign higher
    // `z` values to those, and pin the order with `emphasis.disabled` so
    // hover doesn't shuffle the depth.
    const orderedTraces: { trace: PVTrace; yAxisIndex: number; baseZ: number }[] = [];
    for (const axis of visibleAxes) {
      for (const trace of visibleTraces) {
        if (trace.axisId === axis.id) {
          orderedTraces.push({ trace, yAxisIndex: axisIndexMap.get(axis.id) ?? 0, baseZ: 0 });
        }
      }
    }
    orderedTraces.forEach((t, i) => (t.baseZ = (orderedTraces.length - i) * 10));

    // Each trace's min/max band and main line.
    const baseSeries = new Map<string, Record<string, unknown>[]>();
    // Drawn traces with an INVALID sample, the only ones whose stretches the
    // marker lanes below need to scan for on each frame.
    const tracesWithInvalid = new Set<string>();
    for (const { trace, yAxisIndex, baseZ } of orderedTraces) {
      const archive = archiveResults.get(trace.id);
      const points = traceData.get(trace.id) ?? [];
      const step = trace.lineType === 'step';
      const series: Record<string, unknown>[] = [];
      if (points.some(isInvalid)) tracesWithInvalid.add(trace.id);

      // Min/max band, drawn as two stacked area series so ECharts fills between them.
      // Keep the previous band rendered while a fetch is in flight (status may
      // be 'loading') so the band doesn't disappear during panning/zooming.
      // Both break at the same INVALID points as the line (and hold like it).
      if (
        trace.useArchive &&
        trace.showArchiveBand !== false &&
        archive &&
        archive.mode === 'binned' &&
        archive.band.length > 0
      ) {
        const stackId = `band-${trace.id}`;
        series.push({
          id: `${trace.id}-band-min`,
          name: `${labels.get(trace.id)} (min)`,
          type: 'line',
          yAxisIndex,
          data: gappedLineData(archive.band, (p) => p.min, step),
          stack: stackId,
          lineStyle: { opacity: 0 },
          areaStyle: { opacity: 0 },
          symbol: 'none',
          showInLegend: false,
          tooltip: { show: false },
          silent: true,
          animation: false,
          z: baseZ,
          emphasis: { disabled: true },
        });
        series.push({
          id: `${trace.id}-band-max`,
          name: `${labels.get(trace.id)} (max)`,
          type: 'line',
          yAxisIndex,
          data: gappedLineData(archive.band, (p) => p.max - p.min, step),
          stack: stackId,
          lineStyle: { opacity: 0 },
          areaStyle: { color: trace.color, opacity: 0.18 },
          symbol: 'none',
          showInLegend: false,
          tooltip: { show: false },
          silent: true,
          animation: false,
          z: baseZ,
          emphasis: { disabled: true },
        });
      }

      series.push({
        id: trace.id,
        name: labels.get(trace.id),
        type: 'line',
        yAxisIndex,
        // Typed unless it has to break at an INVALID sample: the nulls and
        // step-line hold points need plain point data. Dimensions either way,
        // since the series merges by id when it switches between the two.
        data: tracesWithInvalid.has(trace.id)
          ? gappedLineData(points, (p) => p.value, step)
          : xyData(points),
        dimensions: XY_DIMENSIONS,
        step: step ? 'end' : false,
        lineStyle: {
          color: trace.color,
          width: trace.lineWidth,
          type: echartsLineType(trace.lineStyle),
          opacity: trace.lineStyle === 'none' ? 0 : 1,
        },
        itemStyle: { color: trace.color },
        symbol: trace.showSymbol ? echartsSymbol(trace.symbolShape) : 'none',
        symbolSize: trace.symbolSize,
        showSymbol: trace.showSymbol,
        sampling: 'lttb',
        animation: false,
        z: baseZ + 1,
        emphasis: { disabled: true },
      });
      baseSeries.set(trace.id, series);
    }

    return {
      visibleAxes,
      visibleTraces,
      labels,
      axisIndexMap,
      orderedTraces,
      traceData,
      baseSeries,
      tracesWithInvalid,
    };
  }, [plot.traces, plot.axes, archiveResults, liveResults, formulaResults]);

  // The chart's ECharts instance. CanopyChart hands over each new instance
  // through onReady (after the first render and after any re-init) but never
  // reports a disposal, so reads go through liveChart(), which treats a
  // disposed instance as no instance.
  const chartRef = useRef<ECharts | null>(null);
  const handleReady = useCallback((chart: ECharts) => {
    chartRef.current = chart;
  }, []);
  const liveChart = useCallback((): ECharts | null => {
    const chart = chartRef.current;
    return chart && !chart.isDisposed() ? chart : null;
  }, []);
  // Our own wrapper around the chart. It carries data-plot-id for capture, and
  // the per-axis pointer listeners attach here because it outlives any ECharts
  // instance created under it.
  const wrapRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Set while we programmatically reset the zoom on a range re-select, so the
  // resulting datazoom event isn't mistaken for a manual pan (which would
  // disable autoscroll right after the range re-select re-enabled it).
  const programmaticZoomRef = useRef(false);

  // Per-axis screen geometry + metadata, recomputed each render and read by the
  // (mount-once) pointer listeners so hit-testing always reflects the current
  // axis layout without re-subscribing. See the option builder for the matching
  // grid/offset math.
  const axisLayoutRef = useRef<AxisHitZone[]>([]);
  const gridBandRef = useRef<GridBand>({ top: 40, bottom: 60, left: 70, right: 20 });
  // Latest onUpdateAxis, so the mount-once listeners always call the current one.
  const onUpdateAxisRef = useRef(onUpdateAxis);

  // Where the time axis is drawn to. `endMs` comes from the app (see
  // axisEndMs): the plot's clock, or its newest live sample while following. A
  // following plot also scrolls smoothly on animation frames between clock
  // ticks (useFollowNow), so slow PVs don't wait for the next tick either.
  const spanWindow = resolveTimeWindow(plot.xAxis, endMs).window;
  const getWindow = useCallback(() => wrapRef.current?.ownerDocument.defaultView ?? null, []);
  const getWidthPx = useCallback(
    () =>
      (wrapRef.current?.clientWidth ?? 0) - gridBandRef.current.left - gridBandRef.current.right,
    []
  );
  const shownEndMs = useFollowNow({
    following,
    anchorMs: endMs,
    spanMs: nsToMs(spanWindow.toNs - spanWindow.fromNs),
    getWindow,
    getWidthPx,
  });
  // In-flight axis drag; null when not dragging. min/max/pxMin/pxMax are a frozen
  // snapshot of the extent and its pixel mapping captured at mousedown.
  const dragRef = useRef<{
    axisId: string;
    yAxisIndex: number;
    logScale: boolean;
    startY: number;
    min: number;
    max: number;
    pxMin: number;
    pxMax: number;
  } | null>(null);

  // Publish a stable PngSource proxy for PNG capture: up to the app (e-log
  // attachments), and against our wrapper for capturePlotPng (print and PNG
  // export). Clear both on unmount so a captured-but-gone plot (closed tab,
  // reattached window) isn't stale. The proxy reads the current ECharts
  // instance on each call instead of capturing one at mount: the chart isn't
  // ready at mount, and a re-created chart leaves a disposed instance behind
  // that yields no image.
  useEffect(() => {
    const source: PngSource = {
      getDataURL(opts) {
        const inst = liveChart();
        if (!inst) return '';
        return inst.getDataURL(opts) ?? '';
      },
    };
    onChartInstance?.(source, true);
    const wrap = wrapRef.current;
    const unregister = wrap ? registerPlotChart(wrap, source) : undefined;
    return () => {
      onChartInstance?.(source, false);
      unregister?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- register once per mount; the callback is stable
  }, []);

  // Reset the inside-zoom to full extent when the user picks a new range, or
  // when the plot resumes following "now" (Autoscroll turned back on after a
  // pan). This replaces the React-key remount we used to do — the chart
  // instance survives, so dataZoom state on subsequent panning is the only
  // thing affected. Nothing resets on the first mount (there's no zoom state
  // yet, and the chart instance may not be fully attached to the DOM) or when
  // the plot stops following, which would undo the user's pan.
  const rangeKey = rangeKeyFor(plot);
  const zoomTriggerRef = useRef({ rangeKey, following });
  useEffect(() => {
    const prev = zoomTriggerRef.current;
    zoomTriggerRef.current = { rangeKey, following };
    const resumed = following && !prev.following;
    if (prev.rangeKey === rangeKey && !resumed) return;
    // The reset discards the user's pan, so drop its view window if it's still
    // debounced. Landing after the reset, it would save the old window and
    // switch Autoscroll back off.
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const inst = liveChart();
    if (!inst) return;
    programmaticZoomRef.current = true;
    inst.dispatchAction({ type: 'dataZoom', start: 0, end: 100 });
    // If the chart was already at 0-100 the action is a no-op and no `datazoom`
    // event fires, so `handleDataZoom` never clears the flag. Without this the
    // flag stays `true` and swallows the user's next genuine pan. Clear it on a
    // later tick as a fallback; a real event beats the timeout and clears it
    // first, making this a safety net rather than a race.
    const clearTimer = window.setTimeout(() => {
      programmaticZoomRef.current = false;
    }, 0);
    return () => window.clearTimeout(clearTimer);
  }, [rangeKey, following, liveChart]);

  // Seed the saved sub-range directly into the inside-dataZoom on first render
  // so popping a plot out (or reattaching) preserves the user's wheel-zoom.
  // The flag flips after mount so subsequent setOption calls don't fight the
  // live zoom — ECharts' partial merge keeps the chart's current start/end
  // when these fields are omitted.
  const [seedApplied, setSeedApplied] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional first-render gate
    setSeedApplied(true);
  }, []);
  const seedZoom =
    !seedApplied && initialViewWindowNs
      ? {
          startValue: nsToMs(initialViewWindowNs.fromNs),
          endValue: nsToMs(initialViewWindowNs.toNs),
        }
      : null;

  // Chart event handlers get the chart that fired the event. CanopyChart drops
  // events from a disposed chart before they reach us; both handlers also
  // ignore a chart without a model (not built yet, or disposed), so neither
  // depends on that filter.
  const handleFinished = useCallback(
    (_params: unknown, chart: ECharts) => {
      // Without a model there are no extents to report, and an empty map would
      // wipe the ranges the app already has.
      if (!onAxisRangesChange || !chartModel(chart)) return;
      const next = new Map<string, [number, number]>();
      visibleAxes.forEach((axis, idx) => {
        const ext = getAxisExtent(chart, 'yAxis', idx);
        if (ext) next.set(axis.id, ext);
      });
      onAxisRangesChange(next);
    },
    [onAxisRangesChange, visibleAxes]
  );

  const handleDataZoom = useCallback(
    (_params: unknown, chart: ECharts) => {
      // An event from a chart without a model isn't the user's pan: don't let
      // it consume the programmatic-zoom flag or stop following.
      if (!chartModel(chart)) return;
      // Ignore the zoom reset we dispatched on a range re-select; only genuine
      // user pan/zoom should record a manual window and disable autoscroll.
      if (programmaticZoomRef.current) {
        programmaticZoomRef.current = false;
        return;
      }
      // A genuine pan/zoom takes the window over. Stop following at once (the
      // app freezes the plot at the `endMs` it gave us), so no tick or live batch
      // can slide the axis under the user's drag while the view window below is
      // debounced.
      if (following) onFollowStop?.();
      if (!onViewWindowChange) return;
      // Read the current x-axis extent (in ms) directly from the model — this
      // reflects the visible time range after the user has zoomed/panned.
      const ext = getAxisExtent(chart, 'xAxis', 0);
      if (!ext) return;
      const [fromMs, toMs] = ext;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        onViewWindowChange({ fromNs: msToNs(fromMs), toNs: msToNs(toMs) });
      }, 400);
    },
    [onViewWindowChange, following, onFollowStop]
  );

  // Per-Y-axis mouse interactions (issue 45): scrolling over a single axis zooms
  // only that axis; dragging an axis pans only that axis. The whole-plot X
  // pan/zoom (the `inside` dataZoom) still owns the plot interior.
  //
  // Listeners live on OUR wrapper div (and its window), never on the ECharts /
  // zrender instance: CanopyChart initializes asynchronously through
  // echarts-for-react, which measures with a throwaway instance that it
  // disposes right after the first `finished` event, then builds the real
  // chart, and re-creates it if the init options change. Anything subscribed
  // to a zrender instance at mount time dies within the first frame. The
  // wrapper div is stable for the lifetime of this component, so each handler
  // resolves the *live* instance on demand.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    // Detached plots render into a `window.open` document; drag tracking must
    // listen on THAT window, not the opener's.
    const win = wrap.ownerDocument.defaultView ?? window;

    // Wrapper-local coordinates. The wrapper exactly overlays the chart canvas
    // (both fill 100% × 100% with no padding), so these are canvas pixels.
    const toLocal = (e: MouseEvent) => {
      const r = wrap.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    const hitTest = (ec: ECharts, x: number, y: number) =>
      hitTestAxis(x, y, ec.getWidth(), ec.getHeight(), gridBandRef.current, axisLayoutRef.current);

    // zrender re-stamps `cursor: default` onto its own root element on every
    // mousemove, overriding anything set on an ancestor. Write through
    // setCursorStyle instead; our handlers run after zrender's for the same
    // event (they sit further out on the bubble path), so our write lands last.
    const setCursor = (cursor: string) => liveChart()?.getZr().setCursorStyle(cursor);

    // Freeze an auto-scaled axis to its current computed extent so the delta we
    // apply isn't immediately overwritten by autoscale on the next render.
    const commit = (
      axisId: string,
      logScale: boolean,
      min: number,
      max: number,
      freeze: boolean
    ) => {
      if (!Number.isFinite(min) || !Number.isFinite(max)) return;
      // A degenerate (flat-line) extent is valid for a freeze — the axis must
      // still switch to manual — but a zoom/pan that collapses to zero range is
      // pointless and would lock the axis.
      if (min === max && !freeze) return;
      if (logScale && (min <= 0 || max <= 0)) return;
      const lo = Math.min(min, max);
      const hi = Math.max(min, max);
      onUpdateAxisRef.current?.(
        axisId,
        freeze ? { autoScale: false, min: lo, max: hi } : { min: lo, max: hi }
      );
    };

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const ec = liveChart();
      if (!ec) return;
      const { x, y } = toLocal(e);
      const hit = hitTest(ec, x, y);
      if (!hit) return;
      e.preventDefault(); // no text selection / native drag while panning the axis
      const ext = getAxisExtent(ec, 'yAxis', hit.yAxisIndex);
      if (!ext) return;
      // Freeze-to-manual up front so the drag delta isn't clobbered by autoscale.
      if (hit.autoScale) {
        commit(hit.axisId, hit.logScale, ext[0], ext[1], true);
        const zone = axisLayoutRef.current.find((a) => a.axisId === hit.axisId);
        if (zone) zone.autoScale = false;
      }
      // Snapshot the extent AND its pixel mapping once. The drag math below runs
      // entirely off this frozen snapshot; it must not re-read the live scale,
      // because committing a new min/max re-renders the axis and shifts the
      // pixel<->data mapping out from under an in-progress drag.
      const pxMin = ec.convertToPixel({ yAxisIndex: hit.yAxisIndex }, ext[0]);
      const pxMax = ec.convertToPixel({ yAxisIndex: hit.yAxisIndex }, ext[1]);
      dragRef.current = {
        axisId: hit.axisId,
        yAxisIndex: hit.yAxisIndex,
        logScale: hit.logScale,
        startY: y,
        min: ext[0],
        max: ext[1],
        pxMin,
        pxMax,
      };
    };

    // Drag tracking lives on the window so the pan keeps following (and reliably
    // ends) outside the canvas; the axis band touches the canvas edge, so a
    // drag overshoots it constantly.
    const onWindowMouseMove = (e: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      // If the button was released where our mouseup couldn't see it (over
      // browser chrome, another window, devtools), no mouseup reaches `win` and
      // dragRef would stay set, panning the axis on every later move. buttons===0
      // means nothing is held, so end the drag here.
      if (e.buttons === 0) {
        dragRef.current = null;
        return;
      }
      // Pan the FROZEN mousedown mapping by the total drag delta; see panExtent
      // for the direction/log-space semantics.
      const next = panExtent(drag, toLocal(e).y - drag.startY);
      if (!next) return;
      commit(drag.axisId, drag.logScale, next[0], next[1], false);
      // zrender stamps `default` on every in-canvas move; re-assert while dragging.
      setCursor('ns-resize');
    };

    const onWindowMouseUp = () => {
      dragRef.current = null;
    };

    // Hover affordance. Re-assert on every move while over a band (zrender
    // resets the cursor each mousemove); restore once on leaving so we don't
    // fight ECharts' own cursor over the plot interior.
    let hovering = false;
    const onHoverMove = (e: MouseEvent) => {
      if (dragRef.current) return;
      const ec = liveChart();
      if (!ec) return;
      const { x, y } = toLocal(e);
      const over = hitTest(ec, x, y) !== null;
      if (over) setCursor('ns-resize');
      else if (hovering) setCursor('default');
      hovering = over;
    };

    // Native listener so preventDefault can cancel page scroll over an axis
    // band (the inside dataZoom already ignores wheel outside the grid).
    const onWheel = (e: WheelEvent) => {
      const ec = liveChart();
      if (!ec) return;
      const { x, y } = toLocal(e);
      const hit = hitTest(ec, x, y);
      if (!hit) return;
      // A purely horizontal scroll (deltaY 0, e.g. shift+wheel or a sideways
      // trackpad gesture) carries no zoom intent; ignore it so we neither zoom
      // the axis nor swallow the horizontal scroll via preventDefault.
      if (e.deltaY === 0) return;
      e.preventDefault();
      const ext = getAxisExtent(ec, 'yAxis', hit.yAxisIndex);
      if (!ext) return;
      if (hit.autoScale) {
        commit(hit.axisId, hit.logScale, ext[0], ext[1], true);
        // Mark the ref stale synchronously so subsequent wheel events in the same
        // React batch don't re-freeze (the useEffect hasn't re-synced yet).
        const zone = axisLayoutRef.current.find((a) => a.axisId === hit.axisId);
        if (zone) zone.autoScale = false;
      }
      const anchor = ec.convertFromPixel({ yAxisIndex: hit.yAxisIndex }, y);
      if (!Number.isFinite(anchor) || (hit.logScale && anchor <= 0)) return;
      const factor = e.deltaY > 0 ? 1.1 : 1 / 1.1; // scroll down = zoom out
      const next = zoomExtent(ext[0], ext[1], anchor, factor, hit.logScale);
      commit(hit.axisId, hit.logScale, next[0], next[1], false);
    };

    wrap.addEventListener('mousedown', onMouseDown);
    wrap.addEventListener('mousemove', onHoverMove);
    wrap.addEventListener('wheel', onWheel, { passive: false });
    win.addEventListener('mousemove', onWindowMouseMove);
    win.addEventListener('mouseup', onWindowMouseUp);

    return () => {
      wrap.removeEventListener('mousedown', onMouseDown);
      wrap.removeEventListener('mousemove', onHoverMove);
      wrap.removeEventListener('wheel', onWheel);
      win.removeEventListener('mousemove', onWindowMouseMove);
      win.removeEventListener('mouseup', onWindowMouseUp);
    };
  }, [liveChart]);

  // Axes sharing a side (left/right) would otherwise stack at the same spot and
  // overlap, so we offset each one outward by its position within that side.
  const sideIndexMap = new Map<string, number>();
  let leftAxesCount = 0;
  let rightAxesCount = 0;
  for (const axis of visibleAxes) {
    if (axis.orientation === 'right') sideIndexMap.set(axis.id, rightAxesCount++);
    else sideIndexMap.set(axis.id, leftAxesCount++);
  }

  // Pin the x-axis extent to the requested time range so the axis spans the
  // full window even when archive data is sparse and clusters in a sub-range.
  // dataZoom inside the chart still sub-zooms within [min, max].
  const requested = resolveTimeWindow(plot.xAxis, shownEndMs).window;
  const xAxisMin = nsToMs(requested.fromNs);
  const xAxisMax = nsToMs(requested.toNs);

  // INVALID stretches per trace, and the marker lane each trace draws them in.
  // Only drawn traces take a lane, in draw order, so a trace on a hidden axis
  // doesn't push the drawn ones into the shared last lane. Stretches outside
  // the window take none, and an open one runs to the right edge, so this
  // follows the axis as it scrolls.
  const invalidByTrace = useMemo(() => {
    const out = new Map<string, { stretches: [number, number][]; lane: number }>();
    for (const { trace } of orderedTraces) {
      if (!tracesWithInvalid.has(trace.id)) continue;
      const stretches = invalidStretches(traceData.get(trace.id) ?? [], xAxisMin, xAxisMax);
      if (stretches.length > 0) out.set(trace.id, { stretches, lane: out.size });
    }
    return out;
  }, [orderedTraces, traceData, tracesWithInvalid, xAxisMin, xAxisMax]);

  // Extension lines: a dashed line from each trace's last sample to the right
  // edge. A following plot is never zoomed (a pan or zoom stops it following),
  // so two points do, and moving them as the axis scrolls costs nothing. A
  // frozen plot can be zoomed, so it gets the dense anchors; its axis holds
  // still, so they're only rebuilt when the samples change. None from an
  // INVALID last sample: the marker covers that stretch.
  const extensionSeries = useMemo(() => {
    const out = new Map<string, Record<string, unknown>>();
    const anchors = following ? 2 : EXTENSION_ANCHORS;
    for (const { trace, yAxisIndex, baseZ } of orderedTraces) {
      if (trace.showExtensionLine === false || trace.lineStyle === 'none') continue;
      const last = traceData.get(trace.id)?.at(-1);
      if (!last || isInvalid(last) || last.time >= xAxisMax) continue;
      const startMs = Math.max(last.time, xAxisMin);
      const data = new Float64Array(anchors * 2);
      for (let k = 0; k < anchors; k++) {
        // The last anchor sits exactly on the edge; a rounding step past it
        // would be filtered out and take a two-point line with it.
        data[2 * k] =
          k === anchors - 1 ? xAxisMax : startMs + ((xAxisMax - startMs) * k) / (anchors - 1);
        data[2 * k + 1] = last.value;
      }
      out.set(trace.id, {
        id: `${trace.id}-extension`,
        name: `${trace.displayName} (extension)`,
        type: 'line',
        yAxisIndex,
        data,
        dimensions: XY_DIMENSIONS,
        lineStyle: {
          color: trace.color,
          width: trace.lineWidth,
          type: 'dashed',
          opacity: 0.7,
        },
        itemStyle: { color: trace.color },
        symbol: 'none',
        showSymbol: false,
        showInLegend: false,
        tooltip: { show: false },
        silent: true,
        animation: false,
        z: baseZ + 1,
        emphasis: { disabled: true },
      });
    }
    return out;
  }, [orderedTraces, traceData, xAxisMin, xAxisMax, following]);

  // Grid insets. Named so the per-axis hit-zones (below) derive from the exact
  // same numbers ECharts lays the grid out with.
  const GRID_TOP = 40;
  const GRID_BOTTOM = 60;
  const gridLeft = 70 + Math.max(0, leftAxesCount - 1) * AXIS_OFFSET;
  const gridRight = (rightAxesCount > 0 ? 70 : 20) + Math.max(0, rightAxesCount - 1) * AXIS_OFFSET;

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
    gridBandRef.current = { top: GRID_TOP, bottom: GRID_BOTTOM, left: gridLeft, right: gridRight };
    onUpdateAxisRef.current = onUpdateAxis;
  });

  // Shared Canopy chart styling from canopy-charts: animation off, the Plex
  // font, and themed axes, tooltip and legend. Trace layers its own layout and
  // content on top.
  const base = baseChartOption(theme);
  const baseTooltip = base.tooltip as TooltipComponentOption;
  const baseLegend = base.legend as LegendComponentOption;
  const axisStyle = chartAxisStyle(theme);

  const option: EChartsOption = {
    ...base,
    backgroundColor: effectiveBackground(plot.backgroundColor, theme),
    grid: {
      top: GRID_TOP,
      bottom: GRID_BOTTOM,
      left: gridLeft,
      right: gridRight,
    },
    xAxis: {
      type: 'time',
      min: xAxisMin,
      max: xAxisMax,
      ...axisStyle,
      // ECharts keeps its time-tick spacing however narrow the chart is (e.g.
      // grid cells), so drop labels that would overlap rather than run together.
      axisLabel: {
        ...axisStyle.axisLabel,
        fontSize: plot.tickFontSize,
        hideOverlap: true,
        // Clear the INVALID markers drawn under the axis.
        margin: xAxisLabelMargin(invalidByTrace.size),
      },
      splitLine: {
        show: plot.showXGridlines,
        lineStyle: {
          ...axisStyle.splitLine.lineStyle,
          type: plot.gridStyle,
          opacity: plot.gridOpacity,
        },
      },
    },
    yAxis: visibleAxes.map((axis, axisIdx) => ({
      // Intentionally no `id`: with replaceMerge, ECharts matches by id and
      // would pin a surviving axis back to its old slot index, leaving a
      // hole at the deleted slot. Series then point to that hole and ECharts
      // throws "yAxis 0 not found". Index-based mapping fills slots cleanly.
      type: axis.logScale ? 'log' : 'value',
      name: axis.name,
      ...axisStyle,
      nameTextStyle: { ...axisStyle.nameTextStyle, fontSize: 11 },
      // Run the title vertically alongside its own axis line so titles never
      // collide when multiple axes share a side. nameGap clears the labels.
      nameLocation: 'middle',
      nameRotate: 90,
      nameGap: 65,
      position: axis.orientation,
      offset: (sideIndexMap.get(axis.id) ?? 0) * AXIS_OFFSET,
      min: axis.autoScale ? undefined : axis.min,
      max: axis.autoScale ? undefined : axis.max,
      scale: axis.autoScale,
      axisLabel: { ...axisStyle.axisLabel, fontSize: plot.tickFontSize, formatter: formatAxisTick },
      // ECharts hides axisLine on secondary y-axes by default; force it on so
      // every stacked axis shows its own vertical line next to its labels.
      axisLine: { ...axisStyle.axisLine, show: true },
      splitLine: {
        // Horizontal gridlines are a property of the grid, not each axis: with
        // multiple Y axes on differing scales their ticks fall at different
        // heights, so drawing more than one set overlaps into a broken-looking
        // grid. Draw only the primary (first visible) axis's lines.
        show: plot.showYGridlines && axisIdx === 0,
        lineStyle: {
          ...axisStyle.splitLine.lineStyle,
          type: plot.gridStyle,
          opacity: plot.gridOpacity,
        },
      },
    })),
    series: orderedTraces.flatMap(({ trace, yAxisIndex, baseZ }) => {
      const out = [...(baseSeries.get(trace.id) ?? [])];
      const invalid = invalidByTrace.get(trace.id);
      if (invalid) {
        out.push(
          invalidMarkerSeries({
            id: `${trace.id}-invalid`,
            name: `${labels.get(trace.id)} (invalid)`,
            color: trace.color,
            yAxisIndex,
            lane: invalid.lane,
            stretches: invalid.stretches,
            z: baseZ + 1,
          })
        );
      }
      const ext = extensionSeries.get(trace.id);
      if (ext) out.push(ext);
      return out;
    }),
    dataZoom: [
      {
        type: 'inside',
        zoomOnMouseWheel: true,
        moveOnMouseMove: true,
        moveOnMouseWheel: false,
        // 'weakFilter' drops segments only when both endpoints are outside the
        // window on the same side — extension lines survive any intersecting zoom.
        filterMode: 'weakFilter',
        ...(seedZoom ?? {}),
      },
    ],
    tooltip: {
      ...baseTooltip,
      trigger: 'axis',
      axisPointer: {
        ...baseTooltip.axisPointer,
        type: plot.showCrosshair ? 'cross' : 'none', // 'cross' adds Y-axis readout; 'none' hides crosshair but keeps tooltip
        snap: false,
        label: {
          ...baseTooltip.axisPointer?.label,
          // X --> timestamp, Y --> raw value. Both axes are numeric (time in ms,
          // value or log), so the label value is always a number here.
          formatter: (p) =>
            p.axisDimension === 'y'
              ? formatValue(Number(p.value))
              : formatCrosshairTime(Number(p.value)),
        },
      },
      textStyle: { ...baseTooltip.textStyle, fontSize: 11 },
      // Walk every visible trace ourselves rather than trusting `params`. With
      // snap: false, ECharts only includes series that have a sample exactly
      // under the cursor — sparse archive data leaves most traces out. The
      // closure captures `traceData` and `visibleTraces` from the surrounding
      // render so each line shows the trace's nearest sample plus the time
      // offset between cursor and that sample.
      formatter: (params) => {
        const arr = Array.isArray(params) ? params : [params];
        if (arr.length === 0) return '';
        // Axis-triggered params carry the cursor's axis value, which ECharts'
        // callback types leave out.
        const cursorMs = (arr[0] as { axisValue?: unknown } | undefined)?.axisValue;
        if (typeof cursorMs !== 'number' || !Number.isFinite(cursorMs)) return '';
        const time = formatCrosshairTime(cursorMs);
        const lines: string[] = [];
        for (const trace of visibleTraces) {
          const data = traceData.get(trace.id);
          const sample = data ? nearestSample(data, cursorMs) : undefined;
          const severity =
            sample?.severity && sample.severity !== 'NO_ALARM'
              ? ` ${escapeHtml(sample.severity)}`
              : '';
          const valueCell = sample
            ? `${escapeHtml(formatValue(sample.value))}${severity} <span style="color:${theme.tooltipMuted}">(${formatTimeOffset(sample.time - cursorMs)})</span>`
            : `<span style="color:${theme.tooltipMuted}">no data</span>`;
          lines.push(
            `<span style="color:${safeTooltipColor(trace.color)}">${escapeHtml(labels.get(trace.id) ?? '')}</span>: ${valueCell}`
          );
        }
        return `<div style="font-size:11px"><div style="color:${theme.tooltipMuted};margin-bottom:4px">${time}</div>${lines.join('<br/>')}</div>`;
      },
    },
    legend: {
      ...baseLegend,
      show: plot.showLegend,
      bottom: 8,
      textStyle: { ...baseLegend.textStyle, fontSize: 11 },
      data: visibleTraces.map((t) => labels.get(t.id) ?? ''),
      selectedMode: false, // legend clicks aren't wired to trace.visible --> disable to + avoid drift
    },
  };

  return (
    // data-plot-id lets capturePlotPng find this plot's wrapper in the
    // document (print snapshots, PNG export) and the chart registered for it.
    // Detached plots live in another window's document, so they're naturally
    // out of scope. data-fullscreen marks the popped-out copy so capture
    // targets it over the in-window one, which shares the same data-plot-id.
    <div
      ref={wrapRef}
      data-plot-id={plot.id}
      data-fullscreen={fullscreen ? 'true' : undefined}
      style={{ height: '100%', width: '100%' }}
    >
      <CanopyChart
        option={option}
        replaceMerge={['series', 'yAxis']}
        onEvents={{ datazoom: handleDataZoom, finished: handleFinished }}
        onReady={handleReady}
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
  onFollowStop,
  viewWindowByPlot,
  axisEndFor,
  onAxisRangesChange,
  onUpdateAxis,
  onChartInstance,
}: PlotAreaProps) {
  const activePlot = plots.find((p) => p.id === activePlotId) ?? plots[0];
  const isDetached = (id: string) => detachedPlotIds.includes(id);

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
          <button
            className={`view-mode-btn${viewMode === 'tabs' ? ' view-mode-btn--active' : ''}`}
            title="Tab view"
            onClick={() => onSetViewMode('tabs')}
          >
            <ColumnDependency size={16} />
          </button>
          <button
            className={`view-mode-btn${viewMode === 'grid' ? ' view-mode-btn--active' : ''}`}
            title="Grid view"
            onClick={() => onSetViewMode('grid')}
          >
            <Grid size={16} />
          </button>
          <button
            className="view-mode-btn"
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
            // Each chart has its own boundary, so a crash leaves the plot tabs and
            // view controls usable (switch to another plot, remove or detach this one).
            <ErrorBoundary key={activePlot.id}>
              <SinglePlot
                plot={activePlot}
                endMs={axisEndFor(activePlot.id)}
                following={isFollowing(activePlot, viewWindowByPlot)}
                onFollowStop={onFollowStop ? () => onFollowStop(activePlot.id) : undefined}
                archiveResults={archiveResultsByPlot.get(activePlot.id) ?? EMPTY_RESULTS}
                liveResults={liveResultsByPlot.get(activePlot.id) ?? EMPTY_LIVE_RESULTS}
                formulaResults={formulaResultsByPlot.get(activePlot.id) ?? EMPTY_FORMULA_RESULTS}
                onViewWindowChange={
                  onViewWindowChange ? (w) => onViewWindowChange(activePlot.id, w) : undefined
                }
                initialViewWindowNs={viewWindowByPlot.get(activePlot.id)}
                onAxisRangesChange={
                  onAxisRangesChange ? (r) => onAxisRangesChange(activePlot.id, r) : undefined
                }
                onUpdateAxis={
                  onUpdateAxis ? (id, u) => onUpdateAxis(activePlot.id, id, u) : undefined
                }
                onChartInstance={
                  onChartInstance
                    ? (inst, active) => onChartInstance(activePlot.id, inst, active)
                    : undefined
                }
              />
            </ErrorBoundary>
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
              <div key={plot.id} className="plot-grid__cell">
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
                {isDetached(plot.id) ? (
                  <DetachedPlaceholder
                    title={plot.title}
                    onReattach={() => onReattachPlot(plot.id)}
                  />
                ) : (
                  <ErrorBoundary>
                    <SinglePlot
                      plot={plot}
                      endMs={axisEndFor(plot.id)}
                      following={isFollowing(plot, viewWindowByPlot)}
                      onFollowStop={onFollowStop ? () => onFollowStop(plot.id) : undefined}
                      archiveResults={archiveResultsByPlot.get(plot.id) ?? EMPTY_RESULTS}
                      liveResults={liveResultsByPlot.get(plot.id) ?? EMPTY_LIVE_RESULTS}
                      formulaResults={formulaResultsByPlot.get(plot.id) ?? EMPTY_FORMULA_RESULTS}
                      onViewWindowChange={
                        onViewWindowChange ? (w) => onViewWindowChange(plot.id, w) : undefined
                      }
                      initialViewWindowNs={viewWindowByPlot.get(plot.id)}
                      onAxisRangesChange={
                        onAxisRangesChange ? (r) => onAxisRangesChange(plot.id, r) : undefined
                      }
                      onUpdateAxis={
                        onUpdateAxis ? (id, u) => onUpdateAxis(plot.id, id, u) : undefined
                      }
                      onChartInstance={
                        onChartInstance
                          ? (inst, active) => onChartInstance(plot.id, inst, active)
                          : undefined
                      }
                    />
                  </ErrorBoundary>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
