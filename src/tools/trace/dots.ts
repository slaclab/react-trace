// Trace's instances of the one modified-dot rule, built only from the
// shared tool-side helpers in `../dotHelpers` — no hand-written dot here.
//
// Stamped values (Trace stamps an automatic value into the object, so the
// state cannot say "automatic" by absence):
//   - curve Colour — pinned iff the colour is not a member of the palette of
//     the plot holding the curve (`plot.palette`, else the default);
//     reset writes that palette's colour at the curve's position.
//   - axis Label   — pinned iff it is neither `Y-Axis <n>` nor the stamped
//     `axis.units`; reset writes `axis.units`, else `Y-Axis <n>` at the axis's
//     position.
//   - plot Title   — pinned iff it is not `Plot <n>`; reset writes `Plot <n>`
//     at the plot's position.
// Membership is judged against the rule's whole family (any palette colour,
// any `<n>`), never against the object's current slot, so deleting the first
// curve, axis or plot shifts positions without lighting a dot on the others.
//
// Optional paths: every "undefined = automatic" field of a curve, axis or plot
// gets its dot from `curveOptional` / `axisOptional` / `plotOptional`. The
// plot Palette is one too, with a reset that also moves the curves still
// at a palette colour back to the default palette by slot (`plotPaletteDot`).
//
// Axis Side has no automatic rule after creation: no dot, no builder.
// `plotConfigOf` keeps its own open-time baseline for `plot=`; what the wire
// omits is serializer business, not this module's.
//
// Binding: curve and axis targets carry their own id and are found in
// whichever plot holds them; plot-level fields (target at tool level) bind to
// the plot whose id the target names, else the active plot.

import { colorForIndex, paletteOf, paletteSlot, withPalette, type Palette } from '../../palettes';
import type { Axis, Plot, PVTrace } from '../../types';
import type { Target, ToolContext, ToolUi } from '../../workbench/types';
import { optionalPath, stampedValue, type Dot } from '../dotHelpers';

/** The slice of Trace's tool state the dots read and write. */
export interface TraceDotState {
  plots: readonly Plot[];
  activePlotId: string;
}

/**
 * The slice of Trace's tool model the curve tools read: the palette of the
 * active plot, which new curves follow. The dots themselves read each plot's
 * own palette, never this.
 */
export interface TraceDotModel {
  palette: Palette;
}

type Ctx<S, M, Ui extends ToolUi> = ToolContext<S, M, Ui>;

/** Keys of `T` whose property is optional (`undefined` = automatic). */
export type OptionalKeys<T> = {
  [K in keyof T]-?: object extends Pick<T, K> ? K : never;
}[keyof T];

// ---------------------------------------------------------------- locating --

/** The active plot, else the first plot; undefined only when there is none. */
export function activePlot(state: TraceDotState): Plot | undefined {
  return state.plots.find((p) => p.id === state.activePlotId) ?? state.plots[0];
}

function plotForTarget(state: TraceDotState, target: Target): Plot | undefined {
  return state.plots.find((p) => p.id === target.id) ?? activePlot(state);
}

function plotHoldingCurve(state: TraceDotState, id: string): Plot | undefined {
  return state.plots.find((p) => p.traces.some((t) => t.id === id));
}

function plotHoldingAxis(state: TraceDotState, id: string): Plot | undefined {
  return state.plots.find((p) => p.axes.some((a) => a.id === id));
}

function withPlot<S extends TraceDotState>(state: S, plotId: string, fn: (p: Plot) => Plot): S {
  let changed = false;
  const plots = state.plots.map((p) => {
    if (p.id !== plotId) return p;
    changed = true;
    return fn(p);
  });
  return changed ? { ...state, plots } : state;
}

function patchCurve<S extends TraceDotState>(state: S, id: string, patch: Partial<PVTrace>): S {
  const plot = plotHoldingCurve(state, id);
  if (!plot) return state;
  return withPlot(state, plot.id, (p) => ({
    ...p,
    traces: p.traces.map((t) => (t.id === id ? { ...t, ...patch } : t)),
  }));
}

function patchAxis<S extends TraceDotState>(state: S, id: string, patch: Partial<Axis>): S {
  const plot = plotHoldingAxis(state, id);
  if (!plot) return state;
  return withPlot(state, plot.id, (p) => ({
    ...p,
    axes: p.axes.map((a) => (a.id === id ? { ...a, ...patch } : a)),
  }));
}

function patchPlot<S extends TraceDotState>(state: S, target: Target, patch: Partial<Plot>): S {
  const plot = plotForTarget(state, target);
  if (!plot) return state;
  return withPlot(state, plot.id, (p) => ({ ...p, ...patch }));
}

function curveOf(state: TraceDotState, id: string): PVTrace | undefined {
  return plotHoldingCurve(state, id)?.traces.find((t) => t.id === id);
}

function axisOf(state: TraceDotState, id: string): Axis | undefined {
  return plotHoldingAxis(state, id)?.axes.find((a) => a.id === id);
}

// ------------------------------------------------------- automatic rules --

const AXIS_LABEL = /^Y-Axis [1-9]\d*$/;
const PLOT_TITLE = /^Plot [1-9]\d*$/;

/** True iff `colour` is one of the palette's colours (case-insensitive hex). */
export function isPaletteColour(colour: string, palette: Palette): boolean {
  return paletteSlot(colour, palette) >= 0;
}

/** True iff `label` is one the axis rule stamps: `Y-Axis <n>` or the axis's units. */
export function isAutomaticAxisLabel(label: string, axis: Pick<Axis, 'units'>): boolean {
  return AXIS_LABEL.test(label) || (!!axis.units && label === axis.units);
}

/** True iff `title` is one the plot rule stamps: `Plot <n>`. */
export function isAutomaticPlotTitle(title: string): boolean {
  return PLOT_TITLE.test(title);
}

/** The automatic label of the axis at `index` (0-based) among its plot's axes. */
export function automaticAxisLabel(axis: Pick<Axis, 'units'>, index: number): string {
  return axis.units ? axis.units : `Y-Axis ${index + 1}`;
}

/** The automatic title of the plot at `index` (0-based). */
export function automaticPlotTitle(index: number): string {
  return `Plot ${index + 1}`;
}

// ------------------------------------------------------- stamped values --

/** Curve Colour (item target = curve id). */
export function curveColourDot<
  S extends TraceDotState,
  M extends TraceDotModel,
  Ui extends ToolUi = ToolUi,
>(): Dot<S, M, Ui> {
  return stampedValue<S, M, string | undefined, Ui>({
    get: (ctx) => curveOf(ctx.state, ctx.target.id)?.color,
    // An unknown curve has nothing to pin.
    isAutomatic: (colour, ctx) =>
      colour === undefined ||
      isPaletteColour(colour, paletteOf(plotHoldingCurve(ctx.state, ctx.target.id))),
    automatic: (ctx: Ctx<S, M, Ui>) => {
      const plot = plotHoldingCurve(ctx.state, ctx.target.id);
      if (!plot) return undefined;
      const index = plot.traces.findIndex((t) => t.id === ctx.target.id);
      return colorForIndex(paletteOf(plot), index);
    },
    set: (state, target, colour) =>
      colour === undefined ? state : patchCurve(state, target.id, { color: colour }),
  });
}

/** Axis Label (section target = axis id). Side has no dot. */
export function axisLabelDot<S extends TraceDotState, M, Ui extends ToolUi = ToolUi>(): Dot<
  S,
  M,
  Ui
> {
  return stampedValue<S, M, string | undefined, Ui>({
    get: (ctx) => axisOf(ctx.state, ctx.target.id)?.name,
    isAutomatic: (label, ctx) => {
      const axis = axisOf(ctx.state, ctx.target.id);
      return label === undefined || axis === undefined || isAutomaticAxisLabel(label, axis);
    },
    automatic: (ctx) => {
      const plot = plotHoldingAxis(ctx.state, ctx.target.id);
      if (!plot) return undefined;
      const index = plot.axes.findIndex((a) => a.id === ctx.target.id);
      return automaticAxisLabel(plot.axes[index], index);
    },
    set: (state, target, label) =>
      label === undefined ? state : patchAxis(state, target.id, { name: label }),
  });
}

/** Plot Title (tool-level target, bound to the active plot unless it names a plot). */
export function plotTitleDot<S extends TraceDotState, M, Ui extends ToolUi = ToolUi>(): Dot<
  S,
  M,
  Ui
> {
  return stampedValue<S, M, string | undefined, Ui>({
    get: (ctx) => plotForTarget(ctx.state, ctx.target)?.title,
    isAutomatic: (title) => title === undefined || isAutomaticPlotTitle(title),
    automatic: (ctx) => {
      const plot = plotForTarget(ctx.state, ctx.target);
      return plot ? automaticPlotTitle(ctx.state.plots.indexOf(plot)) : undefined;
    },
    set: (state, target, title) =>
      title === undefined ? state : patchPlot(state, target, { title }),
  });
}

// ------------------------------------------------------- optional paths --

/** Dot for an optional ("undefined = automatic") curve field. */
export function curveOptional<S extends TraceDotState, M, Ui extends ToolUi = ToolUi>(
  key: OptionalKeys<PVTrace>
): Dot<S, M, Ui> {
  return optionalPath<S, M, Ui>({
    get: (ctx) => curveOf(ctx.state, ctx.target.id)?.[key],
    set: (state, target) => patchCurve(state, target.id, { [key]: undefined }),
  });
}

/** Dot for an optional ("undefined = automatic") axis field. */
export function axisOptional<S extends TraceDotState, M, Ui extends ToolUi = ToolUi>(
  key: OptionalKeys<Axis>
): Dot<S, M, Ui> {
  return optionalPath<S, M, Ui>({
    get: (ctx) => axisOf(ctx.state, ctx.target.id)?.[key],
    set: (state, target) => patchAxis(state, target.id, { [key]: undefined }),
  });
}

/** Dot for an optional ("undefined = automatic") plot field. */
export function plotOptional<S extends TraceDotState, M, Ui extends ToolUi = ToolUi>(
  key: OptionalKeys<Plot>
): Dot<S, M, Ui> {
  return optionalPath<S, M, Ui>({
    get: (ctx) => plotForTarget(ctx.state, ctx.target)?.[key],
    set: (state, target) => patchPlot(state, target, { [key]: undefined }),
  });
}

/**
 * Plot Palette (tool-level target): pinned iff the plot states a palette;
 * reset returns it to the default palette, recolouring by slot every curve
 * still at a colour of the old palette.
 */
export function plotPaletteDot<S extends TraceDotState, M, Ui extends ToolUi = ToolUi>(): Dot<
  S,
  M,
  Ui
> {
  return optionalPath<S, M, Ui>({
    get: (ctx) => plotForTarget(ctx.state, ctx.target)?.palette,
    set: (state, target) => {
      const plot = plotForTarget(state, target);
      return plot ? withPlot(state, plot.id, (p) => withPalette(p, undefined)) : state;
    },
  });
}
