// Waveform field schemas; the layout is listed in ./index.ts.
//
// The Annotations section over `state.drawings`, from the generic workbench
// pieces and the pieces Correlation shares (../../shared/drawingOutline.ts).
// Every write goes through `ctx.update`, so the app's writer runs `apply` and
// records drawing history (undoable). The section header's eye is the plot's
// Hide all (`ui.drawingsHidden`).

import { WAVEFORM_CATALOG } from '../../../annotations/catalog';
import type { AxisRef } from '../../../annotations/catalog/types';
import type { DrawingAccess } from '../../../annotations/host/workbench';
import type { SectionSchema, ToolContext } from '../../../workbench/types';
import {
  drawingsVisibleSection,
  patchListedDrawing,
  type DrawingsUiWriter,
} from '../../shared/drawingOutline';
import { WAVEFORM_AXIS_ID } from '../drawings';
import { removeDrawing } from '../edit';
import type { WaveformState } from '../query';
import type { WaveformSchemaOptions, WaveformUi, WaveformUiWriter } from './common';

type S = WaveformState;

/** Waveform's one drawing axis: the y axis. */
export const WAVEFORM_DRAWING_AXES: readonly AxisRef[] = [{ id: WAVEFORM_AXIS_ID, name: 'Y' }];

/** How the generic drawing schema reaches Waveform's drawings: `state.drawings`. */
export const WAVEFORM_DRAWING_ACCESS: DrawingAccess<S> = {
  list: (state) => state.drawings,
  patch: patchListedDrawing,
  remove: (state, id) => removeDrawing(state, id, WAVEFORM_CATALOG),
  axes: () => WAVEFORM_DRAWING_AXES,
};

interface UiWithWriter {
  drawingsHidden?: boolean;
  setUi?: WaveformUiWriter;
}

/** The Annotations section; its eye writes the `ui` record's own writer, else `options.setUi`. */
export function drawingsSectionSchema<M, U extends WaveformUi>(
  options: WaveformSchemaOptions
): SectionSchema<S, M, U> {
  return drawingsVisibleSection<S, M, U>(
    (ctx: ToolContext<S, M, U>) =>
      ((ctx.ui as UiWithWriter).setUi ?? options.setUi) as DrawingsUiWriter | undefined
  );
}
