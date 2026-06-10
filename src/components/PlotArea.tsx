import { useCallback, useEffect, useRef, useState } from 'react';
import ReactECharts from 'echarts-for-react';
import { DARK_CHART_THEME, LIGHT_CHART_THEME, effectiveBackground } from '../chartTheme';
import { Add, Close, ColumnDependency, Grid, Launch, Login, Maximize } from '@carbon/icons-react';
import type { Plot, PVTrace } from '../types';
import type { ArchiveSeriesResult } from '../hooks/useArchiveSeries';
import type { LiveSeriesResult } from '../hooks/useLiveSeries';
import type { TimeWindowNs } from '../api/time';
import { msToNs, nsToMs, rangeToWindowNs } from '../api/time';
import { echartsLineType, echartsSymbol } from '../curveStyle';
import { traceLabel } from '../traceLabel';
import { useColorMode } from '../state/themeStore';

// Numbers like 0.000000018 produce extremely wide tick labels that spill past
// neighboring stacked axes. Switch to exponential at the same magnitudes the
// browser's default Number.toString stops being compact.
function formatAxisTick(value: number): string {
  if (value === 0) return '0';
  const abs = Math.abs(value);
  if (abs < 1e-3 || abs >= 1e6) return value.toExponential(1);
  return String(value);
}

// Signature of the user-chosen range. Bumps when picking a new time range so
// dataZoom resets to full extent — otherwise the previous zoom stays clipped
// over the new range.
function rangeKeyFor(plot: Plot): string {
  return plot.xAxis.timeRange;
}

interface PlotAreaProps {
  plots: Plot[];
  activePlotId: string;
  viewMode: 'tabs' | 'grid';
  archiveResultsByPlot: Map<string, Map<string, ArchiveSeriesResult>>;
  liveResultsByPlot: Map<string, Map<string, LiveSeriesResult>>;
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
  /** Saved per-plot view window; seeds dataZoom across remounts (e.g. popout). */
  viewWindowByPlot: Map<string, TimeWindowNs>;
  onAxisRangesChange?: (plotId: string, ranges: Map<string, [number, number]>) => void;
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
  onViewWindowChange?: (window: TimeWindowNs) => void;
  /**
   * Last known visible window from a prior mount of this plot. Seeds the inside
   * dataZoom on first render so popping a plot out (or reattaching) preserves
   * whatever sub-range the user had wheel-zoomed into. Only consulted on mount.
   */
  initialViewWindowNs?: TimeWindowNs;
  onAxisRangesChange?: (ranges: Map<string, [number, number]>) => void;
}

function formatCrosshairTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatTooltipValue(v: unknown): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return String(v);
  if (v === 0) return '0';
  const abs = Math.abs(v);
  if (abs < 1e-3 || abs >= 1e7) return v.toExponential(4);
  return v.toPrecision(7);
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

function traceLineData(
  trace: PVTrace,
  archive: ArchiveSeriesResult | undefined,
  live: LiveSeriesResult | undefined
): [number, number][] {
  // Mirror old Trace's independent toggles. Archive feeds the past, live
  // feeds the present; with both on, archive runs up to the last archive
  // sample and live takes over afterwards (de-duped at the seam).
  const archivePts =
    trace.useArchive && archive && archive.mean.length > 0
      ? archive.mean.map((p): [number, number] => [p.time, p.value])
      : null;
  const livePts =
    trace.useLive && live && live.points.length > 0
      ? live.points.map((p): [number, number] => [p.time, p.value])
      : null;

  if (archivePts && livePts) {
    const seamMs = archivePts[archivePts.length - 1][0];
    let head = 0;
    while (head < livePts.length && livePts[head][0] <= seamMs) head++;
    return head === 0 ? archivePts.concat(livePts) : archivePts.concat(livePts.slice(head));
  }
  if (archivePts) return archivePts;
  if (livePts) return livePts;
  // Live-capable trace that has no live yet (pre-connect or no samples) and
  // no archive: render nothing rather than the mock seed. Mock data stays
  // for traces with neither toggle on, since there's no other source to show.
  if (trace.useLive || trace.useArchive) return [];
  return trace.data.map((p) => [p.time, p.value]);
}

// Binary search for the sample whose `time` is nearest to `tMs`. Series are
// always sorted ascending by time (archive buffer + mock generator both honor
// this), so we don't sort here.
function nearestSample(
  data: [number, number][],
  tMs: number
): { time: number; value: number } | undefined {
  if (data.length === 0) return undefined;
  let lo = 0;
  let hi = data.length - 1;
  if (tMs <= data[lo][0]) return { time: data[lo][0], value: data[lo][1] };
  if (tMs >= data[hi][0]) return { time: data[hi][0], value: data[hi][1] };
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (data[mid][0] <= tMs) lo = mid;
    else hi = mid;
  }
  const pickHi = data[hi][0] - tMs < tMs - data[lo][0];
  const idx = pickHi ? hi : lo;
  return { time: data[idx][0], value: data[idx][1] };
}

export function SinglePlot({
  plot,
  archiveResults,
  liveResults,
  onViewWindowChange,
  initialViewWindowNs,
  onAxisRangesChange,
}: SinglePlotProps) {
  const { colorMode } = useColorMode();
  const theme = colorMode === 'dark' ? DARK_CHART_THEME : LIGHT_CHART_THEME;
  const visibleAxes = plot.axes.filter((a) => a.visible);
  const visibleTraces = plot.traces.filter((t) => t.visible);
  const labels = new Map(plot.traces.map((t) => [t.id, traceLabel(t, plot.traces)]));

  const chartRef = useRef<ReactECharts>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset the inside-zoom to full extent when the user picks a new range. This
  // replaces the React-key remount we used to do — the chart instance survives,
  // so dataZoom state on subsequent panning is the only thing affected. Skip
  // the first mount: there's no zoom state to reset yet, and the chart instance
  // may not be fully attached to the DOM.
  const rangeKey = rangeKeyFor(plot);
  const isFirstRangeRun = useRef(true);
  useEffect(() => {
    if (isFirstRangeRun.current) {
      isFirstRangeRun.current = false;
      return;
    }
    const inst = chartRef.current?.getEchartsInstance();
    if (!inst || !inst.getDom()) return;
    inst.dispatchAction({ type: 'dataZoom', start: 0, end: 100 });
  }, [rangeKey]);

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

  const handleFinished = useCallback(() => {
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
  }, [onAxisRangesChange, visibleAxes]);

  const handleDataZoom = useCallback(() => {
    if (!onViewWindowChange) return;
    const inst = chartRef.current?.getEchartsInstance();
    if (!inst) return;
    // Read the current x-axis extent (in ms) directly from the model — this
    // reflects the visible time range after the user has zoomed/panned.
    type AxisModel = { axis: { scale: { getExtent: () => [number, number] } } };
    const xModel = (
      inst as unknown as { getModel: () => { getComponent: (n: string, i: number) => AxisModel } }
    )
      .getModel()
      .getComponent('xAxis', 0);
    const ext = xModel?.axis?.scale?.getExtent();
    if (!ext) return;
    const [fromMs, toMs] = ext;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      onViewWindowChange({ fromNs: msToNs(fromMs), toNs: msToNs(toMs) });
    }, 400);
  }, [onViewWindowChange]);

  // Build yAxis array; ECharts links series to axes by index, so we track index per axis id
  const axisIndexMap = new Map<string, number>();
  visibleAxes.forEach((axis, idx) => {
    axisIndexMap.set(axis.id, idx);
  });

  // Axes sharing a side (left/right) would otherwise stack at the same spot and
  // overlap, so we offset each one outward by its position within that side.
  // Pixels each stacked axis is pushed past the previous one on the same side.
  const AXIS_OFFSET = 80;
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
  const requested = rangeToWindowNs(plot.xAxis.timeRange);
  const xAxisMin = nsToMs(requested.fromNs);
  const xAxisMax = nsToMs(requested.toNs);

  // Pre-compute per-trace [time, value] arrays once; series rendering and the
  // tooltip formatter both read from this map. Sorted ascending by time.
  const traceData = new Map<string, [number, number][]>();
  for (const trace of visibleTraces) {
    traceData.set(
      trace.id,
      traceLineData(trace, archiveResults.get(trace.id), liveResults.get(trace.id))
    );
  }

  const option = {
    backgroundColor: effectiveBackground(plot.backgroundColor, theme),
    animation: false,
    grid: {
      top: 40,
      bottom: 60,
      left: 70 + Math.max(0, leftAxesCount - 1) * AXIS_OFFSET,
      right: (rightAxesCount > 0 ? 70 : 20) + Math.max(0, rightAxesCount - 1) * AXIS_OFFSET,
    },
    xAxis: {
      type: 'time',
      min: xAxisMin,
      max: xAxisMax,
      axisLabel: { color: theme.axisLabel, fontSize: 11 },
      axisLine: { lineStyle: { color: theme.axisLine } },
      splitLine: {
        show: plot.showGridlines,
        lineStyle: { color: theme.splitLine, type: plot.gridStyle },
      },
    },
    yAxis: visibleAxes.map((axis) => ({
      // Intentionally no `id`: with replaceMerge, ECharts matches by id and
      // would pin a surviving axis back to its old slot index, leaving a
      // hole at the deleted slot. Series then point to that hole and ECharts
      // throws "yAxis 0 not found". Index-based mapping fills slots cleanly.
      type: axis.logScale ? 'log' : 'value',
      name: axis.name,
      nameTextStyle: { color: theme.axisName, fontSize: 11 },
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
      axisLabel: { color: theme.axisLabel, fontSize: 11, formatter: formatAxisTick },
      // ECharts hides axisLine on secondary y-axes by default; force it on so
      // every stacked axis shows its own vertical line next to its labels.
      axisLine: { show: true, lineStyle: { color: theme.axisLine } },
      splitLine: {
        show: plot.showGridlines,
        lineStyle: { color: theme.splitLine, type: plot.gridStyle },
      },
    })),
    series: (() => {
      // Order traces by axis (in panel order) then by their position within
      // each axis. Earlier axis / earlier trace draws on top — assign higher
      // `z` values to those, and pin the order with `emphasis.disabled` so
      // hover doesn't shuffle the depth.
      const orderedTraces: PVTrace[] = [];
      for (const axis of visibleAxes) {
        for (const trace of visibleTraces) {
          if (trace.axisId === axis.id) orderedTraces.push(trace);
        }
      }

      const total = orderedTraces.length;
      return orderedTraces.flatMap((trace, i) => {
        const yAxisIndex = axisIndexMap.get(trace.axisId) ?? 0;
        const archive = archiveResults.get(trace.id);
        const baseZ = (total - i) * 10;
        const series: Record<string, unknown>[] = [];

        // Min/max band, drawn as two stacked area series so ECharts fills between them.
        // Keep the previous band rendered while a fetch is in flight (status may
        // be 'loading') so the band doesn't disappear during panning/zooming.
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
            data: archive.band.map((p) => [p.time, p.min]),
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
            data: archive.band.map((p) => [p.time, p.max - p.min]),
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

        const tracePoints = traceData.get(trace.id) ?? [];
        series.push({
          id: trace.id,
          name: labels.get(trace.id),
          type: 'line',
          yAxisIndex,
          data: tracePoints,
          step: trace.lineType === 'step' ? 'end' : false,
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

        if (trace.showExtensionLine !== false && trace.lineStyle !== 'none') {
          const last = tracePoints.at(-1);
          if (last && last[0] < xAxisMax) {
            const startTime = Math.max(last[0], xAxisMin);
            // 2048 anchors so weakFilter always finds in-window points at any zoom depth.
            const ANCHORS = 2048;
            const data = Array.from({ length: ANCHORS }, (_, k): [number, number] => [
              startTime + ((xAxisMax - startTime) * k) / (ANCHORS - 1),
              last[1],
            ]);
            series.push({
              id: `${trace.id}-extension`,
              name: `${trace.displayName} (extension)`,
              type: 'line',
              yAxisIndex,
              data,
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
        }

        return series;
      });
    })(),
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
      trigger: 'axis',
      axisPointer: {
        type: plot.showCrosshair ? 'cross' : 'none', // 'cross' adds Y-axis readout; 'none' hides crosshair but keeps tooltip
        snap: false,
        lineStyle: { color: theme.crosshair, width: 1, type: 'dashed' },
        crossStyle: { color: theme.crosshair, width: 1, type: 'dashed' },
        label: {
          backgroundColor: theme.tooltipBorder,
          formatter: (
            p: { value: number; axisDimension?: string } // X --> timestamp, Y --> raw value
          ) =>
            p.axisDimension === 'y' ? formatTooltipValue(p.value) : formatCrosshairTime(p.value),
        },
      },
      backgroundColor: theme.tooltipBg,
      borderColor: theme.tooltipBorder,
      textStyle: { color: theme.tooltipText, fontSize: 11 },
      // Walk every visible trace ourselves rather than trusting `params`. With
      // snap: false, ECharts only includes series that have a sample exactly
      // under the cursor — sparse archive data leaves most traces out. The
      // closure captures `traceData` and `visibleTraces` from the surrounding
      // render so each line shows the trace's nearest sample plus the time
      // offset between cursor and that sample.
      formatter: (params: { axisValue: number }[] | { axisValue: number }) => {
        const arr = Array.isArray(params) ? params : [params];
        if (arr.length === 0) return '';
        const cursorMs = arr[0]?.axisValue;
        if (typeof cursorMs !== 'number' || !Number.isFinite(cursorMs)) return '';
        const time = formatCrosshairTime(cursorMs);
        const lines: string[] = [];
        for (const trace of visibleTraces) {
          const data = traceData.get(trace.id);
          const sample = data ? nearestSample(data, cursorMs) : undefined;
          const valueCell = sample
            ? `${formatTooltipValue(sample.value)} <span style="color:${theme.tooltipMuted}">(${formatTimeOffset(sample.time - cursorMs)})</span>`
            : `<span style="color:${theme.tooltipMuted}">no data</span>`;
          lines.push(
            `<span style="color:${trace.color}">${labels.get(trace.id)}</span>: ${valueCell}`
          );
        }
        return `<div style="font-size:11px"><div style="color:${theme.tooltipMuted};margin-bottom:4px">${time}</div>${lines.join('<br/>')}</div>`;
      },
    },
    legend: {
      show: plot.showLegend,
      bottom: 8,
      textStyle: { color: theme.legend, fontSize: 11 },
      inactiveColor: theme.tooltipMuted,
      data: visibleTraces.map((t) => labels.get(t.id)),
      selectedMode: false, // legend clicks aren't wired to trace.visible --> disable to + avoid drift
    },
  };

  return (
    // data-plot-id lets capturePlotPng find this chart's ECharts instance in
    // the document (print snapshots). Detached plots live in another window's
    // document, so they're naturally out of scope.
    <div data-plot-id={plot.id} style={{ height: '100%', width: '100%' }}>
      <ReactECharts
        ref={chartRef}
        option={option}
        replaceMerge={['series', 'yAxis']}
        onEvents={{ datazoom: handleDataZoom, finished: handleFinished }}
        style={{ height: '100%', width: '100%' }}
        opts={{ renderer: 'canvas' }}
      />
    </div>
  );
}

const EMPTY_RESULTS: Map<string, ArchiveSeriesResult> = new Map();
const EMPTY_LIVE_RESULTS: Map<string, LiveSeriesResult> = new Map();

export function PlotArea({
  plots,
  activePlotId,
  viewMode,
  archiveResultsByPlot,
  liveResultsByPlot,
  onSetActivePlot,
  onAddPlot,
  onRemovePlot,
  onSetViewMode,
  onPopOutPlot,
  detachedPlotIds,
  onDetachPlot,
  onReattachPlot,
  onViewWindowChange,
  viewWindowByPlot,
  onAxisRangesChange,
}: PlotAreaProps) {
  const activePlot = plots.find((p) => p.id === activePlotId) ?? plots[0];
  const isDetached = (id: string) => detachedPlotIds.includes(id);

  const gridCols =
    plots.length === 1
      ? 'grid-cols-1'
      : plots.length === 2
        ? 'grid-cols-2'
        : plots.length === 3
          ? 'grid-cols-3'
          : 'grid-cols-2';

  const gridRows = plots.length >= 4 ? 'grid-rows-2' : 'grid-rows-1';

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
            <span style={{ fontSize: 12, color: '#c6c6c6', padding: '0 8px' }}>
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
            <SinglePlot
              key={activePlot.id}
              plot={activePlot}
              archiveResults={archiveResultsByPlot.get(activePlot.id) ?? EMPTY_RESULTS}
              liveResults={liveResultsByPlot.get(activePlot.id) ?? EMPTY_LIVE_RESULTS}
              onViewWindowChange={
                onViewWindowChange ? (w) => onViewWindowChange(activePlot.id, w) : undefined
              }
              initialViewWindowNs={viewWindowByPlot.get(activePlot.id)}
              onAxisRangesChange={
                onAxisRangesChange ? (r) => onAxisRangesChange(activePlot.id, r) : undefined
              }
            />
          )
        ) : (
          <div
            className={`plot-grid ${gridCols} ${gridRows}`}
            style={{
              gridTemplateColumns: `repeat(${plots.length <= 2 ? plots.length : 2}, 1fr)`,
              gridTemplateRows: plots.length >= 4 ? '1fr 1fr' : '1fr',
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
                  <SinglePlot
                    plot={plot}
                    archiveResults={archiveResultsByPlot.get(plot.id) ?? EMPTY_RESULTS}
                    liveResults={liveResultsByPlot.get(plot.id) ?? EMPTY_LIVE_RESULTS}
                    onViewWindowChange={
                      onViewWindowChange ? (w) => onViewWindowChange(plot.id, w) : undefined
                    }
                    initialViewWindowNs={viewWindowByPlot.get(plot.id)}
                    onAxisRangesChange={
                      onAxisRangesChange ? (r) => onAxisRangesChange(plot.id, r) : undefined
                    }
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
