// Trace's binding half.
//
// Outline of the active plot only: sections are its Y-axes (id = axis
// id, kind `axis`, the axis's unit text as the unit tag — the Unit override,
// else the stamped EGU — a hidden axis muted, no capacity), rows are its
// curves on that axis (kind `curve` or `formula`). Switching the active plot
// re-roots the Outline; the selection reset that goes with it lives in
// `tool.ts`.
//
// Row status dots replace the struck Live/Archive header counts. A PV
// curve's dot is the worst of its enabled sources — Live connecting or
// waiting for a value, Archive loading: pending; Live disconnected, Archive
// error: error — and a curve with no PV yet is pending. A formula is pending
// until evaluated and error when the evaluation failed. An error row carries
// the source's status line as its text.
//
// Ops. `add(axisId, pv)` appends a curve with that PV onto that axis of the
// active plot, coloured by its position in the palette, and resolves at once;
// the unit lookup then runs behind it, as the PV-name field's does, and moves
// the curve onto its unit's axis (creating one) unless it was moved or given
// another PV meanwhile (`assignCurveToUnitAxis`). Lookups are registered in
// the model's `unitLookups`, which the owner aborts when a workspace loads. `remove` drops a
// curve. `move` retargets a curve to another axis of the same plot; there is
// no cross-plot move. `move`, the drag's drop check and the Y-axis
// field's options share one rule, `traceMoveRefusal`.
//
// Drawings: after the axis sections, a Drawings section (no
// add row, header eye on `ui`) lists the active plot's drawings by `objName`,
// status ok, or stale with "Axis hidden" when a value-bearing drawing's axis
// is hidden. It is appended only while the plot holds a drawing. `remove` and
// `moveRefusal` resolve an id against the active plot's drawings first: a
// drawing is removed through `withAnnotations` (undo comes from the owner's
// history-wrapped `update`) and never moves (`DRAWING_STAYS_REASON`).
//
// Footer: Add formula (onto the first axis, selected so its expression can be
// typed) and Add axis (selected). Formula controls are never hidden.
//
// Rate rule: `outline` returns the previous view-model object while nothing
// it shows changed, so a data tick re-renders no Outline.

import { Add, Function as FunctionIcon } from '@carbon/icons-react';
import { fetchMetadata } from '@slaclab/canopy-client';
import { canopyConnection } from '../../api/connection';
import { axisUnitText, newAxis, newFormula, newTrace } from '../../embed/plotConfig';
import type { ArchiveSeriesResult } from '../../hooks/useArchiveSeries';
import type { FormulaSeriesResult } from '../../hooks/useFormulaSeries';
import type { LiveSeriesResult } from '../../hooks/useLiveSeries';
import { drawingsSection } from '../../annotations/host/workbench';
import { BUILTIN_CATALOG } from '../../annotations/catalog';
import { TIME_X_AXIS } from '../../annotations/catalog/xAxis';
import { hasValueAxisIn } from '../../annotations/model';
import { DRAWING_STAYS_REASON } from '../shared/drawingOutline';
import { makeId } from '../../id';
import { archiveErrorNotice } from '../../api/archiveErrors';
import { colorForIndex } from '../../palettes';
import type { PvSearch } from '../../pvSearch';
import { traceLabel } from '../../traceLabel';
import type { Axis, Plot, PVTrace } from '../../types';
import type {
  Action,
  AddRefusal,
  OutlineRow,
  OutlineSection,
  OutlineViewModel,
  RowStatus,
  Selection,
  ToolBinding,
} from '../../workbench/types';
import { sameOutline } from '../../workbench/outlineCompare';
import { activePlot, type TraceDotState } from './dots';
import { removeAnnotation } from './schema/annotation';
import { AXIS_SECTION_KIND } from './schema/axis';
import {
  PV_CURVE_ITEM_KIND,
  archiveStatusLabel,
  assignCurveToUnitAxis,
  liveStatusLabel,
  patchCurve,
  plotHoldingCurve,
  UnitLookups,
  type TraceCurveModel,
} from './schema/curve';
import { FORMULA_CURVE_ITEM_KIND } from './schema/formula';

/** The add row's placeholder in every axis section. */
export const ADD_PV_PLACEHOLDER = 'Add PV';
export const ADD_FORMULA_ACTION_ID = 'add-formula';
export const ADD_AXIS_ACTION_ID = 'add-axis';

export const NO_PLOT_REASON = 'There is no plot to add to.';
export const NOT_ACTIVE_AXIS_REASON = 'That axis is not on the active plot.';
export const UNKNOWN_CURVE_REASON = 'That curve no longer exists.';
export const UNKNOWN_AXIS_REASON = 'That axis no longer exists.';
export const CROSS_PLOT_REASON = 'A curve moves only between axes of its own plot.';
/** The stale hint of a drawing row whose axis is hidden. */
export const AXIS_HIDDEN_HINT = 'Axis hidden';

/** Looks up a PV's engineering unit; `undefined` when it has none. */
export type UnitLookup = (
  pv: string,
  archiver: string | undefined,
  signal: AbortSignal
) => Promise<string | undefined>;

/** The Mole metadata lookup the PV-name field uses. */
export const moleUnitLookup: UnitLookup = async (pv, archiver, signal) => {
  const meta = await fetchMetadata(canopyConnection, pv, archiver, signal);
  return meta.units?.trim() || undefined;
};

/** What the binding needs from the tool's owner (TraceApp). */
export interface TraceBindingInput<S extends TraceDotState, M extends TraceCurveModel> {
  /** The latest state: an add, the footer and the unit lookup commit against it. */
  getState(): S;
  /** The latest model (the palette a new curve is coloured from). */
  getModel(): M;
  /** The tool's single writer. */
  update(fn: (state: S) => S): void;
  /** Selects what the footer created (the workbench selection, user origin). */
  select?(selection: Selection): void;
  /** The add rows' PV search; the workbench default when absent. */
  search?: PvSearch;
  /** The unit lookup after an add; Mole's metadata by default. */
  lookupUnit?: UnitLookup;
}

// ------------------------------------------------------------- move rule --

function plotHoldingAxis(state: TraceDotState, axisId: string): Plot | undefined {
  return state.plots.find((p) => p.axes.some((a) => a.id === axisId));
}

/** True iff `id` is a drawing of the active plot (the Outline lists only those). */
function isActiveDrawing(state: TraceDotState, id: string): boolean {
  return activePlot(state)?.annotations?.some((a) => a.id === id) ?? false;
}

/**
 * Why the curve `itemId` cannot move onto the axis `sectionId`, or `null`: the
 * one rule the row drag, `ops.move` and the Y-axis field's options share (the
 * field lists only the holding plot's axes). There is no cross-plot move.
 */
export function traceMoveRefusal(
  state: TraceDotState,
  itemId: string,
  sectionId: string
): string | null {
  // Drawings first: a drawing never moves, whichever section it is dropped on.
  if (isActiveDrawing(state, itemId)) return DRAWING_STAYS_REASON;
  const from = plotHoldingCurve(state, itemId);
  if (!from) return UNKNOWN_CURVE_REASON;
  const to = plotHoldingAxis(state, sectionId);
  if (!to) return UNKNOWN_AXIS_REASON;
  if (to.id !== from.id) return CROSS_PLOT_REASON;
  return null;
}

// ------------------------------------------------------------- transforms --

function mapPlot<S extends TraceDotState>(state: S, plotId: string, fn: (p: Plot) => Plot): S {
  return { ...state, plots: state.plots.map((p) => (p.id === plotId ? fn(p) : p)) };
}

/** `state` with `curve` appended to the plot holding its axis; unchanged when none does. */
export function appendCurve<S extends TraceDotState>(state: S, curve: PVTrace): S {
  const plot = plotHoldingAxis(state, curve.axisId);
  if (!plot || plot.traces.some((t) => t.id === curve.id)) return state;
  return mapPlot(state, plot.id, (p) => ({ ...p, traces: [...p.traces, curve] }));
}

/** `state` without the curve `id`; unchanged when no plot holds it. */
export function removeCurve<S extends TraceDotState>(state: S, id: string): S {
  const plot = plotHoldingCurve(state, id);
  if (!plot) return state;
  return mapPlot(state, plot.id, (p) => ({ ...p, traces: p.traces.filter((t) => t.id !== id) }));
}

/** `state` with the curve `id` on the axis `axisId`, when the shared rule allows it. */
export function moveCurve<S extends TraceDotState>(state: S, id: string, axisId: string): S {
  if (traceMoveRefusal(state, id, axisId) !== null) return state;
  const plot = plotHoldingCurve(state, id);
  if (plot?.traces.find((t) => t.id === id)?.axisId === axisId) return state;
  return patchCurve(state, id, { axisId });
}

/** `state` with `axis` appended to the plot `plotId`. */
export function appendAxis<S extends TraceDotState>(state: S, plotId: string, axis: Axis): S {
  if (!state.plots.some((p) => p.id === plotId)) return state;
  return mapPlot(state, plotId, (p) => ({ ...p, axes: [...p.axes, axis] }));
}

// ----------------------------------------------------------------- status --

const SEVERITY: Record<RowStatus, number> = { ok: 0, pending: 1, stale: 2, refused: 3, error: 4 };

function worst(a: RowStatus, b: RowStatus): RowStatus {
  return SEVERITY[b] > SEVERITY[a] ? b : a;
}

function liveStatus(result: LiveSeriesResult | undefined): RowStatus {
  switch (result?.status) {
    case 'connected':
      return result.connected ? 'ok' : 'pending';
    case 'disconnected':
      return 'error';
    default:
      return 'pending';
  }
}

function archiveStatus(result: ArchiveSeriesResult | undefined): RowStatus {
  switch (result?.status) {
    case 'ready':
      return 'ok';
    case 'error':
      return 'error';
    default:
      return 'pending';
  }
}

function formulaStatus(result: FormulaSeriesResult | undefined): RowStatus {
  if (result?.status === 'ready') return 'ok';
  if (result?.status === 'error') return 'error';
  return 'pending';
}

/** Results of one curve, as the plot's result maps hold them (by curve id). */
export interface CurveResults {
  live?: LiveSeriesResult;
  archive?: ArchiveSeriesResult;
  formula?: FormulaSeriesResult;
}

/** A curve row's status dot and, for an error, its text. */
export function curveRowStatus(
  curve: PVTrace,
  results: CurveResults
): { status: RowStatus; refusal?: string } {
  if (curve.kind === 'formula') {
    const status = formulaStatus(results.formula);
    if (status !== 'error') return { status };
    const error = results.formula?.error;
    return { status, refusal: `Formula: ${error?.detail || error?.code || 'Error'}` };
  }
  if (!curve.pvName) return { status: 'pending' };
  let status: RowStatus = 'ok';
  const errors: string[] = [];
  if (curve.useLive) {
    const live = liveStatus(results.live);
    status = worst(status, live);
    if (live === 'error') errors.push(`Live: ${liveStatusLabel(curve, results.live)}`);
  }
  if (curve.useArchive) {
    const archive = archiveStatus(results.archive);
    status = worst(status, archive);
    if (archive === 'error') {
      errors.push(
        archiveErrorNotice(results.archive?.error?.code) ??
          `Archive: ${archiveStatusLabel(curve, results.archive)}`
      );
    }
  }
  return errors.length > 0 ? { status, refusal: errors.join(' · ') } : { status };
}

// ---------------------------------------------------------------- outline --

function itemKind(curve: PVTrace): string {
  return curve.kind === 'formula' ? FORMULA_CURVE_ITEM_KIND : PV_CURVE_ITEM_KIND;
}

/** The Outline view-model of the active plot. */
export function traceOutline<S extends TraceDotState, M extends TraceCurveModel>(
  state: S,
  model: M,
  search?: PvSearch
): OutlineViewModel {
  const plot = activePlot(state);
  if (!plot) return { sections: [] };
  const input = model.fragmentInput(plot);
  const sections = plot.axes.map((axis): OutlineSection => {
    const curves = plot.traces.filter((t) => t.axisId === axis.id);
    const rows = curves.map((curve): OutlineRow => {
      const out: OutlineRow = {
        id: curve.id,
        kind: itemKind(curve),
        label: traceLabel(curve, plot.traces),
        ...curveRowStatus(curve, {
          live: input.liveResults.get(curve.id),
          archive: input.archiveResults.get(curve.id),
          formula: input.formulaResults.get(curve.id),
        }),
      };
      return out;
    });
    const add: NonNullable<OutlineSection['add']> = { placeholder: ADD_PV_PLACEHOLDER };
    if (search !== undefined) add.search = search;
    const section: OutlineSection = {
      id: axis.id,
      kind: AXIS_SECTION_KIND,
      title: axis.name,
      count: rows.length,
      rows,
      add,
    };
    const unit = axisUnitText(axis);
    if (unit) section.unit = unit;
    if (!axis.visible) section.muted = true;
    return section;
  });
  const drawings = plot.annotations ?? [];
  if (drawings.length > 0) sections.push(annotationsSection(plot));
  return { sections };
}

/**
 * The Drawings section of `plot`: the generic drawings section over
 * its drawings, a value-bearing drawing on a hidden axis dimmed with "Axis
 * hidden".
 */
function annotationsSection(plot: Plot): OutlineSection {
  return drawingsSection(
    plot.annotations ?? [],
    plot.axes,
    (a) => {
      const axis = plot.axes.find((x) => x.id === a.axisId);
      return hasValueAxisIn(BUILTIN_CATALOG, a.kind) && axis !== undefined && !axis.visible
        ? AXIS_HIDDEN_HINT
        : null;
    },
    { catalog: BUILTIN_CATALOG, xAxis: TIME_X_AXIS }
  );
}

// ---------------------------------------------------------------- binding --

/** Trace's `ToolBinding`; rebuild it when `update`, `select`, `search` or `lookupUnit` change. */
export function traceBinding<S extends TraceDotState, M extends TraceCurveModel>(
  input: TraceBindingInput<S, M>
): ToolBinding<S, M> {
  const { getState, getModel, update, select, search } = input;
  const lookupUnit = input.lookupUnit ?? moleUnitLookup;
  let last: OutlineViewModel | null = null;

  // One unit lookup in flight per curve; removing the curve aborts it. The
  // owner's registry when the model carries one, so a workspace load or an
  // unmount aborts these too.
  const ownLookups = new UnitLookups();
  const lookups = () => getModel().unitLookups ?? ownLookups;

  async function reassignUnit(curveId: string, pv: string, axisId: string, archiver?: string) {
    const registry = lookups();
    const controller = registry.start(curveId);
    let unit: string | undefined;
    try {
      unit = await lookupUnit(pv, archiver, controller.signal);
    } catch {
      return; // no metadata (or aborted): the curve stays where it was added
    } finally {
      registry.settle(curveId, controller);
    }
    if (controller.signal.aborted || !unit) return;
    const found = unit;
    const newAxisId = makeId('axis');
    update((state) => assignCurveToUnitAxis(state, curveId, found, axisId, newAxisId, pv));
  }

  async function add(sectionId: string, raw: string): Promise<AddRefusal | void> {
    const pv = raw.trim();
    if (pv === '') return;
    const plot = activePlot(getState());
    if (!plot) return { message: NO_PLOT_REASON };
    if (!plot.axes.some((a) => a.id === sectionId)) return { message: NOT_ACTIVE_AXIS_REASON };
    const id = makeId('trace');
    // displayName stays '': the row label follows the PV.
    const curve = newTrace(
      id,
      pv,
      sectionId,
      colorForIndex(getModel().palette, plot.traces.length),
      []
    );
    update((state) => appendCurve(state, curve));
    void reassignUnit(id, pv, sectionId, plot.archiver);
  }

  function addFormula(): void {
    const plot = activePlot(getState());
    const axis = plot?.axes[0];
    if (!plot || !axis) return;
    const id = makeId('formula');
    const formula = newFormula(id, axis.id, colorForIndex(getModel().palette, plot.traces.length));
    update((state) => appendCurve(state, formula));
    select?.({ level: 'item', kind: FORMULA_CURVE_ITEM_KIND, id });
  }

  function addAxis(): void {
    const plot = activePlot(getState());
    if (!plot) return;
    const id = makeId('axis');
    const axis = newAxis(id, plot.axes.length);
    update((state) => appendAxis(state, plot.id, axis));
    select?.({ level: 'section', kind: AXIS_SECTION_KIND, id });
  }

  const footer: Action[] = [
    {
      id: ADD_FORMULA_ACTION_ID,
      label: 'Add formula',
      icon: FunctionIcon,
      kind: 'button',
      onClick: addFormula,
    },
    { id: ADD_AXIS_ACTION_ID, label: 'Add axis', icon: Add, kind: 'button', onClick: addAxis },
  ];

  return {
    outline(state, model) {
      const next = traceOutline(state, model, search);
      if (last !== null && sameOutline(last, next)) return last;
      last = next;
      return next;
    },
    ops: {
      add,
      remove(itemId) {
        if (isActiveDrawing(getState(), itemId)) {
          update((state) => removeAnnotation(state, itemId));
          return;
        }
        lookups().abort(itemId);
        update((state) => removeCurve(state, itemId));
      },
      move(itemId, sectionId) {
        if (traceMoveRefusal(getState(), itemId, sectionId) !== null) return;
        update((state) => moveCurve(state, itemId, sectionId));
      },
    },
    moveRefusal: (itemId, sectionId) => traceMoveRefusal(getState(), itemId, sectionId),
    footer,
  };
}
