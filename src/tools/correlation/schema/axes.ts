// Correlation field schemas; the layout is listed in ./index.ts.
//
// The Axes tab: one axis's fields, Y axis and X axis.

import type { CorrelationAxisScale } from '../query';
import { AXES, LABELS, PLOT_SECTIONS } from '../../vocabulary';
import type { FieldDef, FieldLevel } from '../../../workbench/types';
import {
  axisUnit,
  patchScale,
  scaleKey,
  scaleOptional,
  type AxisRole,
  type CorrelationSchemaModel,
  type CorrelationUi,
  type Ctx,
  type S,
} from './common';

/** One axis's fields in Axes: `axis-*` under Y axis, `x-axis-*` under X axis. */
export function axisFields<M extends CorrelationSchemaModel, U extends CorrelationUi>(
  role: AxisRole
): FieldDef<S, M, U>[] {
  const prefix = role === 'x' ? 'x-axis' : 'axis';
  const subgroup = role === 'x' ? AXES.x : AXES.y;
  // The Y's fields are L1 and the X's L2, so the X sub-block follows the Y's.
  const level: FieldLevel = role === 'x' ? 'L2' : 'L1';
  const tab = PLOT_SECTIONS.axes.id;
  const scale = (ctx: Ctx<M, U>) => ctx.state[scaleKey(role)];
  const patch = (ctx: Ctx<M, U>, next: CorrelationAxisScale) =>
    ctx.update((state) => patchScale(state, role, next));
  const manual = (ctx: Ctx<M, U>) => scale(ctx)?.auto === false;

  return [
    {
      // L4 (automatic from EGU): shown, never edited.
      id: `${prefix}-unit`,
      label: LABELS.unit,
      kind: 'readonly',
      tab,
      level,
      subgroup,
      get: (ctx) => axisUnit(ctx.model, ctx.state, role),
    },
    {
      id: `${prefix}-autoscale`,
      label: LABELS.autoScale,
      kind: 'toggle',
      tab,
      level,
      subgroup,
      get: (ctx) => scale(ctx)?.auto !== false,
      // Min/Max are kept either way, so turning it off again restores them.
      set: (ctx, auto) => patch(ctx, { auto: auto ? undefined : false }),
    },
    {
      id: `${prefix}-min`,
      label: LABELS.min,
      kind: 'number',
      tab,
      level,
      subgroup,
      when: manual,
      get: (ctx) => scale(ctx)?.min ?? null,
      set: (ctx, min) => patch(ctx, { min: min ?? undefined }),
      ...scaleOptional<M, U>(role, 'min'),
    },
    {
      id: `${prefix}-max`,
      label: LABELS.max,
      kind: 'number',
      tab,
      level,
      subgroup,
      when: manual,
      get: (ctx) => scale(ctx)?.max ?? null,
      set: (ctx, max) => patch(ctx, { max: max ?? undefined }),
      ...scaleOptional<M, U>(role, 'max'),
    },
    {
      id: `${prefix}-logscale`,
      label: LABELS.logScale,
      kind: 'toggle',
      tab,
      level,
      subgroup,
      get: (ctx) => scale(ctx)?.log === true,
      set: (ctx, log) => patch(ctx, { log: log ? true : undefined }),
    },
  ];
}
