// Correlation field schemas; the layout is listed in ./index.ts.
//
// The Annotations section and drawing access over `state.drawings`, from the
// generic workbench pieces and the pieces Waveform shares
// (../../shared/drawingOutline.ts).

import type { Annotation } from '../../../annotations/model';
import { CORRELATION_CATALOG } from '../../../annotations/catalog';
import type { DrawingAccess } from '../../../annotations/host/workbench';
import type { SectionSchema } from '../../../workbench/types';
import {
  drawingsVisibleSection,
  patchListedDrawing,
  type DrawingsUiWriter,
} from '../../shared/drawingOutline';
import { apply, removeDrawing } from '../edit';
import type { CorrelationUi, S } from './common';

/** Why a PV row cannot be dropped on the Annotations section. */
export const ANNOTATIONS_ONLY_REASON = 'Annotations lists drawings only.';

/** The Y axes drawings may belong to: the Ys, by label (the Axis field's options). */
export function correlationDrawingAxes(state: S): { id: string; name: string }[] {
  return state.ys.map((pv) => ({
    id: pv,
    name: Object.hasOwn(state.labels, pv) ? state.labels[pv] : pv,
  }));
}

/**
 * `state` with the drawing `id` replaced by `fn(drawing)`, through the
 * normalizer; `state` itself for an unknown id or when `fn` changes nothing.
 */
export function patchCorrelationDrawing(
  state: S,
  id: string,
  fn: (a: Annotation) => Annotation
): S {
  const next = patchListedDrawing(state, id, fn);
  return next === state ? state : apply(state, () => next, CORRELATION_CATALOG);
}

/** How the generic drawing schema reaches Correlation's one drawing list. */
export const CORRELATION_DRAWING_ACCESS: DrawingAccess<S> = {
  list: (state) => state.drawings,
  patch: patchCorrelationDrawing,
  remove: (state, id) => removeDrawing(state, id, CORRELATION_CATALOG),
  axes: (state) => correlationDrawingAxes(state),
};

/** The Annotations section; its eye writes through the `ui` record's `setUi`. */
export function drawingsSectionSchema<M, U extends CorrelationUi>(): SectionSchema<S, M, U> {
  return drawingsVisibleSection<S, M, U>(
    (ctx) => (ctx.ui as CorrelationUi | undefined)?.setUi as DrawingsUiWriter | undefined
  );
}
