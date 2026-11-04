// Trace's formula-curve item schema. The blocks of its card:
//
//   Signal  Label · Formula (custom editor, `{x1}` bindings and validation;
//           the expression textarea is `#formula-expression`, bindings
//           `#formula-bind-<var>`) · Plot on · Visible (the card's eye)
//   Style   the PV curve's own Style block, shared, never copied; its
//           Alarm colouring shows on PV curves only
//
// The item target is the curve id; fields find it in whichever plot holds it.
// Writes are pure transforms through `ctx.update`.

import { createElement } from 'react';
import { resolveBindings } from '../../../formula';
import type { PVTrace } from '../../../types';
import type { FieldDef, ObjectSchema, ToolUi } from '../../../workbench/types';
import type { TraceDotState } from '../dots';
import { FormulaEditorControl, type FormulaEditorValue } from '../fields/formulaEditor';
import { CARD_BLOCKS } from '../../vocabulary';
import {
  CURVE_TABS,
  curveAxisField,
  curveDisplayNameField,
  curveOf,
  curveStyleTab,
  curveVisibleField,
  patchCurve,
  plotHoldingCurve,
} from './curve';
import type { TracePlotModel } from './plot';

/** The item kind Trace's formula curves render under (`schema.items.formula`). */
export const FORMULA_CURVE_ITEM_KIND = 'formula';

/** The Formula field's id: the expression textarea's `#id` in Properties. */
export const FORMULA_EDITOR_FIELD_ID = 'formula-expression';

/**
 * The curves a variable of formula `id` may reference: on the same plot, not
 * the formula itself, not another formula, and carrying a PV.
 */
export function bindableCurves(state: TraceDotState, id: string): PVTrace[] {
  const plot = plotHoldingCurve(state, id);
  return (plot?.traces ?? []).filter((t) => t.id !== id && t.kind !== 'formula' && !!t.pvName);
}

/** Trace's formula-curve item schema; call once at module level. */
export function createFormulaCurveSchema<
  S extends TraceDotState,
  M extends TracePlotModel,
  U extends ToolUi = ToolUi,
>(): ObjectSchema<S, M, U> {
  const formula: FieldDef<S, M, U> = {
    id: FORMULA_EDITOR_FIELD_ID,
    label: 'Formula',
    kind: 'custom',
    tab: CURVE_TABS.signal,
    level: 'L1',
    get: (ctx): FormulaEditorValue => {
      const curve = curveOf(ctx.state, ctx.target.id);
      return { expression: curve?.expression ?? '', bindings: curve?.bindings ?? {} };
    },
    set: (ctx, value: FormulaEditorValue) => {
      const id = ctx.target.id;
      const { expression, bindings } = value;
      ctx.update((state) => patchCurve(state, id, { expression, bindings }));
    },
    render: ({ ctx, value, onChange, id }) => {
      const curve = curveOf(ctx.state, ctx.target.id);
      const candidates = bindableCurves(ctx.state, ctx.target.id);
      return createElement(FormulaEditorControl, {
        id,
        value: value as FormulaEditorValue,
        bindable: candidates.map((c) => ({ id: c.id, label: c.displayName || c.pvName })),
        resolvedBindings: curve ? resolveBindings(curve, candidates) : {},
        onChange,
      });
    },
  };

  return {
    tabs: [
      {
        ...CARD_BLOCKS.signal,
        fields: [
          curveDisplayNameField<S, M, U>(),
          formula,
          curveAxisField<S, M, U>(),
          curveVisibleField<S, M, U>(),
        ],
      },
      curveStyleTab<S, M, U>(),
    ],
  };
}

/** The formula-curve schema over the state and model slices it reads. */
export const formulaCurveSchema: ObjectSchema<TraceDotState, TracePlotModel> =
  createFormulaCurveSchema<TraceDotState, TracePlotModel>();
