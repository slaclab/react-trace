// Waveform field schemas; the layout is listed in ./index.ts.
// The tool's Acquisition and Axes fields.

import { createElement } from 'react';
import { apply } from '../edit';
import {
  DEFAULT_DEC,
  MAX_AVG,
  MAX_DEC,
  MAX_HZ,
  MAX_PERSIST,
  MIN_DEC,
  MIN_HZ,
  type WaveformAxisScale,
  type WaveformElementRange,
} from '../query';
import { optionalPath } from '../../dotHelpers';
import { AXES, LABELS, PLOT_SECTIONS } from '../../vocabulary';
import type { FieldDef } from '../../../workbench/types';
import { ElementRangeControl } from '../fields/elementRange';

import {
  type Ctx,
  PLOT_AGAINST_OPTIONS,
  type S,
  type WaveformSchemaModel,
  type WaveformUi,
  commitDecimation,
  intField,
  patchXScale,
  patchYScale,
  scaleOptional,
  xScaleOptional,
} from './common';

/** The Acquisition fields: Persistence, Average; More: Element range, Decimation, Update-rate cap. */
export function acquisitionFields<M extends WaveformSchemaModel, U extends WaveformUi>(): FieldDef<
  S,
  M,
  U
>[] {
  const acquisitionTab = PLOT_SECTIONS.acquisition.id;
  return [
    intField<M, U>({
      id: 'persistence',
      label: 'Persistence',
      tab: acquisitionTab,
      level: 'L1',
      key: 'persist',
      lo: 1,
      hi: MAX_PERSIST,
      unit: 'frames',
      help: 'Overlay the last N frames, fading. Bars curves show only the latest frame.',
    }),
    intField<M, U>({
      id: 'average',
      label: 'Average',
      tab: acquisitionTab,
      level: 'L1',
      key: 'avg',
      lo: 1,
      hi: MAX_AVG,
      unit: 'frames',
      help: 'Average each element over the last N frames.',
    }),
    {
      id: 'element-range',
      label: 'Element range',
      kind: 'custom',
      tab: acquisitionTab,
      level: 'L3',
      help: 'First and last element drawn, from 0; empty means all.',
      get: (ctx): WaveformElementRange | null => ctx.state.elems,
      set: (ctx, elems: WaveformElementRange | null) =>
        ctx.update((state) => apply(state, (s) => ({ ...s, elems }))),
      render: ({ value, onChange, id }) =>
        createElement(ElementRangeControl, {
          id,
          value: value as WaveformElementRange | null,
          onChange,
        }),
      ...optionalPath<S, M, U>({
        get: (ctx) => ctx.state.elems ?? undefined,
        set: (state) => apply(state, (s) => ({ ...s, elems: null })),
      }),
    },
    {
      id: 'decimation',
      label: 'Decimation',
      kind: 'number',
      tab: acquisitionTab,
      level: 'L3',
      min: 0,
      max: MAX_DEC,
      step: 256,
      unit: 'points',
      help: `Points drawn per curve (${MIN_DEC}–${MAX_DEC}; default ${DEFAULT_DEC}); 0 draws every point.`,
      get: (ctx) => ctx.state.dec,
      set: (ctx, value) => {
        const dec = commitDecimation(value);
        if (dec !== null) ctx.update((state) => apply(state, (s) => ({ ...s, dec })));
      },
    },
    intField<M, U>({
      id: 'update-rate',
      label: 'Update-rate cap',
      tab: acquisitionTab,
      level: 'L3',
      key: 'hz',
      lo: MIN_HZ,
      hi: MAX_HZ,
      unit: 'Hz',
      help: `${MAX_HZ} Hz follows every update.`,
    }),
  ];
}

/** The Axes fields: the Y axis, then the X axis. */
export function axesFields<M extends WaveformSchemaModel, U extends WaveformUi>(): FieldDef<
  S,
  M,
  U
>[] {
  // Y axis, then X axis. The Y fields are L1 and the X fields L2, so the block
  // keeps that order and each half stays within the L1 budget.
  const axesTab = PLOT_SECTIONS.axes.id;
  const patchY = (ctx: Ctx<M, U>, next: WaveformAxisScale) =>
    ctx.update((state) => patchYScale(state, next));
  const manualY = (ctx: Ctx<M, U>) => ctx.state.yScale?.auto === false;
  const patchX = (ctx: Ctx<M, U>, next: WaveformAxisScale) =>
    ctx.update((state) => patchXScale(state, next));
  const manualX = (ctx: Ctx<M, U>) => ctx.state.xScale?.auto === false;
  return [
    {
      // Automatic from EGU: shown, never edited.
      id: 'axis-unit',
      label: LABELS.unit,
      kind: 'readonly',
      tab: axesTab,
      subgroup: AXES.y,
      level: 'L1',
      get: (ctx) => ctx.model.waveform.unit ?? '',
    },
    {
      id: 'axis-autoscale',
      label: LABELS.autoScale,
      kind: 'toggle',
      tab: axesTab,
      subgroup: AXES.y,
      level: 'L1',
      get: (ctx) => ctx.state.yScale?.auto !== false,
      // Min/Max are kept either way, so turning it off again restores them.
      set: (ctx, auto) => patchY(ctx, { auto: auto ? undefined : false }),
    },
    {
      id: 'axis-min',
      label: LABELS.min,
      kind: 'number',
      tab: axesTab,
      subgroup: AXES.y,
      level: 'L1',
      when: manualY,
      get: (ctx) => ctx.state.yScale?.min ?? null,
      set: (ctx, min) => patchY(ctx, { min: min ?? undefined }),
      ...scaleOptional<M, U>('min'),
    },
    {
      id: 'axis-max',
      label: LABELS.max,
      kind: 'number',
      tab: axesTab,
      subgroup: AXES.y,
      level: 'L1',
      when: manualY,
      get: (ctx) => ctx.state.yScale?.max ?? null,
      set: (ctx, max) => patchY(ctx, { max: max ?? undefined }),
      ...scaleOptional<M, U>('max'),
    },
    {
      id: 'axis-logscale',
      label: LABELS.logScale,
      kind: 'toggle',
      tab: axesTab,
      subgroup: AXES.y,
      level: 'L1',
      get: (ctx) => ctx.state.yScale?.log === true,
      set: (ctx, log) => patchY(ctx, { log: log ? true : undefined }),
    },
    {
      // Without an X axis PV the axis is the element index whatever is stored.
      id: 'x-axis',
      label: 'Plot against',
      kind: 'segmented',
      tab: axesTab,
      subgroup: AXES.x,
      level: 'L2',
      options: (ctx) => PLOT_AGAINST_OPTIONS(ctx.state.xs !== ''),
      get: (ctx) => (ctx.state.xs === '' ? 'index' : ctx.state.xAxis),
      set: (ctx, value) => {
        if (value === 'index' || value === 'source') {
          ctx.update((state) => apply(state, (s) => ({ ...s, xAxis: value })));
        }
      },
    },
    {
      // The X axis scale, in the drawn X's units (element index or the X axis PV).
      id: 'x-axis-autoscale',
      label: LABELS.autoScale,
      kind: 'toggle',
      tab: axesTab,
      subgroup: AXES.x,
      level: 'L2',
      get: (ctx) => ctx.state.xScale?.auto !== false,
      set: (ctx, auto) => patchX(ctx, { auto: auto ? undefined : false }),
    },
    {
      id: 'x-axis-min',
      label: LABELS.min,
      kind: 'number',
      tab: axesTab,
      subgroup: AXES.x,
      level: 'L2',
      when: manualX,
      get: (ctx) => ctx.state.xScale?.min ?? null,
      set: (ctx, min) => patchX(ctx, { min: min ?? undefined }),
      ...xScaleOptional<M, U>('min'),
    },
    {
      id: 'x-axis-max',
      label: LABELS.max,
      kind: 'number',
      tab: axesTab,
      subgroup: AXES.x,
      level: 'L2',
      when: manualX,
      get: (ctx) => ctx.state.xScale?.max ?? null,
      set: (ctx, max) => patchX(ctx, { max: max ?? undefined }),
      ...xScaleOptional<M, U>('max'),
    },
  ];
}
