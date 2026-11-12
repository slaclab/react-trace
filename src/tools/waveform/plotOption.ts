// The Waveform chart's ECharts option. Pure: state, model and the published frames
// in, option out. The canvas component (Plot.tsx) calls it once per publish
// and merges the result by series id.
//
// Rules:
//   - Every series has a stable id: `live:<pv>` for a curve's latest frame,
//     `trail:<age>:<pv>` for its persistence trails (age 1 = the frame before
//     the latest), `held:<pv>` for a frozen shot (dotted, drawn like a trail), `ref` for a PV reference and `ref:<pv>` for a snapshot
//     entry. The id set changes only when a curve, persistence or the
//     reference does.
//   - No per-point tuples: one dataset of keyed columns — a shared `x`
//     column and one Float64Array per series, the series encoding
//     `{x: 'x', y: <id>}`. Without a range, Δ or decimation a column *is* the
//     array the ring stores (trails by identity); an element range is a
//     `subarray` view on it, never a copy. Δ and decimation write into
//     `WaveformPlotBuffers` when the caller keeps one, so a publish does not
//     allocate per curve.
//   - NaN passes through and lines break: no `connectNulls`.
//   - Sampling: `minmax` only when the drawn array is at least SAMPLING_FACTOR
//     × the plot's device-pixel width and holds no NaN, so a dead element is
//     always a gap.
//   - The Live-axis scale (auto, min/max, log) is the y axis; the X axis is the
//     X-source column when the model says it is usable and chosen, else the
//     element index. The element range applies to every series and the x
//     column; Decimation (`dec`, 0 = off) caps the drawn points per curve after
//     the range, for drawing only: each bucket of elements draws its minimum
//     and maximum in element order at the bucket's first and last x, and a
//     bucket holding a NaN draws its second point as NaN, so the gap survives.
//   - A persistence trail draws as a hairline — one device pixel wide, or
//     the curve's width when that is thinner — and only the latest frame at
//     the curve's width. A stroke wider than a device pixel is rasterised as
//     a filled outline, which at persistence 16 (120 trails × 4096 elements at
//     device scale 2) costs seconds per frame; a hairline is about twenty
//     times cheaper, and the fading trails read the same.
//   - Bars are an overlay — every bar curve shares one column per element
//     (`barGap: '-100%'`), in curve order, in large mode, never progressive
//     (a progressive paint restarts on every publish and never finishes) —
//     and draw no trails.
//   - A rolling reference draws like a snapshot, one entry per curve; a
//     reference with a σ (rolling, or a snapshot frozen from one) also draws
//     its ±kσ band per curve as two stacked, silent line series (`band:`),
//     around zero in Δ.
//   - The reference draws dashed or as a shaded band; it is not drawn in Δ
//     mode, where each live curve subtracts it (its own entry for a snapshot).
//   - Only what the model marks drawable is drawn.
//
//   - A curve's dash is Trace's pattern for the same wire value
//     (`echartsLineType`), so a dash reads the same in every tool.
//
// The chart source comes from this same builder: the option without
// series, printed through `codeFragment` with data elided.

import { tooltipOption } from '../../plot/readoutDock';
import type { EChartsOption } from 'echarts';
import { codeFragment } from '../codeFragment';
import { LEGEND_MENU_OPTION, quietLegendHover } from '../contextMenu';
import {
  bandId,
  columnOf,
  columns,
  drawnSeries,
  seriesOf,
  X_COLUMN,
  type Series,
  type WaveformPlotInput,
} from './series';

export { decimateInto, WaveformPlotBuffers } from './decimate';
export {
  bandId,
  heldId,
  liveId,
  REF_ID,
  refId,
  renderedXSource,
  SAMPLING_FACTOR,
  trailId,
  X_COLUMN,
  type WaveformCurveFrames,
  type WaveformPlotFrames,
  type WaveformPlotInput,
} from './series';

/** The Waveform chart option. */
export function waveformPlotOption(input: WaveformPlotInput): EChartsOption {
  const { state, model, theme, buffers } = input;
  const drawn = drawnSeries(input);
  const cols = columns(input, drawn);
  const source: Record<string, Float64Array> = { [X_COLUMN]: cols.x };
  const series: Series[] = [];
  for (const d of drawn) {
    const column = columnOf(d, cols, buffers);
    source[d.id] = column;
    series.push(seriesOf(d, column, input.widthPx));
  }
  // The band's upper series is stacked on its lower one: turn the decimated
  // upper edge into the height above the decimated lower edge, in place (the
  // column is this option's own buffer or a view of the band's own array).
  for (const d of drawn) {
    if (d.kind !== 'band-hi' || d.pv === null) continue;
    const lo = source[bandId(d.pv, 'lo')];
    const hi = source[d.id];
    if (lo === undefined || lo.length !== hi.length) continue;
    for (let i = 0; i < hi.length; i++) hi[i] -= lo[i];
  }

  const scale = state.yScale ?? {};
  const fixed = scale.auto === false;
  const xScale = state.xScale ?? {};
  const xFixed = xScale.auto === false;
  const splitLine = { show: state.grid, lineStyle: { color: theme.splitLine } };
  // The axis pointer triggers the axis tooltip, so it is on while either the
  // crosshair or the tooltip is; without the crosshair it draws no line.
  const axisPointer = {
    show: state.crosshair || state.tooltip,
    type: state.crosshair ? ('line' as const) : ('none' as const),
    snap: false,
  };
  const axisStyle = {
    axisLabel: { color: theme.axisLabel },
    axisLine: { lineStyle: { color: theme.axisLine } },
    nameTextStyle: { color: theme.axisName },
    splitLine,
    axisPointer,
  };
  const legendNames: string[] = [];
  for (const d of drawn) {
    if (d.kind === 'trail' || d.kind === 'band-lo' || d.kind === 'band-hi') continue;
    if (!legendNames.includes(d.name)) legendNames.push(d.name);
  }

  return {
    animation: false,
    legend: {
      show: state.legend,
      data: legendNames,
      // Not clickable: visibility lives on the Outline eye. Selectable only so
      // a right-click reaches an entry (the signal's menu); a left-click
      // toggles nothing (Plot.tsx).
      ...LEGEND_MENU_OPTION,
      top: 4,
      textStyle: { color: theme.legend },
    },
    // The tooltip and the crosshair are independent: the axis pointers are the
    // crosshair, the strip's tooltip toggle shows or hides the read-out box.
    tooltip: {
      showContent: state.tooltip,
      trigger: 'axis',
      ...(input.readoutDock ? tooltipOption(input.readoutDock) : {}),
      backgroundColor: theme.tooltipBg,
      borderColor: theme.tooltipBorder,
      textStyle: { color: theme.tooltipText },
    },
    grid: { left: 64, right: 24, top: 36, bottom: 48 },
    dataset: { dimensions: [X_COLUMN, ...drawn.map((d) => d.id)], source },
    xAxis: {
      type: 'value',
      name: model.xAxis.label,
      nameLocation: 'middle',
      nameGap: 30,
      min: xFixed && xScale.min !== undefined ? xScale.min : 'dataMin',
      max: xFixed && xScale.max !== undefined ? xScale.max : 'dataMax',
      ...axisStyle,
    },
    yAxis: {
      type: scale.log ? 'log' : 'value',
      name: model.unit ?? '',
      scale: true,
      ...(fixed && scale.min !== undefined ? { min: scale.min } : {}),
      ...(fixed && scale.max !== undefined ? { max: scale.max } : {}),
      ...axisStyle,
    },
    series: quietLegendHover(series),
  } as EChartsOption;
}

// ------------------------------------------------------------ chart source

/** The chart option without series. */
export function selectToolFragment(input: WaveformPlotInput): Omit<EChartsOption, 'series'> {
  const option: EChartsOption = { ...waveformPlotOption(input) };
  delete option.series;
  return option;
}

/** The chart source: the option without series, data elided. */
export function toolCodeFragment(input: WaveformPlotInput): string {
  return codeFragment(selectToolFragment(input));
}
