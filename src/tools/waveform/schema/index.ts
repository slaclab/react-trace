// Waveform's field schemas.
//
//   Tool      Acquisition — Persistence 1–16 (bars show only the latest
//                           frame), Average 1–64; More: Element range
//                           (custom field), Decimation, Update-rate cap
//             Axes        — Y axis: Unit (read-only, automatic),
//                           Auto-scale, Min / Max only while Auto-scale is
//                           off, Log scale; X axis: Plot against (Element # /
//                           X axis PV), Auto-scale, Min / Max (in the drawn
//                           X's units)
//             Display     — Legend, Grid, Crosshair, Data tooltip, Mouse drag
//             Statistics  — the shared statistics fields
//             Code        — the chart option without series
//   Section   Live        — under Signals; no fields of its own (its axis is
//                           the Axes section's Y axis)
//             Reference   — Source (read-only), Subtract reference (only
//                           while a reference exists or Δ is on), Rolling
//                           mean, Window, Spread band, Draw as
//             X           — under X axis PV; no fields of its own (its axis is
//                           the Axes section's X axis)
//   Item      Live        — Signal: Label, Plot on (`#group`), Visible
//                           (card eye); Style: Colour (card swatch), Line,
//                           Width, Dash
//             Reference   — Signal: Label, Visible (PV reference only: a
//                           snapshot holds no PV to hide); Style: Colour, Width
//             X           — Signal: Label (the X-axis title), Plot on
//
// Targets. Section ids and kinds are the group (`live`, `reference`,
// `xsource`, as `../edit.ts` names them). An item's kind is its
// group and its id `<group>:<pv>`; the snapshot reference, which holds no PV,
// is the item `snapshot` of kind `reference`.
//
// Every write goes through `../edit.ts`, the state's one writer, and
// so ends in the normalizer. Dots: a curve's style fields are pinned
// iff its record holds the field (reset deletes it); Visible iff the `hidden`
// record holds the PV; the X title iff `xLabel` is set; the snapshot's style
// iff the snapshot's own record holds the field; Element range and the axis
// Min / Max (Y and X) iff a value is present. Required settings (the toggles,
// Persistence, Average, Decimation, Update-rate cap, Plot against, Draw as) carry
// no dot, as Correlation's.
//
// `waveformMoveRefusal` is the one move rule: the Plot on select's
// disabled options come from it here, and the binding's `moveRefusal` reuses
// it. Built by a generic factory so `tool.ts` instantiates it once, at module
// level, with its concrete model and ui.

import { WAVEFORM_CATALOG } from '../../../annotations/catalog';
import {
  createDrawingSchema,
  DRAWING_ITEM_KIND,
  DRAWINGS_SECTION_KIND,
} from '../../../annotations/host/workbench';
import { GROUPS } from '../../vocabulary';
import type { ToolSchema } from '../../../workbench/types';
import {
  type S,
  type WaveformSchemaModel,
  type WaveformSchemaOptions,
  type WaveformUi,
} from './common';
import { referenceItem, liveItem, xSourceItem } from './items';
import { liveSection, referenceSection, xSourceSection } from './sections';
import { toolSchema } from './tool';
import { drawingsSectionSchema, WAVEFORM_DRAWING_ACCESS } from './drawings';

export {
  axesSummary,
  commitDecimation,
  DEFAULT_LINE_WIDTH,
  GROUP_LABELS,
  isGroup,
  parseWaveformItemId,
  patchXScale,
  patchYScale,
  referenceSourceText,
  ROLLING_ITEM_ID,
  SNAPSHOT_ITEM_ID,
  statisticsSummary,
  WAVEFORM_GROUPS,
  waveformItemId,
  waveformMoveRefusal,
  type WaveformSchemaModel,
  type WaveformSchemaOptions,
  type WaveformUi,
  type WaveformUiWriter,
} from './common';
export { WAVEFORM_DRAWING_ACCESS, WAVEFORM_DRAWING_AXES } from './drawings';

/** Waveform's whole schema half; call once at module level (or once per owner with a writer). */
export function waveformSchema<
  M extends WaveformSchemaModel = WaveformSchemaModel,
  U extends WaveformUi = WaveformUi,
>(options: WaveformSchemaOptions = {}): ToolSchema<S, M, U> {
  return {
    tool: toolSchema<M, U>(),
    sections: {
      live: liveSection<M, U>(),
      reference: referenceSection<M, U>(),
      xsource: xSourceSection<M, U>(),
      [DRAWINGS_SECTION_KIND]: { ...drawingsSectionSchema<M, U>(options), group: GROUPS.drawings },
    },
    items: {
      live: liveItem<M, U>(),
      reference: referenceItem<M, U>(),
      xsource: xSourceItem<M, U>(),
      [DRAWING_ITEM_KIND]: createDrawingSchema<S, M, U>(WAVEFORM_DRAWING_ACCESS, {
        catalog: WAVEFORM_CATALOG,
      }),
    },
  };
}
