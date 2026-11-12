// Trace's PV-curve item schema. The blocks of its card:
//
//   Signal  PV name (custom on PvCombo, `#pv-name`; commits on Enter, a pick
//           or blur; a changed PV re-assigns the curve to its unit's axis) ·
//           Label (`#display-name`) · Plot on (`#y-axis`) · Visible (the
//           card's eye)
//   Style   Colour (the card's swatch, stamped dot) · Line · Width · Dash ·
//           Markers (`#show-symbols`) · Marker · Marker size (L1; Marker and
//           Marker size only while Markers is on) · Extend to now · Alarm
//           colouring (L2)
//   Data    Live · Archive; Status (read-only, outside the budget) Live status
//           · Archive status; (L2) actions Inspect data · Create formula from
//           this curve; More (L3): Live
//           retention only while Live is on; Archiver, Min/max band, Optimized
//           bins only while Archive is on
//
// Update rate is struck: no field, and `plot=` and the .trc conversion
// do not write it.
//
// The item target is the curve id; every field finds the curve in whichever
// plot holds it. Dots come only from `../dots`. Writes are pure
// transforms through `ctx.update`; what is not a state transform (Inspect
// data, Create formula, which also selects the new curve) goes through the
// model. The Style block and the shared Signal fields are exported for the
// formula curve.

import { createElement } from 'react';
import { fetchMetadata } from '@slaclab/canopy-client';
import { canopyConnection } from '../../../api/connection';
import { ArchiverPicker } from '../../../components/ArchiverPicker';
import { LINE_STYLE_OPTIONS, LINE_TYPE_OPTIONS, SYMBOL_OPTIONS } from '../../../curveStyle';
import { unitAxis } from '../../../embed/plotConfig';
import type { ArchiveSeriesResult } from '../../../hooks/useArchiveSeries';
import { DEFAULT_OPTIMIZED_BINS } from '../../../hooks/useArchiveSeries';
import type { LiveSeriesResult } from '../../../hooks/useLiveSeries';
import { makeId } from '../../../id';
import { archiveErrorNotice } from '../../../api/archiveErrors';
import { LIVE_RETENTION_MAX_S } from '../../../state/liveStore';
import type { Plot, PVTrace } from '../../../types';
import type {
  FieldDef,
  FieldOption,
  ObjectSchema,
  TabDef,
  ToolContext,
  ToolUi,
} from '../../../workbench/types';
import { CARD_BLOCKS, LABELS } from '../../vocabulary';
import { curveColourDot, curveOptional, type TraceDotModel, type TraceDotState } from '../dots';
import { PvNameControl } from '../fields/pvName';
import type { TracePlotModel } from './plot';

/** The item kind Trace's PV curves render under (`schema.items.curve`). */
export const PV_CURVE_ITEM_KIND = 'curve';

/** What the curve schema reads from Trace's model beyond the plot schema's slice. */
export interface TraceCurveModel extends TracePlotModel {
  /** Open the data inspector on the curve. */
  inspect(traceId: string): void;
  /** Add a formula curve seeded with this one as `{x1}`, and select it. */
  createFormula(traceId: string): void;
  /**
   * The owner's in-flight unit lookups, which it aborts when a workspace loads
   * and when it unmounts. Absent, each lookup site keeps its own.
   */
  unitLookups?: UnitLookups;
}

/**
 * The in-flight unit lookups of one Trace, at most one per curve. Curve, axis
 * and plot ids repeat across workspaces (a legacy import always yields
 * `trace-1` on `axis-1`), so the owner aborts them all when a workspace loads:
 * a late answer would otherwise move a curve of the incoming workspace.
 */
export class UnitLookups {
  private readonly pending = new Map<string, AbortController>();

  /** Starts the lookup for `curveId`, aborting an older one for that curve. */
  start(curveId: string): AbortController {
    this.abort(curveId);
    const controller = new AbortController();
    this.pending.set(curveId, controller);
    return controller;
  }

  /** Forgets `controller` once its lookup settled, unless a newer one replaced it. */
  settle(curveId: string, controller: AbortController): void {
    if (this.pending.get(curveId) === controller) this.pending.delete(curveId);
  }

  /** Aborts the lookup for `curveId`, if one is in flight. */
  abort(curveId: string): void {
    this.pending.get(curveId)?.abort();
    this.pending.delete(curveId);
  }

  /** Aborts every lookup in flight. */
  abortAll(): void {
    for (const controller of this.pending.values()) controller.abort();
    this.pending.clear();
  }
}

export const CURVE_TABS = {
  signal: CARD_BLOCKS.signal.id,
  style: CARD_BLOCKS.style.id,
  data: CARD_BLOCKS.data.id,
} as const;

/** Why the PV actions are unavailable on a curve with no PV yet. */
export const NO_PV_REASON = 'Choose a PV first.';

/** Live retention bounds (s), as today's Properties panel. */
export const LIVE_RETENTION_MIN_S = 5;
/** Line width and symbol size bounds, as `plotConfig`'s TRACE_CHECKS. */
export const LINE_WIDTH_MIN = 0.5;
export const LINE_WIDTH_MAX = 20;
export const SYMBOL_SIZE_MIN = 1;
export const SYMBOL_SIZE_MAX = 50;
export const OPTIMIZED_BINS_MAX = 100_000;

const options = <V extends string>(list: { value: V; label: string }[]): FieldOption[] =>
  list.map((o) => ({ value: o.value, label: o.label }));

// ---------------------------------------------------------------- locating --

/** The plot holding the curve `id`: any plot, not only the active one. */
export function plotHoldingCurve(state: TraceDotState, id: string): Plot | undefined {
  return state.plots.find((p) => p.traces.some((t) => t.id === id));
}

/** The curve `id`, in whichever plot holds it. */
export function curveOf(state: TraceDotState, id: string): PVTrace | undefined {
  return plotHoldingCurve(state, id)?.traces.find((t) => t.id === id);
}

/** `state` with the curve `id` patched; unchanged when no plot holds it. */
export function patchCurve<S extends TraceDotState>(
  state: S,
  id: string,
  patch: Partial<PVTrace>
): S {
  const plot = plotHoldingCurve(state, id);
  if (!plot) return state;
  return {
    ...state,
    plots: state.plots.map((p) =>
      p.id === plot.id
        ? { ...p, traces: p.traces.map((t) => (t.id === id ? { ...t, ...patch } : t)) }
        : p
    ),
  };
}

// --------------------------------------------------------- unit re-assignment --

/**
 * `state` with the curve `traceId` moved to the axis of `unit` (TraceApp's
 * `assignTraceToUnitAxis`): an axis whose recorded units match, else one whose
 * name carries `(unit)` (axes older than unit tracking, which get the units
 * stamped), else a new axis `newAxisId` named for the unit. Unchanged when the
 * curve left `axisIdAtFetch` meanwhile (a manual move wins), or, given
 * `pvAtFetch`, when the curve got another PV while the lookup was in flight.
 */
export function assignCurveToUnitAxis<S extends TraceDotState>(
  state: S,
  traceId: string,
  unit: string,
  axisIdAtFetch: string,
  newAxisId: string,
  pvAtFetch?: string
): S {
  const plot = plotHoldingCurve(state, traceId);
  const current = plot?.traces.find((t) => t.id === traceId);
  if (!plot || !current || current.axisId !== axisIdAtFetch) return state;
  if (pvAtFetch !== undefined && current.pvName !== pvAtFetch) return state;
  const wanted = unit.toLowerCase();
  const norm = (s: string | undefined) => (s ?? '').trim().toLowerCase();
  // The name fallback matches only a parenthesised unit, so "V" never matches "kV".
  const match = plot.axes.find(
    (a) => norm(a.units) === wanted || norm(a.name).includes(`(${wanted})`)
  );
  let axes = plot.axes;
  let axisId: string;
  if (match) {
    axisId = match.id;
    if (!match.units) axes = axes.map((a) => (a.id === match.id ? { ...a, units: unit } : a));
  } else {
    axisId = newAxisId;
    axes = [...axes, unitAxis(newAxisId, axes.length, unit)];
  }
  const traces = plot.traces.map((t) => (t.id === traceId ? { ...t, axisId } : t));
  return {
    ...state,
    plots: state.plots.map((p) => (p.id === plot.id ? { ...p, axes, traces } : p)),
  };
}

// ------------------------------------------------------------------ status --

/** The Live status line (today's Properties panel wording). */
export function liveStatusLabel(
  trace: Pick<PVTrace, 'useLive'>,
  result: Pick<LiveSeriesResult, 'status' | 'connected'> | undefined
): string {
  if (!trace.useLive) return 'Disabled';
  const status = result?.status ?? 'idle';
  if (status === 'connecting') return 'Connecting…';
  if (status === 'connected') return result?.connected ? 'Connected' : 'Waiting for value';
  return 'Disconnected';
}

/** The Archive status line (today's Properties panel wording). */
export function archiveStatusLabel(
  trace: Pick<PVTrace, 'useArchive'>,
  result: Pick<ArchiveSeriesResult, 'status' | 'mode' | 'decimated' | 'error'> | undefined
): string {
  if (!trace.useArchive) return 'Disabled';
  if (!result || result.status === 'idle') return 'Idle';
  if (result.status === 'loading') return 'Loading…';
  if (result.status === 'error') {
    // The PV is known (it may well be live); only the archiver lacks it.
    return archiveErrorNotice(result.error?.code) ?? result.error?.code ?? 'Error';
  }
  const mode = result.mode === 'binned' ? ' (binned)' : ' (raw)';
  return `Loaded${mode}${result.decimated ? ' · decimated' : ''}`;
}

// ---------------------------------------------------------- shared fields --

type Ctx<S, M, U extends ToolUi> = ToolContext<S, M, U>;

function curveAccess<S extends TraceDotState, M, U extends ToolUi>() {
  const curve = (ctx: Ctx<S, M, U>) => curveOf(ctx.state, ctx.target.id);
  const patch = (ctx: Ctx<S, M, U>, next: Partial<PVTrace>) => {
    const id = ctx.target.id;
    ctx.update((state) => patchCurve(state, id, next));
  };
  return { curve, patch };
}

/** Label (blank = the label follows the PV). */
export function curveDisplayNameField<
  S extends TraceDotState,
  M,
  U extends ToolUi = ToolUi,
>(): FieldDef<S, M, U> {
  const { curve, patch } = curveAccess<S, M, U>();
  return {
    id: 'display-name',
    label: LABELS.label,
    kind: 'text',
    tab: CURVE_TABS.signal,
    level: 'L1',
    placeholder: 'Follows the PV name',
    get: (ctx) => curve(ctx)?.displayName ?? '',
    set: (ctx, displayName) => patch(ctx, { displayName }),
  };
}

/** Plot on: the axes of the plot holding the curve. No automatic rule, so no dot. */
export function curveAxisField<S extends TraceDotState, M, U extends ToolUi = ToolUi>(): FieldDef<
  S,
  M,
  U
> {
  const { curve, patch } = curveAccess<S, M, U>();
  return {
    id: 'y-axis',
    label: LABELS.plotOn,
    kind: 'select',
    tab: CURVE_TABS.signal,
    level: 'L1',
    options: (ctx) =>
      (plotHoldingCurve(ctx.state, ctx.target.id)?.axes ?? []).map((a) => ({
        value: a.id,
        label: a.name,
      })),
    get: (ctx) => curve(ctx)?.axisId ?? '',
    set: (ctx, axisId) => {
      const plot = plotHoldingCurve(ctx.state, ctx.target.id);
      if (plot?.axes.some((a) => a.id === axisId)) patch(ctx, { axisId });
    },
  };
}

/** Visible: the card's eye. */
export function curveVisibleField<
  S extends TraceDotState,
  M,
  U extends ToolUi = ToolUi,
>(): FieldDef<S, M, U> {
  const { curve, patch } = curveAccess<S, M, U>();
  return {
    id: 'trace-visible',
    label: LABELS.visible,
    kind: 'toggle',
    tab: CURVE_TABS.signal,
    level: 'L1',
    row: 'eye',
    get: (ctx) => curve(ctx)?.visible ?? true,
    set: (ctx, visible) => patch(ctx, { visible }),
  };
}

/** Colour: the card's swatch, stamped dot. */
export function curveColourField<
  S extends TraceDotState,
  M extends TraceDotModel,
  U extends ToolUi = ToolUi,
>(): FieldDef<S, M, U> {
  const { curve, patch } = curveAccess<S, M, U>();
  return {
    id: 'trace-color',
    label: LABELS.colour,
    kind: 'colour',
    tab: CURVE_TABS.style,
    level: 'L1',
    row: 'swatch',
    get: (ctx) => curve(ctx)?.color ?? '',
    set: (ctx, color) => patch(ctx, { color }),
    ...curveColourDot<S, M, U>(),
  };
}

/**
 * The Style block: Colour · Line · Width · Dash · Markers · Marker · Marker
 * size, then Extend to now · Alarm colouring (PV curves) at L2.
 */
export function curveStyleTab<
  S extends TraceDotState,
  M extends TraceDotModel,
  U extends ToolUi = ToolUi,
>(): TabDef<S, M, U> {
  const { curve, patch } = curveAccess<S, M, U>();
  const markers = (ctx: Ctx<S, M, U>) => curve(ctx)?.showSymbol === true;
  return {
    ...CARD_BLOCKS.style,
    fields: [
      curveColourField<S, M, U>(),
      {
        id: 'line-type',
        label: LABELS.line,
        kind: 'select',
        tab: CURVE_TABS.style,
        level: 'L1',
        options: () => options(LINE_TYPE_OPTIONS),
        get: (ctx) => curve(ctx)?.lineType ?? 'step',
        set: (ctx, value) => {
          const known = LINE_TYPE_OPTIONS.find((o) => o.value === value);
          if (known) patch(ctx, { lineType: known.value });
        },
      },
      {
        id: 'line-width',
        label: LABELS.width,
        kind: 'number',
        tab: CURVE_TABS.style,
        level: 'L1',
        min: LINE_WIDTH_MIN,
        max: LINE_WIDTH_MAX,
        step: 0.5,
        unit: 'px',
        get: (ctx) => curve(ctx)?.lineWidth ?? null,
        set: (ctx, value) => {
          if (value !== null) patch(ctx, { lineWidth: value });
        },
      },
      {
        id: 'line-style',
        label: LABELS.dash,
        kind: 'select',
        tab: CURVE_TABS.style,
        level: 'L1',
        options: () => options(LINE_STYLE_OPTIONS),
        get: (ctx) => curve(ctx)?.lineStyle ?? 'solid',
        set: (ctx, value) => {
          const known = LINE_STYLE_OPTIONS.find((o) => o.value === value);
          if (known) patch(ctx, { lineStyle: known.value });
        },
      },
      {
        id: 'show-symbols',
        label: LABELS.markers,
        kind: 'toggle',
        tab: CURVE_TABS.style,
        level: 'L1',
        get: (ctx) => curve(ctx)?.showSymbol ?? false,
        set: (ctx, showSymbol) => patch(ctx, { showSymbol }),
      },
      {
        id: 'symbol-shape',
        label: LABELS.marker,
        kind: 'select',
        tab: CURVE_TABS.style,
        level: 'L1',
        when: markers,
        options: () => options(SYMBOL_OPTIONS),
        get: (ctx) => curve(ctx)?.symbolShape ?? 'circle',
        set: (ctx, value) => {
          const known = SYMBOL_OPTIONS.find((o) => o.value === value);
          if (known) patch(ctx, { symbolShape: known.value });
        },
      },
      {
        id: 'symbol-size',
        label: LABELS.markerSize,
        kind: 'number',
        tab: CURVE_TABS.style,
        level: 'L1',
        when: markers,
        min: SYMBOL_SIZE_MIN,
        max: SYMBOL_SIZE_MAX,
        step: 1,
        unit: 'px',
        get: (ctx) => curve(ctx)?.symbolSize ?? null,
        set: (ctx, value) => {
          if (value !== null) patch(ctx, { symbolSize: value });
        },
      },
      {
        id: 'extend-to-now',
        label: 'Extend to now',
        kind: 'toggle',
        tab: CURVE_TABS.style,
        level: 'L2',
        // Undefined is on; only "off" is stored, so the dot means "off".
        get: (ctx) => curve(ctx)?.showExtensionLine !== false,
        set: (ctx, on) => patch(ctx, { showExtensionLine: on ? undefined : false }),
        ...curveOptional<S, M, U>('showExtensionLine'),
      },
      {
        // ✚ Alarm colouring: tints the live curve by each sample's alarm
        // severity. Formula curves share this block but carry no severity, so
        // the field shows on PV curves only. Undefined is off; only "on" is
        // stored, so the dot means "on".
        id: 'alarm-coloring',
        label: 'Alarm colouring',
        kind: 'toggle',
        tab: CURVE_TABS.style,
        level: 'L2',
        when: (ctx) => curve(ctx)?.kind !== 'formula',
        get: (ctx) => curve(ctx)?.alarmColoring === true,
        set: (ctx, on) => patch(ctx, { alarmColoring: on ? true : undefined }),
        ...curveOptional<S, M, U>('alarmColoring'),
      },
    ],
  };
}

// ------------------------------------------------------------------ schema --

/** Trace's PV-curve item schema; call once at module level. */
export function createPvCurveSchema<
  S extends TraceDotState,
  M extends TraceCurveModel,
  U extends ToolUi = ToolUi,
>(): ObjectSchema<S, M, U> {
  type C = Ctx<S, M, U>;
  type Field = FieldDef<S, M, U>;
  const { curve, patch } = curveAccess<S, M, U>();
  const live = (ctx: C) => curve(ctx)?.useLive === true;
  const archive = (ctx: C) => curve(ctx)?.useArchive === true;
  const noPv = (ctx: C) => (curve(ctx)?.pvName ? false : NO_PV_REASON);
  const results = (ctx: C) => {
    const plot = plotHoldingCurve(ctx.state, ctx.target.id);
    return plot ? ctx.model.fragmentInput(plot) : undefined;
  };

  // One unit lookup in flight per curve: a newer PV aborts the older lookup,
  // so a stale answer never lands after the newer one. The owner's registry
  // when the model carries one, so a workspace load aborts these too.
  const ownLookups = new UnitLookups();
  const reassignUnit = async (ctx: C, pvName: string): Promise<void> => {
    const traceId = ctx.target.id;
    const plot = plotHoldingCurve(ctx.state, traceId);
    const trace = plot?.traces.find((t) => t.id === traceId);
    if (!plot || !trace) return;
    const lookups = ctx.model.unitLookups ?? ownLookups;
    const controller = lookups.start(traceId);
    const axisIdAtFetch = trace.axisId;
    let unit: string | undefined;
    try {
      const meta = await fetchMetadata(
        canopyConnection,
        pvName,
        trace.archiver ?? plot.archiver,
        controller.signal
      );
      unit = meta.units?.trim() || undefined;
    } catch {
      return; // no metadata (or aborted): the curve stays where it is
    } finally {
      lookups.settle(traceId, controller);
    }
    if (controller.signal.aborted || !unit) return;
    const found = unit;
    const newAxisId = makeId('axis');
    ctx.update((state) =>
      assignCurveToUnitAxis(state, traceId, found, axisIdAtFetch, newAxisId, pvName)
    );
  };
  const commitPv = (ctx: C, value: string) => {
    const pv = value.trim();
    const previous = curve(ctx)?.pvName;
    // A bare Enter re-commits the same PV: re-running the lookup would undo a
    // manual axis choice made after the PV was picked.
    if (previous === undefined || pv === previous) return;
    patch(ctx, { pvName: pv });
    if (pv) void reassignUnit(ctx, pv);
  };

  const signal: Field[] = [
    {
      id: 'pv-name',
      label: 'PV name',
      kind: 'custom',
      tab: CURVE_TABS.signal,
      level: 'L1',
      get: (ctx): string => curve(ctx)?.pvName ?? '',
      set: (ctx, pv: string) => commitPv(ctx, pv),
      render: ({ ctx, value, onChange, id }) => {
        const plot = plotHoldingCurve(ctx.state, ctx.target.id);
        return createElement(PvNameControl, {
          id,
          value: value as string,
          archiver: curve(ctx)?.archiver ?? plot?.archiver,
          onChange,
        });
      },
    },
    curveDisplayNameField<S, M, U>(),
    curveAxisField<S, M, U>(),
    curveVisibleField<S, M, U>(),
  ];

  const data: Field[] = [
    {
      id: 'use-live',
      label: 'Live',
      kind: 'toggle',
      tab: CURVE_TABS.data,
      level: 'L1',
      get: (ctx) => curve(ctx)?.useLive ?? false,
      set: (ctx, useLive) => patch(ctx, { useLive }),
    },
    {
      id: 'use-archive',
      label: 'Archive',
      kind: 'toggle',
      tab: CURVE_TABS.data,
      level: 'L1',
      get: (ctx) => curve(ctx)?.useArchive ?? false,
      set: (ctx, useArchive) => patch(ctx, { useArchive }),
    },
    {
      id: 'live-status',
      label: 'Live status',
      kind: 'readonly',
      tab: CURVE_TABS.data,
      level: 'L1',
      group: 'status',
      get: (ctx) => {
        const trace = curve(ctx);
        return trace ? liveStatusLabel(trace, results(ctx)?.liveResults.get(trace.id)) : '';
      },
    },
    {
      id: 'archive-status',
      label: 'Archive status',
      kind: 'readonly',
      tab: CURVE_TABS.data,
      level: 'L1',
      group: 'status',
      get: (ctx) => {
        const trace = curve(ctx);
        return trace ? archiveStatusLabel(trace, results(ctx)?.archiveResults.get(trace.id)) : '';
      },
    },
    {
      id: 'inspect-data',
      label: 'Inspect data',
      kind: 'action',
      tab: CURVE_TABS.data,
      level: 'L2',
      disabled: noPv,
      run: (ctx) => ctx.model.inspect(ctx.target.id),
    },
    {
      id: 'create-formula',
      label: 'Create formula from this curve',
      kind: 'action',
      tab: CURVE_TABS.data,
      level: 'L2',
      disabled: noPv,
      run: (ctx) => ctx.model.createFormula(ctx.target.id),
    },
    {
      id: 'live-retention',
      label: 'Live retention',
      kind: 'number',
      tab: CURVE_TABS.data,
      level: 'L3',
      when: live,
      min: LIVE_RETENTION_MIN_S,
      max: LIVE_RETENTION_MAX_S,
      step: 5,
      unit: 's',
      help: 'Empty follows the time range.',
      get: (ctx) => {
        const ms = curve(ctx)?.liveRetentionMs;
        return ms === undefined ? null : ms / 1000;
      },
      set: (ctx, value) =>
        patch(ctx, { liveRetentionMs: value === null ? undefined : Math.round(value * 1000) }),
      ...curveOptional<S, M, U>('liveRetentionMs'),
    },
    {
      id: 'curve-archiver',
      label: 'Archiver',
      kind: 'custom',
      tab: CURVE_TABS.data,
      level: 'L3',
      when: archive,
      get: (ctx): string | undefined => curve(ctx)?.archiver,
      set: (ctx, archiver: string | undefined) => patch(ctx, { archiver }),
      // "Use plot default" is undefined: the plot's archiver, else the backend's.
      render: ({ value, onChange, id }) =>
        createElement(
          'div',
          { id, className: 'trace-archiver' },
          createElement(ArchiverPicker, {
            value: value as string | undefined,
            onChange,
            includeGlobalOption: true,
            label: '',
            width: '100%',
          })
        ),
      ...curveOptional<S, M, U>('archiver'),
    },
    {
      id: 'show-archive-band',
      label: 'Min/max band',
      kind: 'toggle',
      tab: CURVE_TABS.data,
      level: 'L3',
      when: archive,
      // Undefined is on; only "off" is stored, so the dot means "off".
      get: (ctx) => curve(ctx)?.showArchiveBand !== false,
      set: (ctx, on) => patch(ctx, { showArchiveBand: on ? undefined : false }),
      ...curveOptional<S, M, U>('showArchiveBand'),
    },
    {
      id: 'optimized-bins',
      label: 'Optimized bins',
      kind: 'number',
      tab: CURVE_TABS.data,
      level: 'L3',
      when: archive,
      min: 1,
      max: OPTIMIZED_BINS_MAX,
      step: 100,
      help: `Empty uses ${DEFAULT_OPTIMIZED_BINS}.`,
      get: (ctx) => curve(ctx)?.optimizedDataBins ?? null,
      set: (ctx, value) =>
        patch(ctx, { optimizedDataBins: value === null ? undefined : Math.round(value) }),
      ...curveOptional<S, M, U>('optimizedDataBins'),
    },
  ];

  return {
    tabs: [
      { ...CARD_BLOCKS.signal, fields: signal },
      curveStyleTab<S, M, U>(),
      { ...CARD_BLOCKS.data, fields: data },
    ],
  };
}

/** The PV-curve schema over the state and model slices it reads. */
export const pvCurveSchema: ObjectSchema<TraceDotState, TraceCurveModel> = createPvCurveSchema<
  TraceDotState,
  TraceCurveModel
>();
