// Trace's section schema: one Y-axis.
//
// Its curves are listed under Signals (one sub-heading per axis); its fields
// show in the plot-wide Axes section, one sub-block per axis:
//
//   Label (stamped dot), ✚ Unit (its own optional `unitLabel`, shown
//   from the stamped EGU until overridden; `axis.units` stays the EGU that
//   routes curves), Side (no dot), Visible (also the Signals sub-heading's
//   eye: a hidden axis renders muted there), Auto-scale (`#axis-autoscale`),
//   Min / Max only while Auto-scale is off (optional-path dots), Log scale;
//   the Remove axis action.
//
// The section target is the axis id; every field finds the axis in whichever
// plot holds it. Dots come only from `../dots`. Writes are pure
// transforms through `ctx.update`.
//
// Built by a generic factory so `tool.ts` instantiates it once, at module
// level, with Trace's concrete state and model (a schema typed on the slices
// below would not be assignable to the full state's schema).

import { axisUnitText } from '../../../embed/plotConfig';
import type { Axis, Plot } from '../../../types';
import type { FieldDef, SectionSchema, ToolContext, ToolUi } from '../../../workbench/types';
import { GROUPS, LABELS } from '../../vocabulary';
import { axisLabelDot, axisOptional, type TraceDotState } from '../dots';

/** The section kind Trace's axes render under (`schema.sections.axis`). */
export const AXIS_SECTION_KIND = 'axis';

/** Why Remove axis is unavailable on a plot's only axis. */
export const LAST_AXIS_REASON = 'A plot keeps at least one axis.';

/** The one field group of an axis: its sub-block in Axes. */
export const AXIS_TAB = 'axis';

const SIDE_OPTIONS = [
  { value: 'left', label: 'Left' },
  { value: 'right', label: 'Right' },
];

// ---------------------------------------------------------------- locating --

function plotHolding(state: TraceDotState, axisId: string): Plot | undefined {
  return state.plots.find((p) => p.axes.some((a) => a.id === axisId));
}

function axisOf(state: TraceDotState, axisId: string): Axis | undefined {
  return plotHolding(state, axisId)?.axes.find((a) => a.id === axisId);
}

function mapPlot<S extends TraceDotState>(state: S, plotId: string, fn: (p: Plot) => Plot): S {
  return { ...state, plots: state.plots.map((p) => (p.id === plotId ? fn(p) : p)) };
}

/** `state` with the axis `axisId` patched; unchanged when no plot holds it. */
export function patchAxis<S extends TraceDotState>(
  state: S,
  axisId: string,
  patch: Partial<Axis>
): S {
  const plot = plotHolding(state, axisId);
  if (!plot) return state;
  return mapPlot(state, plot.id, (p) => ({
    ...p,
    axes: p.axes.map((a) => (a.id === axisId ? { ...a, ...patch } : a)),
  }));
}

/**
 * `state` without the axis `axisId`; its curves and drawings move
 * to the first other axis of the same plot (as `TraceApp.deleteAxis`). A
 * plot's only axis stays. The drawing list keeps identity when none moves.
 */
export function removeAxis<S extends TraceDotState>(state: S, axisId: string): S {
  const plot = plotHolding(state, axisId);
  if (!plot || plot.axes.length <= 1) return state;
  const fallback = plot.axes.find((a) => a.id !== axisId)!.id;
  return mapPlot(state, plot.id, (p) => {
    const out: Plot = {
      ...p,
      axes: p.axes.filter((a) => a.id !== axisId),
      traces: p.traces.map((t) => (t.axisId === axisId ? { ...t, axisId: fallback } : t)),
    };
    const list = p.annotations;
    if (list?.some((a) => a.axisId === axisId)) {
      out.annotations = list.map((a) => (a.axisId === axisId ? { ...a, axisId: fallback } : a));
    }
    return out;
  });
}

// ------------------------------------------------------------------ schema --

/** Trace's Y-axis section schema; call once at module level. */
export function traceAxisSchema<
  S extends TraceDotState,
  M,
  U extends ToolUi = ToolUi,
>(): SectionSchema<S, M, U> {
  type Ctx = ToolContext<S, M, U>;
  const axis = (ctx: Ctx) => axisOf(ctx.state, ctx.target.id);
  const patch = (ctx: Ctx, next: Partial<Axis>) =>
    ctx.update((state) => patchAxis(state, ctx.target.id, next));
  const manual = (ctx: Ctx) => axis(ctx)?.autoScale === false;

  const fields: FieldDef<S, M, U>[] = [
    {
      id: 'axis-label',
      label: LABELS.label,
      kind: 'text',
      tab: AXIS_TAB,
      level: 'L1',
      get: (ctx) => axis(ctx)?.name ?? '',
      set: (ctx, name) => patch(ctx, { name }),
      ...axisLabelDot<S, M, U>(),
    },
    {
      // Pinned iff `unitLabel` is present; clearing it, like reset, returns
      // the field to the EGU. `units` is never written here.
      id: 'axis-unit',
      label: LABELS.unit,
      kind: 'text',
      tab: AXIS_TAB,
      level: 'L1',
      get: (ctx) => {
        const a = axis(ctx);
        return (a && axisUnitText(a)) ?? '';
      },
      set: (ctx, text) => patch(ctx, { unitLabel: text.trim() === '' ? undefined : text }),
      ...axisOptional<S, M, U>('unitLabel'),
    },
    {
      // No automatic rule after creation, so no dot.
      id: 'axis-orientation',
      label: 'Side',
      kind: 'select',
      tab: AXIS_TAB,
      level: 'L1',
      options: () => SIDE_OPTIONS,
      get: (ctx) => axis(ctx)?.orientation ?? 'left',
      set: (ctx, side) => {
        if (side === 'left' || side === 'right') patch(ctx, { orientation: side });
      },
    },
    {
      id: 'axis-visible',
      label: LABELS.visible,
      kind: 'toggle',
      tab: AXIS_TAB,
      level: 'L1',
      row: 'eye',
      get: (ctx) => axis(ctx)?.visible ?? true,
      set: (ctx, visible) => patch(ctx, { visible }),
    },
    {
      id: 'axis-autoscale',
      label: LABELS.autoScale,
      kind: 'toggle',
      tab: AXIS_TAB,
      level: 'L1',
      get: (ctx) => axis(ctx)?.autoScale ?? true,
      // Turning it off keeps any min/max already set (the schema has no live range).
      set: (ctx, autoScale) => patch(ctx, { autoScale }),
    },
    {
      id: 'axis-min',
      label: LABELS.min,
      kind: 'number',
      tab: AXIS_TAB,
      level: 'L1',
      when: manual,
      get: (ctx) => axis(ctx)?.min ?? null,
      set: (ctx, min) => patch(ctx, { min: min ?? undefined }),
      ...axisOptional<S, M, U>('min'),
    },
    {
      id: 'axis-max',
      label: LABELS.max,
      kind: 'number',
      tab: AXIS_TAB,
      level: 'L1',
      when: manual,
      get: (ctx) => axis(ctx)?.max ?? null,
      set: (ctx, max) => patch(ctx, { max: max ?? undefined }),
      ...axisOptional<S, M, U>('max'),
    },
    {
      id: 'axis-logscale',
      label: LABELS.logScale,
      kind: 'toggle',
      tab: AXIS_TAB,
      level: 'L2',
      get: (ctx) => axis(ctx)?.logScale ?? false,
      set: (ctx, logScale) => patch(ctx, { logScale }),
    },
    {
      id: 'axis-remove',
      label: 'Remove axis',
      kind: 'action',
      tab: AXIS_TAB,
      level: 'L2',
      disabled: (ctx) => {
        const plot = plotHolding(ctx.state, ctx.target.id);
        return plot && plot.axes.length > 1 ? false : LAST_AXIS_REASON;
      },
      run: (ctx) => ctx.update((state) => removeAxis(state, ctx.target.id)),
    },
  ];

  return {
    group: GROUPS.signals,
    placement: 'axes',
    tabs: [{ id: AXIS_TAB, label: 'Axis', fields }],
  };
}
