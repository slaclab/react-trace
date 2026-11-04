// Waveform field schemas; the layout is listed in ./index.ts.
// The list sections: Live, Reference and X.

import { apply, setDelta, setRolling, setSpread } from '../edit';
import {
  MAX_LIVE,
  DEFAULT_ROLL_S,
  MIN_ROLL_S,
  MAX_ROLL_S,
  MAX_SPREAD,
  referenceHasSpread,
} from '../query';
import { GROUPS } from '../../vocabulary';
import type { FieldDef, SectionSchema } from '../../../workbench/types';

import {
  DRAW_AS_OPTIONS,
  type S,
  SPREAD_OPTIONS,
  type WaveformSchemaModel,
  type WaveformUi,
  referenceSourceText,
} from './common';

// --------------------------------------------------------------- sections --

/** Live: the Signals list. Its axis is the Axes section's Y axis, so it has no fields. */
export function liveSection<M extends WaveformSchemaModel, U extends WaveformUi>(): SectionSchema<
  S,
  M,
  U
> {
  return { capacity: MAX_LIVE, group: GROUPS.signals, tabs: [] };
}

/** Reference: its settings show under its card. */
export function referenceSection<
  M extends WaveformSchemaModel,
  U extends WaveformUi,
>(): SectionSchema<S, M, U> {
  const tab = 'reference';
  const reference: FieldDef<S, M, U>[] = [
    {
      id: 'reference-source',
      label: 'Source',
      kind: 'readonly',
      tab,
      level: 'L1',
      get: (ctx) => referenceSourceText(ctx.state, ctx.model.waveform),
    },
    {
      id: 'subtract-reference',
      label: 'Subtract reference',
      kind: 'toggle',
      tab,
      level: 'L1',
      // Stays visible while Δ is on, even while the reference has no frame.
      when: (ctx) => ctx.state.reference !== null || ctx.state.delta,
      get: (ctx) => ctx.state.delta,
      set: (ctx, delta) => ctx.update((state) => setDelta(state, delta)),
    },
    {
      // Per curve, the mean of its frames over the last Window
      // seconds; turning it on replaces any PV or snapshot reference, as
      // Snapshot → reference does; turning it off clears the reference.
      id: 'rolling',
      label: 'Rolling mean',
      kind: 'toggle',
      tab,
      level: 'L1',
      help: 'Each curve’s reference is its own mean over the last Window seconds, with a σ per element.',
      get: (ctx) => ctx.state.reference?.kind === 'rolling',
      set: (ctx, on) => ctx.update((state) => setRolling(state, on ? DEFAULT_ROLL_S : null)),
    },
    {
      id: 'rolling-window',
      label: 'Window',
      kind: 'number',
      tab,
      level: 'L1',
      min: MIN_ROLL_S,
      max: MAX_ROLL_S,
      step: 1,
      unit: 's',
      when: (ctx) => ctx.state.reference?.kind === 'rolling',
      get: (ctx) =>
        ctx.state.reference?.kind === 'rolling' ? ctx.state.reference.seconds : DEFAULT_ROLL_S,
      set: (ctx, value) => {
        if (value === null || !Number.isFinite(value)) return;
        const n = Math.round(value);
        if (n >= MIN_ROLL_S && n <= MAX_ROLL_S) ctx.update((state) => setRolling(state, n));
      },
    },
    {
      // The ±kσ band, for a reference that has a σ.
      id: 'spread',
      label: 'Spread band',
      kind: 'select',
      tab,
      level: 'L1',
      options: () => SPREAD_OPTIONS,
      when: (ctx) => referenceHasSpread(ctx.state.reference),
      get: (ctx) => String(ctx.state.spread),
      set: (ctx, value) => {
        const k = Number(value);
        if (Number.isInteger(k) && k >= 0 && k <= MAX_SPREAD) {
          ctx.update((state) => setSpread(state, k));
        }
      },
    },
    {
      id: 'draw-as',
      label: 'Draw as',
      kind: 'select',
      tab,
      level: 'L1',
      options: () => DRAW_AS_OPTIONS,
      get: (ctx) => ctx.state.drawAs,
      set: (ctx, value) => {
        if (value === 'dashed' || value === 'band') {
          ctx.update((state) => apply(state, (s) => ({ ...s, drawAs: value })));
        }
      },
    },
  ];

  return {
    capacity: 1,
    group: GROUPS.reference,
    tabs: [{ id: tab, label: GROUPS.reference, fields: reference }],
  };
}

/** X: the X axis PV list. Its axis is the Axes section's X axis, so it has no fields. */
export function xSourceSection<
  M extends WaveformSchemaModel,
  U extends WaveformUi,
>(): SectionSchema<S, M, U> {
  return { capacity: 1, group: GROUPS.xPv, tabs: [] };
}
