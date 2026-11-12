// Trace's tool-level schema.
//
// The tool-level object of Trace is the active plot: every field binds
// to the plot whose id `ctx.target` names, else the active plot. Its tabs are
// the plot-wide sections of the properties panel, each with a summary:
//
//   Acquisition Refresh interval (optional dot; relative ranges only) ·
//               Effective refresh (read-only, while a short span caps it) ·
//               Default archiver (custom, optional dot)
//   Axes        X axis: Time range (custom, `#time-range`, `range=`) ·
//               Autoscroll (session state; relative ranges only); the
//               Y axes follow as the axis sections' sub-blocks
//   Display     Title (stamped dot) · Legend · Live value in legend · X/Y
//               gridlines · Crosshair · Data tooltip (L1); Mouse drag ·
//               Status line · Pin data window (L2); More: Grid style ·
//               Grid opacity · Tick font size · Background colour · Palette
//               (custom, `plot.palette`)
//   Statistics  Show statistics · Metrics · Reset metrics — the shared fields
//               (src/statistics), per plot
//   Code        the plot's chart option without series
//
// Dots come only from `../dots`. Required fields with no automatic rule
// carry none; Autoscroll carries none either: it is session state that a new
// plot stamps `true`, so an optional-path dot would light on every plot.
//
// Built by a factory generic over the tool's state and model, so the tool's
// full state type (`tool.ts`) can instantiate it; `plotSchema` is the instance
// over the slices this schema needs.

import { plotCodeFragment, type TraceFragmentInput } from '../codeFragments';
import {
  activePlot,
  plotOptional,
  plotPaletteDot,
  plotTitleDot,
  type TraceDotModel,
  type TraceDotState,
} from '../dots';
import { ArchiverControl } from '../fields/archiver';
import { PaletteControl } from '../fields/palette';
import { TimeRangeControl, type TimeRangeValue } from '../fields/timeRange';
import { TRACE_DEFAULT_DRAG } from '../plotView';
import { DEFAULT_PALETTE_ID, withPalette } from '../../../palettes';
import { effectiveBackground } from '../../../plotBackground';
import { createElement } from 'react';
import { statisticsFields } from '../../../statistics/fields';
import type { Metric } from '../../../statistics/model';
import { plotMetrics, storedMetrics, TRACE_METRICS } from '../metrics';
import {
  DEFAULT_REFRESH_INTERVAL_S,
  MAX_REFRESH_S,
  MIN_REFRESH_S,
  clampInterval,
  refreshIntervalMs,
} from '../../../hooks/useAutoScrollTimers';
import type { Plot } from '../../../types';
import { DRAG_MODE_LABEL, DRAG_MODES, isDragMode } from '../../../plot/plotToggles';
import { AXES, LABELS, PLOT_SECTIONS, onFlags, summary } from '../../vocabulary';
import type {
  FieldDef,
  FieldOption,
  ObjectSchema,
  Target,
  ToolContext,
  ToolUi,
} from '../../../workbench/types';

/** What the plot schema reads from Trace's model: the palette and the chart source's input. */
export interface TracePlotModel extends TraceDotModel {
  /** The chart source's input for `plot`: the plot plus its result maps and chart theme. */
  fragmentInput(plot: Plot): TraceFragmentInput;
}

export const PLOT_TABS = {
  acquisition: PLOT_SECTIONS.acquisition.id,
  axes: PLOT_SECTIONS.axes.id,
  display: PLOT_SECTIONS.display.id,
  statistics: PLOT_SECTIONS.statistics.id,
  code: PLOT_SECTIONS.code.id,
} as const;

export const GRID_STYLE_OPTIONS: FieldOption[] = [
  { value: 'solid', label: 'Solid' },
  { value: 'dashed', label: 'Dashed' },
  { value: 'dotted', label: 'Dotted' },
];

/** Tick font size bounds, as `plotConfig`'s PLOT_CHECKS. */
export const TICK_FONT_MIN = 6;
export const TICK_FONT_MAX = 48;

const EMPTY_METRICS: readonly Metric[] = [];

// --------------------------------------------------------------- summaries --

const SPAN_UNITS: Record<string, string> = { s: 's', m: 'min', h: 'h', d: 'd', w: 'w', M: 'mo' };

/** A time range as a summary: `last 30 s`, `last 1 h`, `last 90 min`, `custom range`. */
export function timeRangeSummary(timeRange: string): string {
  const span = /^-(\d+(?:\.\d+)?)([smhdwM])$/.exec(timeRange);
  if (span) return `last ${span[1]} ${SPAN_UNITS[span[2]]}`;
  return timeRange === 'custom' ? 'custom range' : timeRange;
}

/**
 * The refresh interval a short span imposes, in seconds, or `null` when the
 * plot's own interval applies. A following plot refreshes at least every sixth
 * of a relative span (see `refreshIntervalMs`), while the Refresh interval
 * field keeps showing the interval the user set.
 */
export function cappedRefreshS(plot: Plot): number | null {
  const ms = refreshIntervalMs(plot);
  return ms < clampInterval(plot.refreshIntervalS) * 1000 ? +(ms / 1000).toFixed(1) : null;
}

/** The Y axes of a plot as a summary: `1 Y axis`, `2 Y axes`. */
function axisCountSummary(count: number): string {
  return `${count} Y ${count === 1 ? 'axis' : 'axes'}`;
}

// ---------------------------------------------------------------- binding --

/** The plot a tool-level field binds to: the one the target names, else the active plot. */
export function boundPlot(state: TraceDotState, target: Target): Plot | undefined {
  return state.plots.find((p) => p.id === target.id) ?? activePlot(state);
}

/** `state` with the bound plot replaced by `fn(plot)`; unchanged when there is none. */
export function updateBoundPlot<S extends TraceDotState>(
  state: S,
  target: Target,
  fn: (plot: Plot) => Plot
): S {
  const plot = boundPlot(state, target);
  if (!plot) return state;
  return { ...state, plots: state.plots.map((p) => (p.id === plot.id ? fn(p) : p)) };
}

// ------------------------------------------------------------------ schema --

export function createPlotSchema<
  S extends TraceDotState,
  M extends TracePlotModel,
  U extends ToolUi = ToolUi,
>(): ObjectSchema<S, M, U> {
  type Ctx = ToolContext<S, M, U>;
  type Field = FieldDef<S, M, U>;

  const read = <V>(ctx: Ctx, pick: (plot: Plot) => V, fallback: V): V => {
    const plot = boundPlot(ctx.state, ctx.target);
    return plot ? pick(plot) : fallback;
  };
  const patch = (ctx: Ctx, change: Partial<Plot>): void => {
    const target = ctx.target;
    ctx.update((state) => updateBoundPlot(state, target, (p) => ({ ...p, ...change })));
  };
  const isRelative = (ctx: Ctx) => read(ctx, (p) => p.xAxis.timeRange !== 'custom', true);
  const flag = (
    id: string,
    label: string,
    key: 'showLegend' | 'showXGridlines' | 'showYGridlines' | 'showCrosshair'
  ): Field => ({
    id,
    label,
    kind: 'toggle',
    tab: PLOT_TABS.display,
    level: 'L1',
    get: (ctx) => read(ctx, (p) => p[key], false),
    set: (ctx, value) => patch(ctx, { [key]: value } as Partial<Plot>),
  });

  const acquisition: Field[] = [
    {
      id: 'refresh-interval',
      label: 'Refresh interval',
      kind: 'number',
      tab: PLOT_TABS.acquisition,
      level: 'L1',
      min: MIN_REFRESH_S,
      max: MAX_REFRESH_S,
      step: 1,
      unit: 's',
      help: 'How often archive and formula data refresh. The axis scrolls continuously.',
      when: isRelative,
      disabled: (ctx) =>
        read(ctx, (p) => p.autoScroll === false, false) ? 'Autoscroll is off' : false,
      get: (ctx) => read(ctx, (p) => p.refreshIntervalS ?? DEFAULT_REFRESH_INTERVAL_S, null),
      set: (ctx, value) => {
        if (value === null) return;
        patch(ctx, { refreshIntervalS: clampInterval(value) });
      },
      ...plotOptional<S, M, U>('refreshIntervalS'),
    },
    {
      // Shown only while a short span caps the interval above, which still
      // shows the value the user set.
      id: 'refresh-cap',
      label: 'Effective refresh',
      kind: 'readonly',
      tab: PLOT_TABS.acquisition,
      level: 'L1',
      when: (ctx) => read(ctx, (p) => p.autoScroll !== false && cappedRefreshS(p) !== null, false),
      get: (ctx) =>
        read(
          ctx,
          (p) =>
            `Archive and formula data refresh every ${cappedRefreshS(p)} s at this span (at most a sixth of it), so the scrolling axis doesn't outrun them.`,
          ''
        ),
    },
    {
      id: 'default-archiver',
      label: 'Default archiver',
      kind: 'custom',
      tab: PLOT_TABS.acquisition,
      level: 'L1',
      get: (ctx): string | undefined => read(ctx, (p) => p.archiver, undefined),
      set: (ctx, archiver: string | undefined) => patch(ctx, { archiver }),
      render: ({ value, onChange, id }) =>
        createElement(ArchiverControl, { id, value: value as string | undefined, onChange }),
      ...plotOptional<S, M, U>('archiver'),
    },
  ];

  const axes: Field[] = [
    {
      id: 'time-range',
      label: 'Time range',
      kind: 'custom',
      tab: PLOT_TABS.axes,
      level: 'L1',
      subgroup: AXES.x,
      get: (ctx): TimeRangeValue => read(ctx, (p) => p.xAxis, { timeRange: '-1h' }),
      set: (ctx, xAxis: TimeRangeValue) => patch(ctx, { xAxis }),
      render: ({ value, onChange, id }) =>
        createElement(TimeRangeControl, { id, value: value as TimeRangeValue, onChange }),
    },
    {
      id: 'autoscroll',
      label: 'Autoscroll (track now)',
      kind: 'toggle',
      tab: PLOT_TABS.axes,
      level: 'L1',
      subgroup: AXES.x,
      when: isRelative,
      // Undefined is on: plots older than the field still track.
      get: (ctx) => read(ctx, (p) => p.autoScroll !== false, true),
      set: (ctx, autoScroll) => patch(ctx, { autoScroll }),
    },
  ];

  const display: Field[] = [
    {
      id: 'plot-title',
      label: 'Title',
      kind: 'text',
      tab: PLOT_TABS.display,
      level: 'L1',
      get: (ctx) => read(ctx, (p) => p.title, ''),
      set: (ctx, title) => patch(ctx, { title }),
      ...plotTitleDot<S, M, U>(),
    },
    flag('show-legend', LABELS.legend, 'showLegend'),
    {
      // ✚ Live value in the legend. Undefined is off; only "on" is
      // stored, so the dot means "on". The value itself follows the live
      // stream in the chart's legend, not here.
      id: 'show-legend-value',
      label: 'Live value in legend',
      kind: 'toggle',
      tab: PLOT_TABS.display,
      level: 'L1',
      disabled: (ctx) => (read(ctx, (p) => p.showLegend, true) ? false : 'Legend is off'),
      get: (ctx) => read(ctx, (p) => p.showLegendValue === true, false),
      set: (ctx, on) => patch(ctx, { showLegendValue: on ? true : undefined }),
      ...plotOptional<S, M, U>('showLegendValue'),
    },
    flag('show-x-gridlines', 'X gridlines', 'showXGridlines'),
    flag('show-y-gridlines', 'Y gridlines', 'showYGridlines'),
    flag('show-crosshair', LABELS.crosshair, 'showCrosshair'),
    {
      id: 'show-tooltip',
      label: LABELS.tooltip,
      kind: 'toggle',
      tab: PLOT_TABS.display,
      level: 'L1',
      // On by default (the strip's tooltip toggle), so only "off" is stored.
      get: (ctx) => read(ctx, (p) => p.showTooltip !== false, true),
      set: (ctx, on) => patch(ctx, { showTooltip: on ? undefined : false }),
      ...plotOptional<S, M, U>('showTooltip'),
    },
    {
      id: 'drag-mode',
      label: LABELS.drag,
      kind: 'segmented',
      tab: PLOT_TABS.display,
      level: 'L2',
      // The strip's zoom/pan toggle; only the mode off Trace's default is stored.
      options: () => DRAG_MODES.map((m) => ({ value: m, label: DRAG_MODE_LABEL[m] })),
      get: (ctx) => read(ctx, (p) => p.dragMode ?? TRACE_DEFAULT_DRAG, TRACE_DEFAULT_DRAG),
      set: (ctx, value) => {
        if (isDragMode(value)) {
          patch(ctx, { dragMode: value === TRACE_DEFAULT_DRAG ? undefined : value });
        }
      },
      ...plotOptional<S, M, U>('dragMode'),
    },
    {
      id: 'show-status-line',
      label: 'Status line',
      kind: 'toggle',
      tab: PLOT_TABS.display,
      level: 'L2',
      // On by default, so only "off" is stored (false); turning it back on
      // clears the key.
      get: (ctx) => read(ctx, (p) => p.showStatusLine !== false, true),
      set: (ctx, on) => patch(ctx, { showStatusLine: on ? undefined : false }),
      ...plotOptional<S, M, U>('showStatusLine'),
    },
    {
      id: 'pin-data-window',
      label: 'Pin data window',
      kind: 'toggle',
      tab: PLOT_TABS.display,
      level: 'L2',
      // Off by default: the hover readout follows the cursor. On pins it to
      // the plot's top-right so it never covers what is under the pointer.
      get: (ctx) => read(ctx, (p) => p.pinDataWindow === true, false),
      set: (ctx, on) => patch(ctx, { pinDataWindow: on ? true : undefined }),
      ...plotOptional<S, M, U>('pinDataWindow'),
    },
    {
      id: 'grid-style',
      label: 'Grid style',
      kind: 'select',
      tab: PLOT_TABS.display,
      level: 'L3',
      options: () => GRID_STYLE_OPTIONS,
      get: (ctx) => read(ctx, (p) => p.gridStyle, 'solid'),
      set: (ctx, value) => {
        if (value === 'solid' || value === 'dashed' || value === 'dotted') {
          patch(ctx, { gridStyle: value });
        }
      },
    },
    {
      id: 'grid-opacity',
      label: 'Grid opacity',
      kind: 'number',
      tab: PLOT_TABS.display,
      level: 'L3',
      min: 0,
      max: 100,
      step: 1,
      unit: '%',
      // Stored 0..1, shown as a percentage.
      get: (ctx) => read(ctx, (p) => Math.round(p.gridOpacity * 100), null),
      set: (ctx, value) => {
        if (value === null) return;
        patch(ctx, { gridOpacity: Math.min(100, Math.max(0, value)) / 100 });
      },
    },
    {
      id: 'tick-font-size',
      label: 'Tick font size',
      kind: 'number',
      tab: PLOT_TABS.display,
      level: 'L3',
      min: TICK_FONT_MIN,
      max: TICK_FONT_MAX,
      step: 1,
      unit: 'px',
      get: (ctx) => read(ctx, (p) => p.tickFontSize, null),
      set: (ctx, value) => {
        if (value === null) return;
        patch(ctx, { tickFontSize: Math.round(value) });
      },
    },
    {
      id: 'plot-background',
      label: 'Background colour',
      kind: 'colour',
      tab: PLOT_TABS.display,
      level: 'L3',
      // Automatic when unset: shows the theme's default background;
      // a pick pins it, reset returns to automatic. Shows exactly what the
      // chart draws: effectiveBackground still snaps a pinned theme-default
      // literal to the current theme (legacy loads stamp '#161616').
      get: (ctx) =>
        read(
          ctx,
          (p) => effectiveBackground(p.backgroundColor, ctx.model.fragmentInput(p).theme),
          ''
        ),
      set: (ctx, backgroundColor) => patch(ctx, { backgroundColor }),
      ...plotOptional<S, M, U>('backgroundColor'),
    },
    {
      id: 'plot-palette',
      label: 'Palette',
      kind: 'custom',
      tab: PLOT_TABS.display,
      level: 'L3',
      // The plot's own palette. A pick recolours, by slot, every curve
      // still at a colour of the old palette; user-set colours stay.
      get: (ctx): string => read(ctx, (p) => p.palette ?? DEFAULT_PALETTE_ID, DEFAULT_PALETTE_ID),
      set: (ctx, paletteId: string) => {
        const target = ctx.target;
        ctx.update((state) => updateBoundPlot(state, target, (p) => withPalette(p, paletteId)));
      },
      ...plotPaletteDot<S, M, U>(),
      render: ({ value, onChange, id }) =>
        createElement(PaletteControl, { id, value: value as string, onChange }),
    },
  ];

  // The shared Statistics fields (src/statistics/fields.ts):
  // Show statistics and the metric list of the bound plot; both stored only
  // off their default (off, the default list), so neither carries a dot.
  const statistics: Field[] = statisticsFields<S, M, U>({
    tab: PLOT_TABS.statistics,
    catalog: TRACE_METRICS,
    getShow: (ctx) => read(ctx, (p) => p.showStats === true, false),
    setShow: (ctx, on) => patch(ctx, { showStats: on ? true : undefined }),
    getDistribution: (ctx) => read(ctx, (p) => p.showDist === true, false),
    setDistribution: (ctx, on) => patch(ctx, { showDist: on ? true : undefined }),
    getMetrics: (ctx) => read(ctx, plotMetrics, EMPTY_METRICS),
    setMetrics: (ctx, metrics) => patch(ctx, { metrics: storedMetrics(metrics) }),
    rowCount: (ctx) => read(ctx, (p) => p.traces.length, 0),
  });

  const code: Field[] = [
    {
      id: 'plot-code',
      label: 'Code',
      kind: 'code',
      tab: PLOT_TABS.code,
      level: 'L1',
      get: (ctx) => {
        const plot = boundPlot(ctx.state, ctx.target);
        return plot ? plotCodeFragment(ctx.model.fragmentInput(plot)) : '';
      },
    },
  ];

  return {
    tabs: [
      {
        ...PLOT_SECTIONS.acquisition,
        fields: acquisition,
        // `refresh 5 s` while the plot tracks now, else `no refresh`.
        summary: (ctx) =>
          read(
            ctx,
            (p) =>
              p.xAxis.timeRange !== 'custom' && p.autoScroll !== false
                ? `refresh ${cappedRefreshS(p) ?? p.refreshIntervalS ?? DEFAULT_REFRESH_INTERVAL_S} s`
                : 'no refresh',
            ''
          ),
      },
      {
        ...PLOT_SECTIONS.axes,
        fields: axes,
        summary: (ctx) =>
          read(
            ctx,
            (p) => summary(timeRangeSummary(p.xAxis.timeRange), axisCountSummary(p.axes.length)),
            ''
          ),
      },
      {
        ...PLOT_SECTIONS.display,
        fields: display,
        summary: (ctx) =>
          read(
            ctx,
            (p) =>
              onFlags([
                ['legend', p.showLegend],
                ['grid', p.showXGridlines || p.showYGridlines],
                ['crosshair', p.showCrosshair],
                ['tooltip', p.showTooltip !== false],
              ]),
            ''
          ),
      },
      {
        ...PLOT_SECTIONS.statistics,
        fields: statistics,
        summary: (ctx) =>
          read(
            ctx,
            (p) =>
              p.showStats === true ? summary('on', `${plotMetrics(p).length} metrics`) : 'off',
            ''
          ),
      },
      { ...PLOT_SECTIONS.code, fields: code },
    ],
  };
}

/** The tool-level schema over the state and model slices it reads. */
export const plotSchema: ObjectSchema<TraceDotState, TracePlotModel> = createPlotSchema<
  TraceDotState,
  TracePlotModel
>();
