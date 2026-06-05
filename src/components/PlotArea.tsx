import { useCallback, useEffect, useRef } from 'react';
import ReactECharts from 'echarts-for-react';
import { Add, Close, ColumnDependency, Grid, Launch, Login, Maximize } from '@carbon/icons-react';
import type { Plot, PVTrace } from '../types';
import type { ArchiveSeriesResult } from '../hooks/useArchiveSeries';
import type { TimeWindowNs } from '../api/time';
import { msToNs, nsToMs, rangeToWindowNs } from '../api/time';
import { echartsLineType, echartsSymbol } from '../curveStyle';
import { useColorMode } from '../state/themeStore';

interface ChartTheme {
  bg: string;
  axisLabel: string;
  axisLine: string;
  splitLine: string;
  axisName: string;
  tooltipBg: string;
  tooltipBorder: string;
  tooltipText: string;
  tooltipMuted: string;
  crosshair: string;
  legend: string;
}

const DARK_CHART_THEME: ChartTheme = {
  bg: '#161616',
  axisLabel: '#c6c6c6',
  axisLine: '#525252',
  splitLine: '#393939',
  axisName: '#8d8d8d',
  tooltipBg: '#262626',
  tooltipBorder: '#393939',
  tooltipText: '#f4f4f4',
  tooltipMuted: '#8d8d8d',
  crosshair: '#8d8d8d',
  legend: '#c6c6c6',
};

const LIGHT_CHART_THEME: ChartTheme = {
  bg: '#ffffff',
  axisLabel: '#393939',
  axisLine: '#a8a8a8',
  splitLine: '#e0e0e0',
  axisName: '#525252',
  tooltipBg: '#ffffff',
  tooltipBorder: '#c6c6c6',
  tooltipText: '#161616',
  tooltipMuted: '#525252',
  crosshair: '#525252',
  legend: '#393939',
};

// Defaults from `addPlot` / INITIAL_PLOTS so we know which `plot.backgroundColor`
// values are "the theme default" vs. an explicit user override. When toggling
// themes, only the defaults follow.
const DARK_DEFAULT_BG = '#161616';
const LIGHT_DEFAULT_BG = '#ffffff';

function effectiveBackground(plotBg: string, theme: ChartTheme): string {
  // If plotBg matches either theme's default bg, snap to current theme's bg.
  // User-customized backgrounds (anything else) stay put.
  if (plotBg === DARK_DEFAULT_BG || plotBg === LIGHT_DEFAULT_BG) return theme.bg;
  return plotBg;
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
  onViewWindowChange?: (window: TimeWindowNs) => void;
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
  archive: ArchiveSeriesResult | undefined
): [number, number][] {
  // The store keeps the last good buffer around across refetches, so this is
  // a single read with no anti-flicker shim.
  if (trace.useArchive && archive && archive.mean.length > 0) {
    return archive.mean.map((p) => [p.time, p.value]);
  }
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

export function SinglePlot({ plot, archiveResults, onViewWindowChange }: SinglePlotProps) {
  const { colorMode } = useColorMode();
  const theme = colorMode === 'dark' ? DARK_CHART_THEME : LIGHT_CHART_THEME;
  const visibleAxes = plot.axes.filter((a) => a.visible);
  const visibleTraces = plot.traces.filter((t) => t.visible);

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

  const rightAxesCount = visibleAxes.filter((a) => a.orientation === 'right').length;

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
    traceData.set(trace.id, traceLineData(trace, archiveResults.get(trace.id)));
  }

  const option = {
    backgroundColor: effectiveBackground(plot.backgroundColor, theme),
    animation: false,
    grid: {
      top: 40,
      right: rightAxesCount > 0 ? 70 : 20,
      bottom: 60,
      left: 70,
    },
    xAxis: {
      type: 'time',
      min: xAxisMin,
      max: xAxisMax,
      axisLabel: { color: theme.axisLabel, fontSize: 11 },
      axisLine: { lineStyle: { color: theme.axisLine } },
      splitLine: {
        show: plot.showGridlines,
        lineStyle: { color: theme.splitLine },
      },
    },
    yAxis: visibleAxes.map((axis) => ({
      id: axis.id,
      type: axis.logScale ? 'log' : 'value',
      name: axis.name,
      nameTextStyle: { color: theme.axisName, fontSize: 11 },
      position: axis.orientation,
      min: axis.autoScale ? undefined : axis.min,
      max: axis.autoScale ? undefined : axis.max,
      scale: axis.autoScale,
      axisLabel: { color: theme.axisLabel, fontSize: 11 },
      axisLine: { lineStyle: { color: theme.axisLine } },
      splitLine: {
        show: plot.showGridlines,
        lineStyle: { color: theme.splitLine },
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
            name: `${trace.displayName} (min)`,
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
            name: `${trace.displayName} (max)`,
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

        series.push({
          id: trace.id,
          name: trace.displayName,
          type: 'line',
          yAxisIndex,
          data: traceData.get(trace.id) ?? [],
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

        return series;
      });
    })(),
    dataZoom: [
      {
        type: 'inside',
        zoomOnMouseWheel: true,
        moveOnMouseMove: true,
        moveOnMouseWheel: false,
      },
    ],
    tooltip: {
      trigger: 'axis',
      axisPointer: {
        type: 'line',
        snap: false,
        lineStyle: { color: theme.crosshair, width: 1, type: 'dashed' },
        label: { backgroundColor: theme.tooltipBorder },
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
        const time = new Date(cursorMs).toLocaleTimeString();
        const lines: string[] = [];
        for (const trace of visibleTraces) {
          const data = traceData.get(trace.id);
          const sample = data ? nearestSample(data, cursorMs) : undefined;
          const valueCell = sample
            ? `${formatTooltipValue(sample.value)} <span style="color:${theme.tooltipMuted}">(${formatTimeOffset(sample.time - cursorMs)})</span>`
            : `<span style="color:${theme.tooltipMuted}">no data</span>`;
          lines.push(
            `<span style="color:${trace.color}">${trace.displayName}</span>: ${valueCell}`
          );
        }
        return `<div style="font-size:11px"><div style="color:${theme.tooltipMuted};margin-bottom:4px">${time}</div>${lines.join('<br/>')}</div>`;
      },
    },
    legend: {
      bottom: 8,
      textStyle: { color: theme.legend, fontSize: 11 },
      inactiveColor: theme.tooltipMuted,
      data: visibleTraces.map((t) => t.displayName),
    },
  };

  return (
    <ReactECharts
      ref={chartRef}
      option={option}
      replaceMerge={['series', 'yAxis']}
      onEvents={{ datazoom: handleDataZoom }}
      style={{ height: '100%', width: '100%' }}
      opts={{ renderer: 'canvas' }}
    />
  );
}

const EMPTY_RESULTS: Map<string, ArchiveSeriesResult> = new Map();

export function PlotArea({
  plots,
  activePlotId,
  viewMode,
  archiveResultsByPlot,
  onSetActivePlot,
  onAddPlot,
  onRemovePlot,
  onSetViewMode,
  onPopOutPlot,
  detachedPlotIds,
  onDetachPlot,
  onReattachPlot,
  onViewWindowChange,
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
              onViewWindowChange={
                onViewWindowChange ? (w) => onViewWindowChange(activePlot.id, w) : undefined
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
                    onViewWindowChange={
                      onViewWindowChange ? (w) => onViewWindowChange(plot.id, w) : undefined
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
