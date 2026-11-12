// Trace's `ToolDefinition`.
//
// The schema half is built once, here, at module level: the plot as the
// tool-level object (the active plot), Y-axes (listed under Signals,
// their fields in Axes) and the drawings section (under Drawings, its header
// eye on `ui`) as sections, PV and formula curves and drawings as
// items. The factories are generic over the state and model so a TraceApp
// whose state grows beyond `TraceDotState` builds its own with
// `createTraceSchema`.
//
// The binding half (`outline.ts`) is rebuilt by `useTraceDefinition` only when
// its writer, selection, search or unit lookup change; ops read the latest
// state and model through a holder updated after every render.
//
// Selection reset: when the active plot changes the selection goes back
// to the tool level, without revealing Properties. `useTraceDefinition` does
// it for the store it is handed.

import { useMemo } from 'react';
import type { PvSearch } from '../../pvSearch';
import { useResetOnChange, type SelectionStore } from '../../workbench/selection';
import type { ToolDefinition, ToolSchema, ToolUi } from '../../workbench/types';
import { useLatest } from '../../workbench/useLatest';
import type { TraceDotState } from './dots';
import { traceBinding, type TraceBindingInput, type UnitLookup } from './outline';
import { DRAWING_ITEM_KIND, DRAWINGS_SECTION_KIND } from '../../annotations/host/workbench';
import { createAnnotationSchema } from './schema/annotation';
import { createAnnotationsSectionSchema } from './schema/annotations';
import { AXIS_SECTION_KIND, traceAxisSchema } from './schema/axis';
import { PV_CURVE_ITEM_KIND, createPvCurveSchema, type TraceCurveModel } from './schema/curve';
import { FORMULA_CURVE_ITEM_KIND, createFormulaCurveSchema } from './schema/formula';
import { createPlotSchema } from './schema/plot';

export type { TraceBindingInput, UnitLookup } from './outline';

/** Trace's tool state: its plots and which one the Outline binds to. */
export type TraceState = TraceDotState;
/** Trace's tool model: palette, chart-option input, Inspect data, Create formula. */
export type TraceModel = TraceCurveModel;

/**
 * Trace's per-tool UI record, handed to the workbench as `ui`:
 * which plots hide their drawings. Session-only; no `Plot` field changes. The
 * type lives here, not in components, because tools never import from
 * components.
 */
export interface TraceUi {
  /** Plot ids whose drawings are hidden (the Annotations header eye). */
  annotationsHidden: ReadonlySet<string>;
  /** Hide (`on = true`) or show a plot's drawings. */
  setAnnotationsHidden(plotId: string, on: boolean): void;
}

/** Trace's schema half for a state `S` and model `M`; call once at module level. */
export function createTraceSchema<
  S extends TraceDotState,
  M extends TraceCurveModel,
  U extends ToolUi = ToolUi,
>(): ToolSchema<S, M, U> {
  return {
    tool: createPlotSchema<S, M, U>(),
    sections: {
      [AXIS_SECTION_KIND]: traceAxisSchema<S, M, U>(),
      [DRAWINGS_SECTION_KIND]: createAnnotationsSectionSchema<S, M, U>(),
    },
    items: {
      [PV_CURVE_ITEM_KIND]: createPvCurveSchema<S, M, U>(),
      [FORMULA_CURVE_ITEM_KIND]: createFormulaCurveSchema<S, M, U>(),
      [DRAWING_ITEM_KIND]: createAnnotationSchema<S, M, U>(),
    },
  };
}

/** Trace's schema half, built once. */
export const TRACE_SCHEMA: ToolSchema<TraceState, TraceModel, TraceUi> = createTraceSchema<
  TraceState,
  TraceModel,
  TraceUi
>();

/** Trace's whole definition; call per render with the latest inputs. */
export function traceDefinition(
  input: TraceBindingInput<TraceState, TraceModel>
): ToolDefinition<TraceState, TraceModel, TraceUi> {
  return { schema: TRACE_SCHEMA, binding: traceBinding(input) };
}

/** What `useTraceDefinition` reads each render. */
export interface TraceDefinitionInputs {
  state: TraceState;
  model: TraceModel;
  update(fn: (state: TraceState) => TraceState): void;
  /** The workbench selection: the footer selects what it adds; reset on a plot switch. */
  selection?: SelectionStore;
  search?: PvSearch;
  lookupUnit?: UnitLookup;
}

/**
 * The definition for TraceApp: the binding reads the latest state and model,
 * and is rebuilt only when `update`, `selection`, `search` or `lookupUnit`
 * change. When the active plot changes, `selection` is reset.
 */
export function useTraceDefinition(
  inputs: TraceDefinitionInputs
): ToolDefinition<TraceState, TraceModel, TraceUi> {
  // Ops read the latest state and model, after the render that built them.
  const latest = useLatest(inputs);
  const { update, selection, search, lookupUnit } = inputs;

  useResetOnChange(inputs.state.activePlotId, selection);

  return useMemo(() => {
    const input: TraceBindingInput<TraceState, TraceModel> = {
      getState: () => latest.current.state,
      getModel: () => latest.current.model,
      update,
    };
    if (selection !== undefined) input.select = (s) => selection.select(s, 'user');
    if (search !== undefined) input.search = search;
    if (lookupUnit !== undefined) input.lookupUnit = lookupUnit;
    return traceDefinition(input);
  }, [latest, update, selection, search, lookupUnit]);
}
