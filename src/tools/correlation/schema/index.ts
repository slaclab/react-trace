// Correlation's field schemas.
//
//   Plot     Acquisition — Max points (`n`), Lookback (custom field)
//            Axes        — Y axis: Layout (`#y-layout`, scatter view only),
//                          Unit (read-only, automatic), Auto-scale, Min / Max
//                          only while Auto-scale is off, Log scale; X axis:
//                          the same without Layout (`x-axis-*` ids)
//            Display     — Plot as (Scatter / Density), Density Y
//                          (`#density-y`, density view only), Fit line, Fade
//                          older points, Legend, Grid, Crosshair, Data
//                          tooltip, Mouse drag
//            Statistics  — the shared statistics fields (`readout`, metrics)
//            Code        — the chart option without series
//   Section  Y           — Signals; no fields (its axis is Axes › Y axis)
//            X           — X axis PV; no fields (its axis is Axes › X axis)
//            Trigger     — header: Source (`trigger-source`: Timer / PV);
//                          settings: Period (Timer only), Fire on
//                          (`#trigger-fire`: Every update / Rising / Falling,
//                          PV only)
//   Item     Y           — Signal: Label, Plot on (`#role`), Visible (card
//                          eye); Style: Colour (card swatch), Marker, Marker
//                          size, Opacity (the marker fields scatter view only)
//            X           — Signal: Label (the X-axis title), Plot on
//            Trigger     — Signal: Plot on (neither Label nor Colour)
//
// Targets. Section ids and kinds are the role (`x`, `y`, `trig`); an item id is
// `<role>:<pv>` (a PV may be both the X and a Y) and its kind the role, so each
// role has its own item schema. The axis fields are plot-level: each copy
// names the scale it writes (`xScale`, `yScale`).
//
// Every write goes through `../edit.ts`, the state's one writer, and so ends
// in the normalizer. Dots come only from the record-key and optional-path
// helpers: a per-PV record present, an optional value present. Picking the
// positional colour still writes the record, so it sets the dot (the colour is
// then pinned against reordering). Required settings (the toggles, `n`,
// `lookback`, the view) carry no dot, as Trace's required fields.
//
// The Trigger Source reads `mode === 'pv' || ctx.ui.pendingTrigger`, and so do
// the visibility rules of Period and Fire on. Fire on is disabled while the PV
// is still pending: the normalizer drops `fire` outside PV mode, so a pick
// before the PV is committed would write nothing. Choosing PV writes nothing
// to state: it asks the binding to raise `pendingTrigger` through
// `ctx.ui.setPendingTrigger`, whose lifecycle the outline binding owns.
//
// `correlationMoveRefusal` is the one move rule: the Plot on select's disabled
// options come from it here, and the binding's `moveRefusal` reuses it.
//
// Drawings. The Annotations section and the `annotation` item are the generic
// drawing schemas (annotations/host/workbench) over `state.drawings`, with
// Correlation's catalog. Every drawing write is `ctx.update` through the
// state's writer, so it lands in the drawing ring and ⌘Z undoes it. The
// section's header eye is the transient `ui.drawingsHidden`, written through
// `ui.setUi`; it is not an undo step and is not saved. `ctx.ui` is read
// defensively: a workbench mounted with `{}` shows every drawing and ignores
// the toggle.
//
// Built by a generic factory so `tool.ts` instantiates it once, at module
// level, with its concrete model and ui. The pieces live beside this file:
// common.ts (types, targets, the move rule, field helpers), axes.ts and
// tool.ts (the Plot tabs), sections.ts (Trigger), items.ts (Y, X, Trigger)
// and drawings.ts (Annotations).

import { CORRELATION_CATALOG } from '../../../annotations/catalog';
import {
  createDrawingSchema,
  DRAWING_ITEM_KIND,
  DRAWINGS_SECTION_KIND,
} from '../../../annotations/host/workbench';
import { MAX_Y } from '../query';
import { GROUPS } from '../../vocabulary';
import type { ToolSchema } from '../../../workbench/types';
import type { CorrelationSchemaModel, CorrelationUi, S } from './common';
import { CORRELATION_DRAWING_ACCESS, drawingsSectionSchema } from './drawings';
import { triggerItem, xItem, yItem } from './items';
import { triggerSection } from './sections';
import { toolSchema } from './tool';

export {
  CORRELATION_ROLES,
  correlationItemId,
  correlationMoveRefusal,
  isRole,
  parseCorrelationItemId,
  patchScale,
  ROLE_LABELS,
  triggerSource,
  type CorrelationSchemaModel,
  type CorrelationUi,
} from './common';
export {
  ANNOTATIONS_ONLY_REASON,
  CORRELATION_DRAWING_ACCESS,
  correlationDrawingAxes,
  patchCorrelationDrawing,
} from './drawings';
export { FADE_OPACITY_REASON } from './items';

/** Correlation's whole schema half; call once at module level. */
export function correlationSchema<
  M extends CorrelationSchemaModel = CorrelationSchemaModel,
  U extends CorrelationUi = CorrelationUi,
>(): ToolSchema<S, M, U> {
  return {
    tool: toolSchema<M, U>(),
    sections: {
      y: { group: GROUPS.signals, capacity: MAX_Y, tabs: [] },
      x: { group: GROUPS.xPv, capacity: 1, tabs: [] },
      trig: triggerSection<M, U>(),
      [DRAWINGS_SECTION_KIND]: { ...drawingsSectionSchema<M, U>(), group: GROUPS.drawings },
    },
    items: {
      y: yItem<M, U>(),
      x: xItem<M, U>(),
      trig: triggerItem<M, U>(),
      [DRAWING_ITEM_KIND]: createDrawingSchema<S, M, U>(CORRELATION_DRAWING_ACCESS, {
        catalog: CORRELATION_CATALOG,
      }),
    },
  };
}
