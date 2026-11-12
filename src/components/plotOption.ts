// The ECharts option of one Trace plot, as a pure function of the plot and its
// data. The chart (SinglePlot) and the Code tab both build it here, so what the
// Code tab prints is what the chart draws.
import { useMemo } from 'react';
import type { LegendComponentOption, TooltipComponentOption } from 'echarts';
import {
  baseChartOption,
  chartAxisStyle,
  formatAxisTick,
  formatValue,
  type ChartTheme,
} from '@slaclab/canopy-charts';
import { isColorLiteral } from '../annotationTheme';
import { effectiveBackground } from '../plotBackground';
import type { Axis, Plot, PVTrace } from '../types';
import type { ArchiveSeriesResult } from '../hooks/useArchiveSeries';
import type { LiveSeriesResult } from '../hooks/useLiveSeries';
import type { FormulaSeriesResult } from '../hooks/useFormulaSeries';
import { archiveErrorNotice } from '../api/archiveErrors';
import { nsToMs, resolveTimeWindow, type TimeWindowNs } from '../api/time';
import { tooltipOption, type ReadoutDock } from '../plot/readoutDock';
import { lowerBound } from '../tools/trace/drawing/snap';
import { LEGEND_MENU_OPTION } from '../tools/contextMenu';
import { echartsLineType, echartsSymbol } from '../curveStyle';
import { axisTitle } from '../embed/plotConfig';
import { traceLabel } from '../traceLabel';
import { AXIS_OFFSET } from './axisHitTest';
import {
  bandLineData,
  extensionAnchor,
  nearestSample,
  traceLineData,
  traceSamples,
  type LinePoint,
} from './traceGaps';
import {
  invalidMarkerSeries,
  invalidStretches,
  isInvalid,
  xAxisLabelMargin,
  type PlotSample,
} from './invalidGaps';

function formatCrosshairTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// Live value in the legend: the latest live value of a curve, at the
// PV's precision and with its units, or null when there is none to show. A
// number is shown as the SDK formats it (`displayValue`): it knows whether the
// PV has a precision, which `precision` (0 when none) cannot tell.
// Formula and archive-only curves have no live value; a disconnected PV (or
// a socket that dropped) keeps its last value in `latest`, which would be
// stale, so it shows none.
function legendValueText(trace: PVTrace, live: LiveSeriesResult | undefined): string | null {
  if (trace.kind === 'formula' || !trace.useLive) return null;
  const v = live?.latest;
  if (!live?.connected || !v?.connected) return null;
  if (typeof v.value === 'number' && Number.isFinite(v.value)) return v.displayValue;
  if (typeof v.value === 'string' || typeof v.value === 'boolean') {
    const text = String(v.value);
    return v.units ? `${text} ${v.units}` : text;
  }
  return null; // waveforms and empty values have no one value to show
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

// The alarm severities a read-out names. Anything else a sample carries (one
// read from a file, say) shows no severity: the tooltip is HTML.
const SHOWN_SEVERITIES: ReadonlySet<string> = new Set(['MINOR', 'MAJOR', 'INVALID']);

// Escape text for interpolation into the tooltip's HTML.
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Alarm colouring: the tint of a live segment whose starting sample is in
// alarm. Chart colours, not chrome, so hex by design (like chartTheme's): the
// conventional EPICS reading of yellow for MINOR and red for MAJOR, legible on
// both chart backgrounds. INVALID samples are not tinted: the line breaks at
// them and a marker under the axis shows the stretch (invalidGaps.ts).
export type AlarmTint = 'MINOR' | 'MAJOR';
export const ALARM_TINTS: Readonly<Record<AlarmTint, string>> = {
  MINOR: '#f1c21b',
  MAJOR: '#da1e28',
};
const ALARM_ORDER: readonly AlarmTint[] = ['MINOR', 'MAJOR'];

/**
 * The tinted runs of `points` per severity, as line data with a null marker
 * ending each run. Segment i (points[i] to points[i + 1]) takes the severity
 * of the live sample at points[i]: with `step: 'end'` that is the value it
 * draws. Points with no live sample (archive, gap markers) are untinted and
 * keep the curve colour; so is the last point, which starts no segment.
 */
function alarmRuns(
  points: readonly LinePoint[],
  live: LiveSeriesResult | undefined
): Map<AlarmTint, LinePoint[]> {
  const runs = new Map<AlarmTint, LinePoint[]>();
  if (!live || live.points.length === 0) return runs;
  const severityAt = new Map<number, string>();
  for (const p of live.points) severityAt.set(p.time, p.severity);
  let open: AlarmTint | null = null;
  for (let i = 0; i < points.length; i++) {
    const here = points[i];
    const next = points[i + 1];
    const sev = severityAt.get(here[0]);
    const tint: AlarmTint | null =
      next !== undefined &&
      here[1] !== null &&
      next[1] !== null &&
      (sev === 'MINOR' || sev === 'MAJOR')
        ? sev
        : null;
    if (open !== null && open !== tint) {
      // The previous run ended at `here`; break its line there.
      runs.get(open)!.push([here[0], null]);
      open = null;
    }
    if (tint === null) continue;
    let run = runs.get(tint);
    if (!run) runs.set(tint, (run = []));
    if (open !== tint) run.push(here);
    run.push(next!);
    open = tint;
  }
  return runs;
}

// Grid insets shared by the option builder and the per-axis hit-zones, so the
// pointer listeners hit-test against the exact numbers ECharts lays out with.
export const GRID_TOP = 40;
export const GRID_BOTTOM = 60;
// Gap between a pinned tooltip and the grid's top-right corner.
const PIN_INSET = 8;

export interface PlotLayout {
  /** ECharts links series to axes by index: yAxis slot per visible axis id. */
  axisIndexMap: Map<string, number>;
  /** Position of each visible axis among the axes on its side (left/right). */
  sideIndexMap: Map<string, number>;
  gridTop: number;
  gridBottom: number;
  gridLeft: number;
  gridRight: number;
}

/** Axis slots and grid insets for a plot's visible axes, in panel order. */
export function plotLayout(visibleAxes: readonly Axis[]): PlotLayout {
  const axisIndexMap = new Map<string, number>();
  visibleAxes.forEach((axis, idx) => {
    axisIndexMap.set(axis.id, idx);
  });

  // Axes sharing a side (left/right) would otherwise stack at the same spot and
  // overlap, so we offset each one outward by its position within that side.
  const sideIndexMap = new Map<string, number>();
  let leftAxesCount = 0;
  let rightAxesCount = 0;
  for (const axis of visibleAxes) {
    if (axis.orientation === 'right') sideIndexMap.set(axis.id, rightAxesCount++);
    else sideIndexMap.set(axis.id, leftAxesCount++);
  }

  return {
    axisIndexMap,
    sideIndexMap,
    gridTop: GRID_TOP,
    gridBottom: GRID_BOTTOM,
    gridLeft: 70 + Math.max(0, leftAxesCount - 1) * AXIS_OFFSET,
    gridRight: (rightAxesCount > 0 ? 70 : 20) + Math.max(0, rightAxesCount - 1) * AXIS_OFFSET,
  };
}

export interface PlotOptionInput {
  plot: Plot;
  archiveResults: ReadonlyMap<string, ArchiveSeriesResult>;
  liveResults: ReadonlyMap<string, LiveSeriesResult>;
  formulaResults: ReadonlyMap<string, FormulaSeriesResult>;
  theme: Readonly<ChartTheme>;
  /** Chart text family; undefined until the host font has loaded. */
  fontFamily?: string;
  /**
   * The visible window the x axis spans. Given, every series is also cut to it
   * (plus one neighbour sample each side) so auto-scaled Y axes fit what is on
   * screen; absent (the Code tab) the axis spans the configured range and the
   * data is printed whole.
   */
  viewWindow?: TimeWindowNs;
  /**
   * Where the configured range ends when no `viewWindow` is given (epoch ms);
   * absent, the current time.
   */
  endMs?: number;
  /**
   * Precomputed per-trace line data (see `computeTraceData`). SinglePlot
   * memoizes it once per result change and passes it in; absent (the Code
   * tab, pure tests) the builder computes it itself, with identical output.
   */
  traceData?: TraceDataMap;
  /** Precomputed per-trace samples (see `computeTraceSamples`), the same way. */
  samples?: TraceSampleMap;
  /**
   * The plot's read-out dock: the tooltip docks in a free corner of the plot
   * and its grip moves it. Absent (the Code tab, pure tests) the tooltip
   * follows the cursor, or keeps the top-right corner while pinned.
   */
  readoutDock?: ReadoutDock;
}

/**
 * Per-trace `[time, value]` arrays keyed by trace id, covering the visible
 * traces. Sorted ascending by time; `[t, null]` entries are gap markers (see
 * traceGaps.ts). The chart series and the drawing overlay read the same map.
 */
export type TraceDataMap = ReadonlyMap<string, LinePoint[]>;

/**
 * Per-trace samples keyed by trace id, INVALID ones included with their
 * severity (traceGaps.ts `traceSamples`). The tooltip and the INVALID markers
 * read it.
 */
export type TraceSampleMap = ReadonlyMap<string, readonly PlotSample[]>;

/** The line data of every visible trace of `traces`, from the result maps. */
export function computeTraceData(
  traces: readonly PVTrace[],
  archiveResults: ReadonlyMap<string, ArchiveSeriesResult>,
  liveResults: ReadonlyMap<string, LiveSeriesResult>,
  formulaResults: ReadonlyMap<string, FormulaSeriesResult>
): TraceDataMap {
  const traceData = new Map<string, LinePoint[]>();
  for (const trace of traces) {
    if (!trace.visible) continue;
    traceData.set(
      trace.id,
      traceLineData(
        trace,
        archiveResults.get(trace.id),
        liveResults.get(trace.id),
        formulaResults.get(trace.id)
      )
    );
  }
  return traceData;
}

/** The samples of every visible trace of `traces`, from the result maps. */
export function computeTraceSamples(
  traces: readonly PVTrace[],
  archiveResults: ReadonlyMap<string, ArchiveSeriesResult>,
  liveResults: ReadonlyMap<string, LiveSeriesResult>,
  formulaResults: ReadonlyMap<string, FormulaSeriesResult>
): TraceSampleMap {
  const out = new Map<string, readonly PlotSample[]>();
  for (const trace of traces) {
    if (!trace.visible) continue;
    out.set(
      trace.id,
      traceSamples(
        trace,
        archiveResults.get(trace.id),
        liveResults.get(trace.id),
        formulaResults.get(trace.id)
      )
    );
  }
  return out;
}

/** `computeTraceSamples`, memoized like `useTraceData`. */
export function useTraceSamples(
  traces: readonly PVTrace[],
  archiveResults: ReadonlyMap<string, ArchiveSeriesResult>,
  liveResults: ReadonlyMap<string, LiveSeriesResult>,
  formulaResults: ReadonlyMap<string, FormulaSeriesResult>
): TraceSampleMap {
  return useMemo(
    () => computeTraceSamples(traces, archiveResults, liveResults, formulaResults),
    [traces, archiveResults, liveResults, formulaResults]
  );
}

/**
 * `computeTraceData`, memoized on the trace list and the three result maps:
 * the same Map instance comes back while none of them changes, so a re-render
 * for an unrelated reason (hover, width, font) does not recompute the lines.
 */
export function useTraceData(
  traces: readonly PVTrace[],
  archiveResults: ReadonlyMap<string, ArchiveSeriesResult>,
  liveResults: ReadonlyMap<string, LiveSeriesResult>,
  formulaResults: ReadonlyMap<string, FormulaSeriesResult>
): TraceDataMap {
  return useMemo(
    () => computeTraceData(traces, archiveResults, liveResults, formulaResults),
    [traces, archiveResults, liveResults, formulaResults]
  );
}

// A step line's hold point: not a sample, so it never draws a symbol.
interface HoldPoint {
  value: [number, number];
  symbol: 'none';
}

type SeriesData = Float64Array | (LinePoint | HoldPoint)[];

/**
 * Series data for line points. Without a break it is a flat
 * [t0, v0, t1, v1, ...] typed array, which ECharts treats as primitive data:
 * setOption neither deep-clones it nor runs each point through its option
 * preprocessors. With breaks it stays point data, and a step line (`hold`)
 * first holds its last value up to each break, so the step reaches the gap.
 */
function toSeriesData(points: readonly LinePoint[], hold: boolean): SeriesData {
  if (!points.some((p) => p[1] === null)) {
    const out = new Float64Array(points.length * 2);
    for (let i = 0; i < points.length; i++) {
      out[2 * i] = points[i][0];
      out[2 * i + 1] = points[i][1] as number;
    }
    return out;
  }
  if (!hold) return points as LinePoint[];
  const out: (LinePoint | HoldPoint)[] = [];
  let prev: number | null = null;
  for (const p of points) {
    if (p[1] === null && prev !== null) out.push({ value: [p[0], prev], symbol: 'none' });
    out.push(p);
    prev = p[1];
  }
  return out;
}

// The last series data built from each line array (they are replaced, not
// mutated, when their samples change), with the cut it was built for.
const seriesCache = new WeakMap<
  readonly LinePoint[],
  { start: number; end: number; hold: boolean; data: SeriesData }
>();

/**
 * Series data for `data` cut to [fromMs, toMs] plus one neighbour sample on
 * each side, so the line still runs to both plot edges and auto-scaled Y axes
 * fit what is on screen. Binary search over the sorted line; gap markers
 * inside the cut are kept. While neither the samples nor the cut change, the
 * same data object comes back, so a plot that scrolls between samples (a
 * following plot moves its window on animation frames) costs ECharts no
 * series rebuild. No window: the whole line.
 */
// The bounds of `data` cut to the window plus one neighbour each side.
function cutBounds(
  data: readonly LinePoint[],
  window?: { fromMs: number; toMs: number }
): [number, number] {
  if (!window) return [0, data.length];
  return [
    Math.max(0, lowerBound(data, window.fromMs, false) - 1),
    Math.min(data.length, lowerBound(data, window.toMs, true) + 1),
  ];
}

function cutLine(
  data: readonly LinePoint[],
  window?: { fromMs: number; toMs: number }
): readonly LinePoint[] {
  const [start, end] = cutBounds(data, window);
  return start === 0 && end === data.length ? data : data.slice(start, end);
}

function seriesData(
  data: readonly LinePoint[],
  hold: boolean,
  window?: { fromMs: number; toMs: number }
): SeriesData {
  const [start, end] = cutBounds(data, window);
  const cached = seriesCache.get(data);
  if (cached && cached.start === start && cached.end === end && cached.hold === hold) {
    return cached.data;
  }
  const built = toSeriesData(
    start === 0 && end === data.length ? data : data.slice(start, end),
    hold
  );
  seriesCache.set(data, { start, end, hold, data: built });
  return built;
}

/**
 * The ECharts option of one time plot. The chart and the Code tab both call
 * this, so what the Code tab prints is what the chart draws.
 */
export function buildPlotOption({
  plot,
  archiveResults,
  liveResults,
  formulaResults,
  theme,
  fontFamily,
  viewWindow,
  endMs,
  traceData: precomputed,
  samples: precomputedSamples,
  readoutDock,
}: PlotOptionInput) {
  const visibleAxes = plot.axes.filter((a) => a.visible);
  const visibleTraces = plot.traces.filter((t) => t.visible);
  const labels = new Map(plot.traces.map((t) => [t.id, traceLabel(t, plot.traces)]));
  const { axisIndexMap, sideIndexMap, gridLeft, gridRight } = plotLayout(visibleAxes);

  // Pin the x-axis extent to the view window (it owns the visible range) so
  // the axis spans it even when archive data is sparse and clusters in a
  // sub-range. Without one (the Code tab) it is the configured range.
  const shown = viewWindow ?? resolveTimeWindow(plot.xAxis, endMs ?? Date.now()).window;
  const xAxisMin = nsToMs(shown.fromNs);
  const xAxisMax = nsToMs(shown.toNs);
  // The series data, cut to the view window when one is given; the tooltip
  // keeps reading the full samples.
  const cut = viewWindow ? { fromMs: xAxisMin, toMs: xAxisMax } : undefined;

  // Per-trace [time, value] arrays, computed once; series rendering and the
  // tooltip formatter both read from this map. SinglePlot passes its memoized
  // copy; other callers (the Code tab) get it computed here.
  const traceData =
    precomputed ?? computeTraceData(plot.traces, archiveResults, liveResults, formulaResults);
  const samples =
    precomputedSamples ??
    computeTraceSamples(plot.traces, archiveResults, liveResults, formulaResults);

  // Order traces by axis (in panel order) then by their position within each
  // axis. Earlier axis / earlier trace draws on top — assign higher `z` values
  // to those, and pin the order with `emphasis.disabled` so hover doesn't
  // shuffle the depth.
  const orderedTraces: PVTrace[] = [];
  for (const axis of visibleAxes) {
    for (const trace of visibleTraces) {
      if (trace.axisId === axis.id) orderedTraces.push(trace);
    }
  }

  // INVALID stretches per trace, and the marker lane each trace draws them in.
  // Only drawn traces take a lane, in draw order, so a trace on a hidden axis
  // doesn't push the drawn ones into the shared last lane. Stretches outside
  // the window take none, and an open one runs to the right edge.
  const invalidByTrace = new Map<string, { stretches: [number, number][]; lane: number }>();
  for (const trace of orderedTraces) {
    const traceSamples = samples.get(trace.id) ?? [];
    if (!traceSamples.some(isInvalid)) continue;
    const stretches = invalidStretches(traceSamples, xAxisMin, xAxisMax);
    if (stretches.length > 0)
      invalidByTrace.set(trace.id, { stretches, lane: invalidByTrace.size });
  }

  // Legend label -> live value text; empty when the toggle is off.
  const legendValues = new Map<string, string>();
  if (plot.showLegendValue === true) {
    for (const trace of visibleTraces) {
      const text = legendValueText(trace, liveResults.get(trace.id));
      const label = labels.get(trace.id);
      if (text !== null && label !== undefined) legendValues.set(label, text);
    }
  }

  // Shared Canopy chart styling from canopy-charts: animation off and themed
  // axes, tooltip and legend. Trace layers its own layout and content on top.
  // canopy-charts names its font in every text slot; canvas text does not
  // inherit CSS, so Trace names the family its wrapper computes instead, and
  // only once that family has loaded (`fontFamily`, undefined until then):
  // the option changes exactly when the face is ready, so the chart redraws
  // with it.
  const base = baseChartOption(theme);
  const baseTooltip = base.tooltip as TooltipComponentOption;
  const baseLegend = base.legend as LegendComponentOption;
  const axisStyle = chartAxisStyle(theme);
  const axisLabel = { ...axisStyle.axisLabel, fontFamily };
  const nameTextStyle = { ...axisStyle.nameTextStyle, fontFamily };

  return {
    ...base,
    backgroundColor: effectiveBackground(plot.backgroundColor, theme),
    textStyle: { ...(base.textStyle as object), fontFamily },
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
      nameTextStyle,
      // ECharts keeps its time-tick spacing however narrow the chart is (e.g.
      // grid cells), so drop labels that would overlap rather than run together.
      axisLabel: {
        ...axisLabel,
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
      name: axisTitle(axis),
      ...axisStyle,
      nameTextStyle: { ...nameTextStyle, fontSize: 11 },
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
      axisLabel: { ...axisLabel, fontSize: plot.tickFontSize, formatter: formatAxisTick },
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
    series: (() => {
      const total = orderedTraces.length;
      return orderedTraces.flatMap((trace, i) => {
        const yAxisIndex = axisIndexMap.get(trace.axisId) ?? 0;
        const archive = archiveResults.get(trace.id);
        const baseZ = (total - i) * 10;
        const step = trace.lineType === 'step';
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
          // Same gap and INVALID rules as the mean, so the band breaks at the same t.
          const bandData = bandLineData(archive.band);
          series.push({
            id: `${trace.id}-band-min`,
            name: `${labels.get(trace.id)} (min)`,
            type: 'line',
            yAxisIndex,
            data: seriesData(bandData.min, step, cut),
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
            data: seriesData(bandData.max, step, cut),
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

        const fullPoints = traceData.get(trace.id) ?? [];
        series.push({
          id: trace.id,
          name: labels.get(trace.id),
          type: 'line',
          yAxisIndex,
          data: seriesData(fullPoints, step, cut),
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

        const invalid = invalidByTrace.get(trace.id);
        if (invalid) {
          series.push(
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

        // Alarm colouring: one overlay per severity drawn over the curve,
        // so only the in-alarm live segments change colour. Off restores the
        // curve colour by emitting nothing. Formula curves carry no severity.
        if (
          trace.alarmColoring === true &&
          trace.kind !== 'formula' &&
          trace.useLive &&
          trace.lineStyle !== 'none'
        ) {
          const runs = alarmRuns(cutLine(fullPoints, cut), liveResults.get(trace.id));
          for (const severity of ALARM_ORDER) {
            const data = runs.get(severity);
            if (!data) continue;
            series.push({
              id: `${trace.id}-alarm-${severity}`,
              name: `${labels.get(trace.id)} (${severity})`,
              type: 'line',
              yAxisIndex,
              data,
              step: step ? 'end' : false,
              lineStyle: {
                color: ALARM_TINTS[severity],
                width: trace.lineWidth,
                type: echartsLineType(trace.lineStyle),
              },
              itemStyle: { color: ALARM_TINTS[severity] },
              symbol: 'none',
              showSymbol: false,
              showInLegend: false,
              tooltip: { show: false },
              silent: true,
              animation: false,
              z: baseZ + 2,
              emphasis: { disabled: true },
            });
          }
        }

        if (trace.showExtensionLine !== false && trace.lineStyle !== 'none') {
          // Anchors on the last non-null point; none while a live trace is
          // disconnected, an archive-only tail is stale or the curve ends
          // INVALID (traceGaps.ts). The x axis spans exactly the window, so
          // the line's two ends are its whole data.
          const last = extensionAnchor(trace, fullPoints, archive, liveResults.get(trace.id));
          if (last && last[0] < xAxisMax) {
            const startTime = Math.max(last[0], xAxisMin);
            const data = new Float64Array([startTime, last[1], xAxisMax, last[1]]);
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
    tooltip: {
      ...baseTooltip,
      // The strip's tooltip toggle hides the read-out box only, so the
      // crosshair keeps working. Always set: the option is merged, so an
      // absent key would keep the last value.
      showContent: plot.showTooltip !== false,
      trigger: 'axis',
      // Pin data window: a fixed spot at the grid's top-right instead of
      // following the cursor. Always set, even when off: the tooltip is
      // merged, not replaced, so an absent key would keep a stale pin.
      ...(readoutDock ? tooltipOption(readoutDock) : {}),
      position: readoutDock
        ? readoutDock.position
        : plot.pinDataWindow === true
          ? (
              _point: unknown,
              _params: unknown,
              _dom: unknown,
              _rect: unknown,
              size: { contentSize: number[]; viewSize: number[] }
            ): [number, number] => [
              Math.max(0, size.viewSize[0] - gridRight - size.contentSize[0] - PIN_INSET),
              GRID_TOP + PIN_INSET,
            ]
          : undefined,
      axisPointer: {
        ...baseTooltip.axisPointer,
        type: plot.showCrosshair ? 'cross' : 'none', // 'cross' adds Y-axis readout; 'none' hides crosshair but keeps tooltip
        snap: false,
        label: {
          ...baseTooltip.axisPointer?.label,
          formatter: (
            p: { value: number; axisDimension?: string } // X --> timestamp, Y --> raw value
          ) => (p.axisDimension === 'y' ? formatValue(p.value) : formatCrosshairTime(p.value)),
        },
      },
      textStyle: { ...baseTooltip.textStyle, fontFamily, fontSize: 11 },
      // Walk every visible trace ourselves rather than trusting `params`. With
      // snap: false, ECharts only includes series that have a sample exactly
      // under the cursor — sparse archive data leaves most traces out. The
      // closure captures `samples` and `visibleTraces` from the surrounding
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
          const data = samples.get(trace.id);
          const sample = data ? nearestSample(data, cursorMs) : undefined;
          // An INVALID value isn't plotted, but the read-out still shows it.
          const severity =
            sample?.severity !== undefined && SHOWN_SEVERITIES.has(sample.severity)
              ? ` ${sample.severity}`
              : '';
          const valueCell = sample
            ? `${escapeHtml(formatValue(sample.value))}${severity} <span style="color:${theme.tooltipMuted}">(${formatTimeOffset(sample.time - cursorMs)})</span>`
            : `<span style="color:${theme.tooltipMuted}">no data</span>`;
          // The tooltip is HTML: escape the label (PV names and display names are
          // user text) and the value, name only a known severity, and use the
          // color only when it is a plain color literal.
          const label = escapeHtml(labels.get(trace.id) ?? '');
          const swatch = isColorLiteral(trace.color) ? ` style="color:${trace.color}"` : '';
          lines.push(`<span${swatch}>${label}</span>: ${valueCell}`);
        }
        return `<div style="font-size:11px"><div style="color:${theme.tooltipMuted};margin-bottom:4px">${time}</div>${lines.join('<br/>')}</div>`;
      },
    },
    legend: {
      ...baseLegend,
      show: plot.showLegend,
      bottom: 8,
      textStyle: { ...baseLegend.textStyle, fontFamily, fontSize: 11 },
      data: visibleTraces.map((t) => labels.get(t.id)),
      // Always set, even when off: the legend is merged, not replaced, so an
      // absent formatter would leave the last one (and its stale values) on.
      formatter: (name: string) => {
        const value = legendValues.get(name);
        return value === undefined ? name : `${name}: ${value}`;
      },
      // Selectable only so a right-click reaches an entry (its curve's menu);
      // a left-click toggles nothing, as trace.visible is the Outline eye's.
      ...LEGEND_MENU_OPTION,
    },
  };
}

export type PlotOption = ReturnType<typeof buildPlotOption>;

/**
 * The lines of the not-archived notice, one per PV with its code's text
 * (`archiveErrorNotice`): every visible curve's archive result is a
 * not-archived error and no live sample is plotted. Any other state (a curve
 * with data, still loading, a different error, a formula curve, live points on
 * screen) returns none, so the notice only ever replaces an otherwise blank
 * chart.
 */
export function notArchivedPvs(
  plot: Plot,
  archiveResults: Map<string, ArchiveSeriesResult>,
  liveResults: Map<string, LiveSeriesResult>
): { pv: string; notice: string }[] {
  const visible = plot.traces.filter((t) => t.visible);
  if (visible.length === 0) return [];
  const lines: { pv: string; notice: string }[] = [];
  for (const trace of visible) {
    const result = archiveResults.get(trace.id);
    const notice = result?.status === 'error' ? archiveErrorNotice(result.error?.code) : undefined;
    if (notice === undefined) return [];
    if (trace.useLive && (liveResults.get(trace.id)?.points.length ?? 0) > 0) return [];
    if (!lines.some((l) => l.pv === trace.pvName)) lines.push({ pv: trace.pvName, notice });
  }
  return lines;
}
