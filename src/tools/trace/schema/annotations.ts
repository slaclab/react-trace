// Trace's Drawings section schema.
//
// One section per active plot, listing its drawings under the Drawings group;
// it has no add row (drawings are made on the plot). Its only field is the
// header eye, a
// Visible toggle on the tool's `ui` record: it reads
// `!ui.annotationsHidden.has(plotId)` for the active plot and writes
// `ui.setAnnotationsHidden(plotId, !visible)`. No `Plot` field changes, so
// hiding the drawings is not an undo step and is not saved.
//
// `ctx.ui` is read defensively: a workbench mounted without Trace's `ui`
// (tests, a tool host that passes `{}`) shows every drawing and ignores the
// toggle rather than throwing.
//
// The section is the generic drawings section schema (annotations/host/
// workbench) with Trace's eye. Built by a generic factory so `tool.ts`
// instantiates it once, at module level, with Trace's concrete state and
// model.

import { createDrawingsSectionSchema } from '../../../annotations/host/workbench';
import type { SectionSchema, ToolContext, ToolUi } from '../../../workbench/types';
import { DRAWINGS_VISIBLE_FIELD_ID } from '../../shared/drawingOutline';
import { GROUPS } from '../../vocabulary';
import { activePlot, type TraceDotState } from '../dots';

/** The slice of Trace's `ui` record the header eye reads (structurally `TraceUi`). */
interface HiddenUi {
  annotationsHidden?: ReadonlySet<string>;
  setAnnotationsHidden?(plotId: string, on: boolean): void;
}

/** Trace's Drawings section schema; call once at module level. */
export function createAnnotationsSectionSchema<
  S extends TraceDotState,
  M,
  U extends ToolUi = ToolUi,
>(): SectionSchema<S, M, U> {
  type Ctx = ToolContext<S, M, U>;
  const hiddenUi = (ctx: Ctx) => ctx.ui as HiddenUi;

  const section = createDrawingsSectionSchema<S, M, U>({
    id: DRAWINGS_VISIBLE_FIELD_ID,
    get: (ctx) => {
      const plotId = activePlot(ctx.state)?.id;
      if (plotId === undefined) return true;
      return !(hiddenUi(ctx).annotationsHidden?.has(plotId) ?? false);
    },
    set: (ctx, on) => {
      const plotId = activePlot(ctx.state)?.id;
      if (plotId === undefined) return;
      hiddenUi(ctx).setAnnotationsHidden?.(plotId, !on);
    },
  });
  return { ...section, group: GROUPS.drawings };
}
