// The Drawings section pieces the plot tools share. Every tool refuses to move
// a drawing out of the Drawings section (`DRAWING_STAYS_REASON`) and names the
// section header's eye `DRAWINGS_VISIBLE_FIELD_ID`. Correlation and Waveform
// also keep their drawings in one `state.drawings` list and bind the eye to
// `ui.drawingsHidden` (the plot's Hide all).

import type { Annotation } from '../../annotations/model';
import { createDrawingsSectionSchema } from '../../annotations/host/workbench';
import type { SectionSchema, ToolContext, ToolUi } from '../../workbench/types';

/** Why a drawing row cannot be dragged to another section. */
export const DRAWING_STAYS_REASON = 'Drawings stay in Drawings.';

/** The Drawings section header eye's field id (its `data-testid`). */
export const DRAWINGS_VISIBLE_FIELD_ID = 'drawings-visible';

/** A tool state that holds its drawings in one list. */
export interface DrawingListState {
  drawings: readonly Annotation[];
}

/** True when `id` is one of `state`'s drawings. */
export function isListedDrawing(state: DrawingListState, id: string): boolean {
  return state.drawings.some((a) => a.id === id);
}

/**
 * `state` with the drawing `id` replaced by `fn(drawing)` (its id kept);
 * `state` itself for an unknown id or when `fn` changes nothing.
 */
export function patchListedDrawing<S extends DrawingListState>(
  state: S,
  id: string,
  fn: (a: Annotation) => Annotation
): S {
  const current = state.drawings.find((a) => a.id === id);
  if (current === undefined) return state;
  const next = fn(current);
  if (next === current) return state;
  return { ...state, drawings: state.drawings.map((a) => (a.id === id ? { ...next, id } : a)) };
}

/** What the eye reads and writes of a tool's `ui` record. */
export interface DrawingsHiddenUi {
  drawingsHidden?: boolean;
}

/** A writer of the `ui` record: commits `fn(ui)`; returning `ui` unchanged commits nothing. */
export type DrawingsUiWriter = (fn: <R extends DrawingsHiddenUi>(ui: R) => R) => void;

/**
 * The Drawings section with its header eye: shown unless
 * `ui.drawingsHidden`; a toggle writes through `writer(ctx)`, and writing the
 * value already held commits nothing. A workbench mounted with `ui: {}` shows
 * all.
 */
export function drawingsVisibleSection<S, M, U extends ToolUi>(
  writer: (ctx: ToolContext<S, M, U>) => DrawingsUiWriter | undefined
): SectionSchema<S, M, U> {
  return createDrawingsSectionSchema<S, M, U>({
    id: DRAWINGS_VISIBLE_FIELD_ID,
    get: (ctx) => (ctx.ui as DrawingsHiddenUi | undefined)?.drawingsHidden !== true,
    set: (ctx, visible) =>
      writer(ctx)?.((ui) =>
        (ui.drawingsHidden === true) === !visible ? ui : { ...ui, drawingsHidden: !visible }
      ),
  });
}
