// The correlation chart's ECharts option: scatter or density
// series with their fit lines, laid out by the Y layout (`axes`). Pure, so the
// option is rebuilt only when its inputs change (Plot.tsx memoizes it).
// Colours by PV (colors.ts `yColorMap`), per-Y markers, the fit
// toggle, legend/grid/crosshair fields and the section axis scales. Hidden Ys
// are not drawn and the legend is not clickable — the Outline eye is
// visibility's one home.
// Fade older points draws each Y as FADE_BUCKETS age buckets,
// one scatter series per bucket with one opacity step, in large mode at every n.

import { tooltipOption, type ReadoutDock } from '../../plot/readoutDock';
import type { EChartsOption, SeriesOption } from 'echarts';
import {
  DEFAULT_MARKER,
  type CorrelationAxes,
  type CorrelationAxisScale,
  type CorrelationMarker,
  type CorrelationView,
} from './query';
import { densitySeries, hexBin } from './Density';
import { fitStats, yColumns, type FrameLike, type PairStats } from './stats';
import type { AxisPlacement } from '../../plot/geometry';
import { LEGEND_MENU_OPTION, quietLegendHover } from '../contextMenu';
import { autoYColor } from '../shared/colors';
import type { ChartDrawingTheme } from '../../annotationTheme';

function scatterPoints(xCells: (number | null)[], yCells: (number | null)[]): [number, number][] {
  const out: [number, number][] = [];
  const len = Math.min(xCells.length, yCells.length);
  for (let i = 0; i < len; i++) {
    const x = xCells[i];
    const y = yCells[i];
    if (x !== null && y !== null) out.push([x, y]);
  }
  return out;
}

/** Age buckets per Y when Fade older points is on. */
export const FADE_BUCKETS = 5;

// Splits a Y's rows into FADE_BUCKETS age buckets on the data clock (`tsNs`):
// the frame's time span is cut into equal slices, oldest first, so the last
// bucket holds the newest rows. Rows are bucketed by index before null cells
// are dropped, so every drawn point lands in exactly one bucket.
function fadeBuckets(
  tsNs: readonly number[],
  xCells: (number | null)[],
  yCells: (number | null)[]
): [number, number][][] {
  const buckets: [number, number][][] = Array.from({ length: FADE_BUCKETS }, () => []);
  const len = Math.min(xCells.length, yCells.length);
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < len; i++) {
    const t = tsNs[i];
    if (t === undefined || !Number.isFinite(t)) continue;
    if (t < min) min = t;
    if (t > max) max = t;
  }
  const span = max - min;
  for (let i = 0; i < len; i++) {
    const x = xCells[i];
    const y = yCells[i];
    if (x === null || y === null) continue;
    const t = tsNs[i];
    // No usable span (one timestamp, or none): everything is newest.
    const k =
      span > 0 && t !== undefined && Number.isFinite(t)
        ? Math.min(FADE_BUCKETS - 1, Math.floor(((t - min) / span) * FADE_BUCKETS))
        : FADE_BUCKETS - 1;
    buckets[k].push([x, y]);
  }
  return buckets;
}

/** Bucket k's opacity: steps up from the oldest to fully opaque for the newest. */
function fadeOpacity(k: number): number {
  return (k + 1) / FADE_BUCKETS;
}

function axisName(pv: string | undefined, units: string): string {
  if (pv === undefined) return units;
  return units === '' ? pv : `${pv} [${units}]`;
}

/** The last two `:` segments of a PV (`SIM:RF:CAVITY:01:POWER:REV` → `POWER:REV`). */
export function shortPv(pv: string): string {
  const parts = pv.split(':');
  return parts.length > 2 ? parts.slice(-2).join(':') : pv;
}

/** The chart's floor; it otherwise fills its box. */
export const PLOT_MIN_HEIGHT = 240;
/** The height the split layout assumes for one row of panels. */
export const PLOT_HEIGHT = 420;
const SHARED_GRID = { left: 80, right: 24, top: 36, bottom: 56 };
/** Room each extra right-hand Y axis takes in the overlay layout. */
export const OVERLAY_AXIS_WIDTH = 64;
// Split layout, in px: panels under the legend, each with a title line.
const SPLIT_TOP = 32;
const SPLIT_TITLE = 20;
const SPLIT_LEFT = 64;
const SPLIT_RIGHT = 16;
const SPLIT_BOTTOM = 50;
const SPLIT_ROW_HEIGHT = 260;
/** Narrowest panel before the split layout wraps into another row. */
const SPLIT_MIN_PANEL_WIDTH = 300;
/** Width assumed before the chart is measured (and in tests). */
const FALLBACK_WIDTH = 900;

export interface SplitGeometry {
  columns: number;
  rows: number;
  rowHeight: number;
  /** Chart height in px. */
  height: number;
}

// One panel per Y: as many columns as fit the width, balanced across rows
// (5 panels that fit 4 a row go 3 + 2). One row keeps the usual plot height.
export function splitGeometry(count: number, width: number): SplitGeometry {
  const n = Math.max(1, count);
  const fit = Math.max(1, Math.floor((width > 0 ? width : FALLBACK_WIDTH) / SPLIT_MIN_PANEL_WIDTH));
  const rows = Math.ceil(n / Math.min(n, fit));
  const columns = Math.ceil(n / rows);
  const rowHeight = rows === 1 ? PLOT_HEIGHT - SPLIT_TOP - 4 : SPLIT_ROW_HEIGHT;
  return { columns, rows, rowHeight, height: SPLIT_TOP + rows * rowHeight + 4 };
}

// The X extent over all rows, so every split panel shows the same X range.
function xExtent(xCells: (number | null)[]): { min: number; max: number } | null {
  let min = Infinity;
  let max = -Infinity;
  for (const x of xCells) {
    if (x === null || !Number.isFinite(x)) continue;
    if (x < min) min = x;
    if (x > max) max = x;
  }
  return min <= max ? { min, max } : null;
}

function fitLine(
  fit: PairStats | undefined,
  name: string,
  color: string,
  axes: { xAxisIndex?: number; yAxisIndex?: number }
): SeriesOption | null {
  if (!fit || fit.slope === null || fit.intercept === null) return null;
  if (fit.xMin === null || fit.xMax === null) return null;
  return {
    type: 'line',
    name,
    silent: true,
    showSymbol: false,
    color,
    lineStyle: { width: 1.5 },
    tooltip: { show: false },
    ...axes,
    data: [
      [fit.xMin, fit.intercept + fit.slope * fit.xMin],
      [fit.xMax, fit.intercept + fit.slope * fit.xMax],
    ],
  };
}

// A section axis scale as ECharts axis fields: `log` switches the axis type;
// `min`/`max` apply only once Auto-scale is off (`auto: false`).
function scaleFields(s: CorrelationAxisScale | undefined): {
  type: 'value' | 'log';
  min?: number;
  max?: number;
} {
  const fixed = s?.auto === false;
  return {
    type: s?.log === true ? 'log' : 'value',
    ...(fixed && s?.min !== undefined ? { min: s.min } : {}),
    ...(fixed && s?.max !== undefined ? { max: s.max } : {}),
  };
}

function markerFields(m: CorrelationMarker | undefined) {
  return {
    symbol: m?.shape ?? DEFAULT_MARKER.shape,
    symbolSize: m?.size ?? DEFAULT_MARKER.size,
    itemStyle: { opacity: m?.opacity ?? DEFAULT_MARKER.opacity },
  };
}

export interface PlotOptionInput {
  frame: FrameLike | null;
  view: CorrelationView;
  axes: CorrelationAxes;
  densityPv: string;
  unitsOf: (pv: string) => string;
  theme: ChartDrawingTheme;
  /** Hidden Y PVs; they are not drawn. */
  hidden: ReadonlySet<string>;
  /** Chart width in px (0 when not measured); places the split panels. */
  width: number;
  /** PV -> colour (colors.ts `yColorMap`); a PV absent from it takes its frame position's automatic colour. */
  colors?: ReadonlyMap<string, string>;
  /** Pinned marker fields by Y PV; absent fields draw `DEFAULT_MARKER`. */
  markers?: Readonly<Record<string, CorrelationMarker>>;
  /** Draw the fit lines; default true. */
  fit?: boolean;
  /** Show the legend; default true. */
  legend?: boolean;
  /** X/Y gridlines; default true. */
  grid?: boolean;
  /** Crosshair axis pointers; default false. */
  crosshair?: boolean;
  /** The hover read-out (the chart tooltip box); default true. */
  tooltip?: boolean;
  /** The X axis scale; absent = automatic. */
  xScale?: CorrelationAxisScale;
  /** The scale of every Y axis; absent = automatic. */
  yScale?: CorrelationAxisScale;
  /** Fade older points: each Y as FADE_BUCKETS age-bucket series; default false. Density ignores it. */
  fade?: boolean;
  /** The read-out dock (the canvas's): the tooltip docks in a free corner and its grip moves it. */
  readoutDock?: ReadoutDock;
}

/** What decides which axis a Y is drawn on: the frame, the view, the layout and the hidden Ys. */
export type CorrelationAxisInput = Pick<
  PlotOptionInput,
  'frame' | 'view' | 'axes' | 'densityPv' | 'hidden'
>;

/** The Ys the chart draws, indexed the way the option indexes its axes and grids. */
export interface VisibleYs {
  /** Visible Y columns, in frame (colour) order. */
  columns: string[];
  /** Their PVs; index i is overlay y axis i and split grid i. */
  pvs: string[];
  /** The layout drawn: the density view is always shared. */
  layout: CorrelationAxes;
  /** Index in `pvs` of the Y the density view draws. */
  densityIndex: number;
}

/**
 * The density view's Y among visible `pvs`: `densityPv` when visible, else the
 * first visible Y; undefined with none. The one density fallback.
 */
export function densityYOf(pvs: readonly string[], densityPv: string): string | undefined {
  return pvs[Math.max(0, pvs.indexOf(densityPv))];
}

/**
 * The visible-Y column list `plotOption` indexes: the frame's Y columns
 * without hidden Ys, the drawn layout, and the density Y's index.
 */
export function visibleYs({
  frame,
  view,
  axes,
  densityPv,
  hidden,
}: CorrelationAxisInput): VisibleYs {
  const columnPvs = frame?.columnPvs ?? {};
  const columns = yColumns(columnPvs).filter((c) => !hidden.has(columnPvs[c]));
  const pvs = columns.map((c) => columnPvs[c]);
  return {
    columns,
    pvs,
    layout: view === 'density' ? 'shared' : axes,
    densityIndex: Math.max(0, pvs.indexOf(densityPv)),
  };
}

/**
 * Where Y `pv` is drawn in the option `plotOption(input)` builds, or null
 * when it is not drawn (hidden, absent from the frame, or not the density Y):
 * - shared: grid, x axis and y axis 0
 * - overlay: y axis i over the visible Ys, grid and x axis 0
 * - split: grid, x axis and y axis i over the visible Ys
 * - density: only the density Y maps, to 0
 */
export function correlationAxisPlacement(
  input: CorrelationAxisInput,
  pv: string
): AxisPlacement | null {
  const { pvs, layout, densityIndex } = visibleYs(input);
  const i = pvs.indexOf(pv);
  if (i < 0) return null;
  if (input.view === 'density') {
    return i === densityIndex ? { gridIndex: 0, xAxisIndex: 0, yAxisIndex: 0 } : null;
  }
  if (layout === 'split') return { gridIndex: i, xAxisIndex: i, yAxisIndex: i };
  if (layout === 'overlay') return { gridIndex: 0, xAxisIndex: 0, yAxisIndex: i };
  return { gridIndex: 0, xAxisIndex: 0, yAxisIndex: 0 };
}

// The chart option. The legend's selection is part of it: the chart is set
// with `notMerge`, so a selection left out would be reset on every frame.
// The density view always draws on one shared axis pair; `axes` lays
// out the scatter only.
export function plotOption({
  frame,
  view,
  axes,
  densityPv,
  unitsOf,
  theme,
  hidden,
  width,
  colors,
  markers = {},
  fit = true,
  legend = true,
  grid = true,
  crosshair = false,
  tooltip = true,
  xScale,
  yScale,
  fade = false,
  readoutDock,
}: PlotOptionInput): EChartsOption {
  const columnPvs = frame?.columnPvs ?? {};
  const allPvs = yColumns(columnPvs).map((c) => columnPvs[c]);
  const colorOf = (pv: string): string =>
    colors?.get(pv) ?? autoYColor(Math.max(0, allPvs.indexOf(pv)));
  // Hidden Ys are not drawn: no series, no axis, no panel.
  const {
    columns: ys,
    pvs,
    layout,
    densityIndex,
  } = visibleYs({
    frame,
    view,
    axes,
    densityPv,
    hidden,
  });
  const xCells = frame?.table.columns.x ?? [];
  const statsByColumn = new Map(fitStats(frame).ys.map((row) => [row.column, row.stats]));
  const series: SeriesOption[] = [];

  ys.forEach((column, i) => {
    if (view === 'density' && i !== densityIndex) return;
    const pv = columnPvs[column];
    const yCells = frame?.table.columns[column] ?? [];
    const color = colorOf(pv);
    const on =
      layout === 'split'
        ? { xAxisIndex: i, yAxisIndex: i }
        : layout === 'overlay'
          ? { yAxisIndex: i }
          : {};
    if (view === 'density') {
      series.push(densitySeries(hexBin(xCells, yCells), pv, color));
    } else if (fade) {
      const marker = markerFields(markers[pv]);
      fadeBuckets(frame?.table.tsNs ?? [], xCells, yCells).forEach((data, k) => {
        series.push({
          type: 'scatter',
          name: pv,
          // Large mode at every n: one style per series is what the buckets assume.
          large: true,
          largeThreshold: 1,
          color,
          ...marker,
          itemStyle: { opacity: fadeOpacity(k) },
          ...on,
          data,
        });
      });
    } else {
      series.push({
        type: 'scatter',
        name: pv,
        large: true,
        color,
        ...markerFields(markers[pv]),
        ...on,
        data: scatterPoints(xCells, yCells),
      });
    }
    if (!fit) return;
    const line = fitLine(statsByColumn.get(column), pv, color, on);
    if (line) series.push(line);
  });

  const splitLine = { show: grid, lineStyle: { color: theme.splitLine } };
  const axisPointer = { show: crosshair, type: 'line' as const, snap: false };
  const axisStyle = {
    axisLabel: { color: theme.axisLabel },
    axisLine: { lineStyle: { color: theme.axisLine } },
    splitLine,
    nameTextStyle: { color: theme.axisName },
  };
  const xScaleFields = scaleFields(xScale);
  const yScaleFields = scaleFields(yScale);
  const xName = axisName(columnPvs.x, columnPvs.x === undefined ? '' : unitsOf(columnPvs.x));
  const xAxisBase = {
    scale: true,
    name: xName,
    nameLocation: 'middle' as const,
    nameGap: 30,
    axisPointer,
    ...axisStyle,
    ...xScaleFields,
  };
  const yAxisBase = { scale: true, axisPointer, ...yScaleFields };
  const base: EChartsOption = {
    animation: false,
    legend: {
      show: legend,
      data: pvs,
      // Not clickable: visibility lives on the card eye. Selectable only so a
      // right-click reaches an entry (the Y's menu); a left-click toggles
      // nothing (Plot.tsx).
      ...LEGEND_MENU_OPTION,
      // The state's hidden Ys, unselected.
      selected: Object.fromEntries(allPvs.map((pv) => [pv, !hidden.has(pv)])),
      top: 4,
      textStyle: { color: theme.legend },
    },
    tooltip: {
      // The strip's tooltip toggle hides the read-out box only.
      showContent: tooltip,
      trigger: 'item',
      ...(readoutDock ? tooltipOption(readoutDock) : {}),
      backgroundColor: theme.tooltipBg,
      borderColor: theme.tooltipBorder,
      textStyle: { color: theme.tooltipText },
    },
    series: quietLegendHover(series),
  };

  if (layout === 'overlay' && pvs.length > 0) {
    // Y 1 on the left, the rest on the right, each further one offset outward;
    // every axis in its series' colour, grid lines from the first only.
    const rightAxes = pvs.length - 1;
    return {
      ...base,
      grid: {
        ...SHARED_GRID,
        right: rightAxes === 0 ? SHARED_GRID.right : rightAxes * OVERLAY_AXIS_WIDTH + 8,
      },
      xAxis: xAxisBase,
      yAxis: pvs.map((pv, i) => {
        const color = colorOf(pv);
        const units = unitsOf(pv);
        return {
          ...yAxisBase,
          name: units !== '' ? units : shortPv(pv),
          position: i === 0 ? ('left' as const) : ('right' as const),
          offset: i <= 1 ? 0 : (i - 1) * OVERLAY_AXIS_WIDTH,
          axisLine: { show: true, lineStyle: { color } },
          axisTick: { show: true, lineStyle: { color } },
          axisLabel: { color },
          nameTextStyle: { color },
          splitLine: i === 0 ? splitLine : { show: false },
        };
      }),
    };
  }

  if (layout === 'split' && pvs.length > 0) {
    // One grid per Y, each with its own auto-scaled Y axis; every panel's X
    // axis gets the same explicit range (linked X).
    const geo = splitGeometry(pvs.length, width);
    const cellWidth = (width > 0 ? width : FALLBACK_WIDTH) / geo.columns;
    const extent = xExtent(xCells);
    const cell = (i: number) => ({
      left: (i % geo.columns) * cellWidth,
      top: SPLIT_TOP + Math.floor(i / geo.columns) * geo.rowHeight,
    });
    return {
      ...base,
      title: pvs.map((pv, i) => ({
        text: geo.columns > 2 ? shortPv(pv) : pv,
        left: cell(i).left + SPLIT_LEFT,
        top: cell(i).top,
        textStyle: {
          fontSize: 12,
          fontWeight: 'normal' as const,
          color: colorOf(pv),
        },
      })),
      grid: pvs.map((_, i) => ({
        left: cell(i).left + SPLIT_LEFT,
        top: cell(i).top + SPLIT_TITLE + 8,
        width: Math.max(10, cellWidth - SPLIT_LEFT - SPLIT_RIGHT),
        height: Math.max(10, geo.rowHeight - SPLIT_TITLE - 8 - SPLIT_BOTTOM),
      })),
      xAxis: pvs.map((_, i) => ({
        ...xAxisBase,
        gridIndex: i,
        nameGap: 26,
        // Linked X: the data extent, unless the X section pins its own range.
        ...(extent && xScale?.auto !== false ? { min: extent.min, max: extent.max } : {}),
        ...xScaleFields,
      })),
      yAxis: pvs.map((pv, i) => ({
        gridIndex: i,
        name: unitsOf(pv),
        ...axisStyle,
        ...yAxisBase,
      })),
    };
  }

  return {
    ...base,
    grid: SHARED_GRID,
    xAxis: xAxisBase,
    yAxis: {
      name: pvs.length > 0 ? unitsOf(pvs[0]) : '',
      ...axisStyle,
      ...yAxisBase,
    },
  };
}
