// Trace's drawing item schema.
//
//   Drawing — Kind (read-only), Label, Colour (the Layers row swatch), Width,
//             Style (solid / dashed), Axis (only for kinds whose points carry
//             a value), Value (H-line only), Extend (trend only), Locked (the
//             row's lock glyph), Visible (the row's eye: `!hidden`, so a
//             hidden drawing's Layers row renders muted), Delete.
//
// The schema itself is the generic drawing schema (annotations/host/workbench)
// instantiated over Trace's plots: the item target is the drawing id, and
// every field finds the drawing in whichever plot holds it. Every write
// is a pure transform of that plot through `withAnnotations`.
//
// No field carries a modified dot: a drawing's style has no "automatic"
// state the Inspector could reset to (its colour is stamped at creation).
//
// Built by a generic factory so `tool.ts` instantiates it once, at module
// level, with Trace's concrete state and model.

import type { Annotation } from '../../../annotations/model';
import { withAnnotations } from '../drawing/plotDrawings';
import { BUILTIN_CATALOG } from '../../../annotations/catalog';
import { createDrawingSchema, type DrawingAccess } from '../../../annotations/host/workbench';
import type { Plot } from '../../../types';
import type { ObjectSchema, ToolUi } from '../../../workbench/types';
import type { TraceDotState } from '../dots';

// ---------------------------------------------------------------- locating --

function plotHolding(state: TraceDotState, id: string): Plot | undefined {
  return state.plots.find((p) => p.annotations?.some((a) => a.id === id));
}

function mapPlot<S extends TraceDotState>(state: S, plotId: string, fn: (p: Plot) => Plot): S {
  return { ...state, plots: state.plots.map((p) => (p.id === plotId ? fn(p) : p)) };
}

/**
 * `state` with the drawing `id` replaced by `fn(drawing)`; unchanged (same
 * object) when no plot holds it or `fn` returns the drawing itself.
 */
export function patchAnnotation<S extends TraceDotState>(
  state: S,
  id: string,
  fn: (a: Annotation) => Annotation
): S {
  const plot = plotHolding(state, id);
  const current = plot?.annotations?.find((a) => a.id === id);
  if (!plot || !current) return state;
  const next = fn(current);
  if (next === current) return state;
  return mapPlot(state, plot.id, (p) =>
    withAnnotations(
      p,
      (p.annotations ?? []).map((a) => (a.id === id ? next : a))
    )
  );
}

/** `state` without the drawing `id`; an emptied list deletes the plot's key. */
export function removeAnnotation<S extends TraceDotState>(state: S, id: string): S {
  const plot = plotHolding(state, id);
  if (!plot) return state;
  return mapPlot(state, plot.id, (p) =>
    withAnnotations(
      p,
      (p.annotations ?? []).filter((a) => a.id !== id)
    )
  );
}

// ------------------------------------------------------------------ schema --

/** How the generic drawing schema reaches Trace's drawings: through the plot holding each. */
function plotAccess<S extends TraceDotState>(): DrawingAccess<S> {
  return {
    list: (state, id) => plotHolding(state, id)?.annotations ?? [],
    patch: patchAnnotation,
    remove: removeAnnotation,
    axes: (state, id) => plotHolding(state, id)?.axes ?? [],
  };
}

/** Trace's drawing item schema; call once at module level. */
export function createAnnotationSchema<
  S extends TraceDotState,
  M,
  U extends ToolUi = ToolUi,
>(): ObjectSchema<S, M, U> {
  return createDrawingSchema<S, M, U>(plotAccess<S>(), { catalog: BUILTIN_CATALOG });
}

/** The drawing item schema for Trace's base state, for tests that need no concrete model. */
export const annotationSchema: ObjectSchema<TraceDotState, unknown> = createAnnotationSchema<
  TraceDotState,
  unknown
>();
