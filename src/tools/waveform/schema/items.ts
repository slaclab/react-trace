// Waveform field schemas; the layout is listed in ./index.ts.
// The item cards: Live, Reference and X.

import { GROUP_LABELS, groupOf, movePv, setLabel, setVisible } from '../edit';
import { ELEMENT_LABEL } from '../model';
import {
  MAX_LABEL_LENGTH,
  MAX_WIDTH,
  MIN_WIDTH,
  WAVEFORM_LINE_STYLES,
  WAVEFORM_LINE_TYPES,
} from '../query';
import { optionalPath } from '../../dotHelpers';
import { CARD_BLOCKS, DASH_LABELS, LABELS, LINE_TYPE_LABELS } from '../../vocabulary';
import type { FieldDef, ObjectSchema, Target } from '../../../workbench/types';
import { autoYColor } from '../../shared/colors';

import {
  type Ctx,
  DEFAULT_LINE_WIDTH,
  type S,
  WAVEFORM_GROUPS,
  type WaveformSchemaModel,
  type WaveformUi,
  hiddenRecord,
  isGroup,
  isSnapshotItem,
  pvOf,
  styleOf,
  styleOptional,
  waveformMoveRefusal,
  writeStyle,
} from './common';

// ------------------------------------------------------------------ items --

const SIGNAL = CARD_BLOCKS.signal.id;
const STYLE = CARD_BLOCKS.style.id;

/** The Label a curve draws with when none is pinned (`plotOption.ts`). */
function automaticLabel(ctx: { state: S; target: Target }): string {
  if (isSnapshotItem(ctx.target)) return '';
  return pvOf(ctx.target) ?? '';
}

function curveLabel<M extends WaveformSchemaModel, U extends WaveformUi>(): FieldDef<S, M, U> {
  return {
    id: 'label',
    label: LABELS.label,
    kind: 'text',
    tab: SIGNAL,
    level: 'L1',
    placeholder: 'Automatic',
    get: (ctx) => styleOf(ctx).label ?? automaticLabel(ctx),
    // An empty Label draws the automatic name, so it is not pinned.
    set: (ctx, text) => {
      const label = [...text].slice(0, MAX_LABEL_LENGTH).join('');
      const target = ctx.target;
      ctx.update((state) => writeStyle(state, target, { label: label === '' ? undefined : label }));
    },
    ...styleOptional<M, U>('label'),
  };
}

function curveColour<M extends WaveformSchemaModel, U extends WaveformUi>(
  automatic: (ctx: Ctx<M, U>) => string
): FieldDef<S, M, U> {
  return {
    id: 'colour',
    label: LABELS.colour,
    kind: 'colour',
    tab: STYLE,
    level: 'L1',
    row: 'swatch',
    get: (ctx) => styleOf(ctx).color ?? automatic(ctx),
    set: (ctx, color) => {
      const target = ctx.target;
      ctx.update((state) => writeStyle(state, target, { color }));
    },
    ...styleOptional<M, U>('color'),
  };
}

function curveVisible<M extends WaveformSchemaModel, U extends WaveformUi>(): FieldDef<S, M, U> {
  return {
    // The card eye; `hide=`.
    id: 'visible',
    label: LABELS.visible,
    kind: 'toggle',
    tab: SIGNAL,
    level: 'L1',
    row: 'eye',
    // A snapshot holds no PV, so there is no `hidden` record to keep for it.
    when: (ctx) => pvOf(ctx.target) !== undefined,
    get: (ctx) => {
      const pv = pvOf(ctx.target);
      return pv === undefined || !Object.hasOwn(ctx.state.hidden, pv);
    },
    set: (ctx, visible) => {
      const pv = pvOf(ctx.target);
      if (pv !== undefined) ctx.update((state) => setVisible(state, pv, visible));
    },
    ...hiddenRecord<M, U>(),
  };
}

function curveWidth<M extends WaveformSchemaModel, U extends WaveformUi>(): FieldDef<S, M, U> {
  return {
    id: 'line-width',
    label: LABELS.width,
    kind: 'number',
    tab: STYLE,
    level: 'L1',
    min: MIN_WIDTH,
    max: MAX_WIDTH,
    step: 0.5,
    unit: 'px',
    get: (ctx) => styleOf(ctx).width ?? DEFAULT_LINE_WIDTH,
    set: (ctx, width) => {
      if (width !== null && !(Number.isFinite(width) && width >= MIN_WIDTH && width <= MAX_WIDTH)) {
        return;
      }
      const target = ctx.target;
      ctx.update((state) => writeStyle(state, target, { width: width ?? undefined }));
    },
    ...styleOptional<M, U>('width'),
  };
}

/** Plot on: the section a PV sits in (Live, Reference or X axis PV); a full Live refuses. */
export function plotOnField<M extends WaveformSchemaModel, U extends WaveformUi>(): FieldDef<
  S,
  M,
  U
> {
  return {
    id: 'group',
    label: LABELS.plotOn,
    kind: 'select',
    tab: SIGNAL,
    level: 'L1',
    options: (ctx) =>
      WAVEFORM_GROUPS.map((group) => {
        const refusal = waveformMoveRefusal(ctx.state, ctx.target.id, group);
        return refusal === null
          ? { value: group, label: GROUP_LABELS[group] }
          : { value: group, label: GROUP_LABELS[group], disabled: refusal };
      }),
    get: (ctx) => {
      const pv = pvOf(ctx.target);
      return (pv === undefined ? null : groupOf(ctx.state, pv)) ?? 'live';
    },
    set: (ctx, to) => {
      const pv = pvOf(ctx.target);
      if (pv === undefined || !isGroup(to)) return;
      ctx.update((state) => movePv(state, pv, to).state);
    },
  };
}

/** A Live curve's automatic colour: its position's (`plotOption.ts`). */
function liveColour(ctx: { state: S; target: Target }): string {
  const pv = pvOf(ctx.target);
  const index = pv === undefined ? -1 : ctx.state.pvs.indexOf(pv);
  return autoYColor(Math.max(0, index));
}

export function liveItem<M extends WaveformSchemaModel, U extends WaveformUi>(): ObjectSchema<
  S,
  M,
  U
> {
  const signal: FieldDef<S, M, U>[] = [
    curveLabel<M, U>(),
    plotOnField<M, U>(),
    curveVisible<M, U>(),
  ];

  const style: FieldDef<S, M, U>[] = [
    curveColour<M, U>(liveColour),
    {
      id: 'line-type',
      label: LABELS.line,
      kind: 'select',
      tab: STYLE,
      level: 'L1',
      options: () =>
        WAVEFORM_LINE_TYPES.map((value) => ({ value, label: LINE_TYPE_LABELS[value] })),
      get: (ctx) => styleOf(ctx).lineType ?? 'line',
      set: (ctx, value) => {
        const lineType = WAVEFORM_LINE_TYPES.find((t) => t === value);
        const target = ctx.target;
        if (lineType !== undefined) ctx.update((state) => writeStyle(state, target, { lineType }));
      },
      ...styleOptional<M, U>('lineType'),
    },
    curveWidth<M, U>(),
    {
      id: 'line-style',
      label: LABELS.dash,
      kind: 'select',
      tab: STYLE,
      level: 'L1',
      options: () => WAVEFORM_LINE_STYLES.map((value) => ({ value, label: DASH_LABELS[value] })),
      get: (ctx) => styleOf(ctx).lineStyle ?? 'solid',
      set: (ctx, value) => {
        const lineStyle = WAVEFORM_LINE_STYLES.find((t) => t === value);
        const target = ctx.target;
        if (lineStyle !== undefined) {
          ctx.update((state) => writeStyle(state, target, { lineStyle }));
        }
      },
      ...styleOptional<M, U>('lineStyle'),
    },
  ];

  return {
    tabs: [
      { ...CARD_BLOCKS.signal, fields: signal },
      { ...CARD_BLOCKS.style, fields: style },
    ],
  };
}

/**
 * The reference's automatic colour: the theme's axis-label colour for a PV
 * reference; a snapshot draws each entry in its curve's colour, so it shows
 * the first entry's (`plotOption.ts`).
 */
function referenceColour<M extends WaveformSchemaModel, U extends WaveformUi>(
  ctx: Ctx<M, U>
): string {
  const ref = ctx.state.reference;
  if (ref?.kind === 'snapshot') {
    const first = ctx.state.pvs.find((pv) => Object.hasOwn(ref.frames, pv));
    return autoYColor(Math.max(0, first === undefined ? 0 : ctx.state.pvs.indexOf(first)));
  }
  if (ref?.kind === 'rolling') return autoYColor(0);
  return ctx.model.fragmentInput(ctx.state).theme.axisLabel;
}

export function referenceItem<M extends WaveformSchemaModel, U extends WaveformUi>(): ObjectSchema<
  S,
  M,
  U
> {
  return {
    tabs: [
      { ...CARD_BLOCKS.signal, fields: [curveLabel<M, U>(), curveVisible<M, U>()] },
      {
        ...CARD_BLOCKS.style,
        // Line and Dash are the Reference's Draw as.
        fields: [curveColour<M, U>(referenceColour<M, U>), curveWidth<M, U>()],
      },
    ],
  };
}

export function xSourceItem<M extends WaveformSchemaModel, U extends WaveformUi>(): ObjectSchema<
  S,
  M,
  U
> {
  const label: FieldDef<S, M, U> = {
    // The X-axis title: pinned Label, else the X axis PV's EGU, else "Element".
    id: 'label',
    label: LABELS.label,
    kind: 'text',
    tab: SIGNAL,
    level: 'L1',
    placeholder: 'Automatic',
    help: 'The X axis title',
    get: (ctx) => ctx.state.xLabel ?? (ctx.model.waveform.x?.egu || ELEMENT_LABEL),
    set: (ctx, text) => {
      const pv = pvOf(ctx.target);
      if (pv === undefined) return;
      const next = [...text].slice(0, MAX_LABEL_LENGTH).join('');
      ctx.update((state) => setLabel(state, pv, next === '' ? undefined : next));
    },
    ...optionalPath<S, M, U>({
      get: (ctx) => ctx.state.xLabel,
      set: (state, target) => {
        const pv = pvOf(target);
        return pv === undefined ? state : setLabel(state, pv, undefined);
      },
    }),
  };
  return { tabs: [{ ...CARD_BLOCKS.signal, fields: [label, plotOnField<M, U>()] }] };
}
