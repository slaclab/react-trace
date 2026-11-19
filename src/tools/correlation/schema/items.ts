// Correlation field schemas; the layout is listed in ./index.ts.
//
// The item schemas: Y, X and Trigger.

import { yColorMap } from '../colors';
import { movePv, setColor, setHidden, setLabel, setMarker } from '../edit';
import {
  DEFAULT_MARKER,
  MARKER_SHAPES,
  MAX_LABEL_LENGTH,
  MAX_MARKER_SIZE,
  MIN_MARKER_SIZE,
  type CorrelationMarker,
} from '../query';
import { CARD_BLOCKS, LABELS } from '../../vocabulary';
import type { FieldDef, ObjectSchema } from '../../../workbench/types';
import { autoYColor } from '../../shared/colors';
import {
  CORRELATION_ROLES,
  ROLE_LABELS,
  SHAPE_LABELS,
  correlationMoveRefusal,
  isRole,
  itemOf,
  markerOptional,
  pvOf,
  pvRecord,
  roleOf,
  type CorrelationSchemaModel,
  type CorrelationUi,
  type Ctx,
  type S,
} from './common';

// ------------------------------------------------------------------ items --

function plotOnField<M extends CorrelationSchemaModel, U extends CorrelationUi>(): FieldDef<
  S,
  M,
  U
> {
  return {
    id: 'role',
    label: LABELS.plotOn,
    kind: 'select',
    tab: CARD_BLOCKS.signal.id,
    level: 'L1',
    options: (ctx) =>
      CORRELATION_ROLES.map((role) => {
        const refusal = correlationMoveRefusal(ctx.state, ctx.target.id, role);
        return refusal === null
          ? { value: role, label: ROLE_LABELS[role] }
          : { value: role, label: ROLE_LABELS[role], disabled: refusal };
      }),
    get: (ctx) => roleOf(ctx.target) ?? 'y',
    set: (ctx, to) => {
      const item = itemOf(ctx.target);
      if (item === null || !isRole(to) || to === item.role) return;
      ctx.update((state) => movePv(state, item.role, item.pv, to).state);
    },
  };
}

/** The Label field; `automatic` is what it reads while no label is set. */
function labelField<M extends CorrelationSchemaModel, U extends CorrelationUi>(
  automatic: (ctx: Ctx<M, U>, pv: string) => string,
  help?: string
): FieldDef<S, M, U> {
  return {
    id: 'label',
    label: LABELS.label,
    kind: 'text',
    tab: CARD_BLOCKS.signal.id,
    level: 'L1',
    ...(help === undefined ? {} : { help }),
    get: (ctx) => {
      const pv = pvOf(ctx.target);
      if (pv === undefined) return '';
      return Object.hasOwn(ctx.state.labels, pv) ? ctx.state.labels[pv] : automatic(ctx, pv);
    },
    set: (ctx, label) => {
      const pv = pvOf(ctx.target);
      if (pv !== undefined) {
        ctx.update((state) => setLabel(state, pv, [...label].slice(0, MAX_LABEL_LENGTH).join('')));
      }
    },
    ...pvRecord<M, U, 'labels'>('labels'),
  };
}

/** The automatic colour of a Y: its position's colour. */
function positionalColor(state: S, pv: string): string {
  const index = state.ys.indexOf(pv);
  return index < 0 ? autoYColor(0) : autoYColor(index);
}

/** Why Opacity cannot be set: fade draws each age bucket at its own opacity. */
export const FADE_OPACITY_REASON = 'Fade older points is on';

export function yItem<M extends CorrelationSchemaModel, U extends CorrelationUi>(): ObjectSchema<
  S,
  M,
  U
> {
  const markerOf = (ctx: Ctx<M, U>): CorrelationMarker => {
    const pv = pvOf(ctx.target);
    return (pv === undefined ? undefined : ctx.state.markers[pv]) ?? {};
  };
  const patchMarker = (ctx: Ctx<M, U>, patch: CorrelationMarker) => {
    const pv = pvOf(ctx.target);
    if (pv !== undefined) ctx.update((state) => setMarker(state, pv, patch));
  };
  // The density view draws no markers.
  const scatter = (ctx: Ctx<M, U>) => ctx.state.view !== 'density';

  const signal: FieldDef<S, M, U>[] = [
    labelField<M, U>((_ctx, pv) => pv),
    plotOnField<M, U>(),
    {
      // The card eye: the one home for visibility (`hide=`).
      id: 'visible',
      label: LABELS.visible,
      kind: 'toggle',
      tab: CARD_BLOCKS.signal.id,
      level: 'L1',
      row: 'eye',
      get: (ctx) => {
        const pv = pvOf(ctx.target);
        return pv === undefined || !Object.hasOwn(ctx.state.hidden, pv);
      },
      set: (ctx, visible) => {
        const pv = pvOf(ctx.target);
        if (pv !== undefined) ctx.update((state) => setHidden(state, pv, !visible));
      },
      ...pvRecord<M, U, 'hidden'>('hidden'),
    },
  ];

  const style: FieldDef<S, M, U>[] = [
    {
      // Picking the positional colour still writes the record: pinned.
      id: 'colour',
      label: LABELS.colour,
      kind: 'colour',
      tab: CARD_BLOCKS.style.id,
      level: 'L1',
      row: 'swatch',
      get: (ctx) => {
        const pv = pvOf(ctx.target);
        if (pv === undefined) return autoYColor(0);
        return yColorMap(ctx.state).get(pv) ?? positionalColor(ctx.state, pv);
      },
      set: (ctx, colour) => {
        const pv = pvOf(ctx.target);
        if (pv !== undefined) ctx.update((state) => setColor(state, pv, colour));
      },
      ...pvRecord<M, U, 'colors'>('colors'),
    },
    {
      id: 'marker-shape',
      label: LABELS.marker,
      kind: 'select',
      tab: CARD_BLOCKS.style.id,
      level: 'L1',
      when: scatter,
      options: () => MARKER_SHAPES.map((value) => ({ value, label: SHAPE_LABELS[value] })),
      get: (ctx) => markerOf(ctx).shape ?? DEFAULT_MARKER.shape,
      set: (ctx, value) => {
        const shape = MARKER_SHAPES.find((s) => s === value);
        if (shape !== undefined) patchMarker(ctx, { shape });
      },
      ...markerOptional<M, U>('shape'),
    },
    {
      id: 'marker-size',
      label: LABELS.markerSize,
      kind: 'number',
      tab: CARD_BLOCKS.style.id,
      level: 'L1',
      when: scatter,
      min: MIN_MARKER_SIZE,
      max: MAX_MARKER_SIZE,
      step: 1,
      unit: 'px',
      get: (ctx) => markerOf(ctx).size ?? DEFAULT_MARKER.size,
      set: (ctx, size) => patchMarker(ctx, { size: size ?? undefined }),
      ...markerOptional<M, U>('size'),
    },
    {
      id: 'marker-opacity',
      label: 'Opacity',
      kind: 'number',
      tab: CARD_BLOCKS.style.id,
      level: 'L1',
      when: scatter,
      disabled: (ctx) => (ctx.state.fade ? FADE_OPACITY_REASON : false),
      min: 0,
      max: 1,
      step: 0.05,
      get: (ctx) => markerOf(ctx).opacity ?? DEFAULT_MARKER.opacity,
      set: (ctx, opacity) => patchMarker(ctx, { opacity: opacity ?? undefined }),
      ...markerOptional<M, U>('opacity'),
    },
  ];

  return {
    tabs: [
      { ...CARD_BLOCKS.signal, fields: signal },
      { ...CARD_BLOCKS.style, fields: style },
    ],
  };
}

export function xItem<M extends CorrelationSchemaModel, U extends CorrelationUi>(): ObjectSchema<
  S,
  M,
  U
> {
  return {
    tabs: [
      {
        ...CARD_BLOCKS.signal,
        // The X-axis title (`xl=`); automatic is the PV name.
        fields: [labelField<M, U>((_ctx, pv) => pv, 'The X axis title'), plotOnField<M, U>()],
      },
    ],
  };
}

export function triggerItem<
  M extends CorrelationSchemaModel,
  U extends CorrelationUi,
>(): ObjectSchema<S, M, U> {
  return { tabs: [{ ...CARD_BLOCKS.signal, fields: [plotOnField<M, U>()] }] };
}
