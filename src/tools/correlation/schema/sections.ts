// Correlation field schemas; the layout is listed in ./index.ts.
//
// The Trigger section: the Source header field, Period and Fire on.

import { CORRELATION_TESTIDS } from '../testids';
import { apply, setFire, setTimer } from '../edit';
import { CORRELATION_FIRE, MIN_DT_S, type CorrelationFire } from '../query';
import { optionalPath } from '../../dotHelpers';
import { GROUPS } from '../../vocabulary';
import type { FieldDef, SectionSchema } from '../../../workbench/types';
import { triggerSource, type CorrelationSchemaModel, type CorrelationUi, type S } from './common';

// --------------------------------------------------------------- sections --

const EVERY_UPDATE = 'every';

const FIRE_LABELS: Record<CorrelationFire, string> = { rising: 'Rising', falling: 'Falling' };

/** The Trigger's Source: the Trigger group's inline header field, its one control. */
function triggerSourceField<M extends CorrelationSchemaModel, U extends CorrelationUi>(): FieldDef<
  S,
  M,
  U
> {
  return {
    id: CORRELATION_TESTIDS.triggerSource,
    label: 'Source',
    kind: 'select',
    tab: 'trigger',
    level: 'L1',
    options: () => [
      { value: 'timer', label: 'Timer' },
      { value: 'pv', label: 'PV' },
    ],
    get: (ctx) => triggerSource(ctx.state, ctx.ui),
    set: (ctx, source) => {
      if (source === 'timer') {
        ctx.ui.setPendingTrigger?.(false);
        ctx.update((state) => setTimer(state));
      } else if (source === 'pv' && ctx.state.trigger.mode !== 'pv') {
        // Writes nothing to state: the Trigger add row commits the PV.
        ctx.ui.setPendingTrigger?.(true);
      }
    },
  };
}

export function triggerSection<
  M extends CorrelationSchemaModel,
  U extends CorrelationUi,
>(): SectionSchema<S, M, U> {
  const trigger: FieldDef<S, M, U>[] = [
    {
      id: 'trigger-period',
      label: 'Period',
      kind: 'number',
      tab: 'trigger',
      level: 'L1',
      min: MIN_DT_S,
      step: 0.1,
      unit: 's',
      when: (ctx) => triggerSource(ctx.state, ctx.ui) === 'timer',
      get: (ctx) => (ctx.state.trigger.mode === 'timer' ? ctx.state.trigger.dtS : null),
      set: (ctx, dtS) => {
        if (dtS === null || !Number.isFinite(dtS) || dtS < MIN_DT_S) return;
        ctx.update((state) =>
          apply(state, (s) =>
            s.trigger.mode === 'timer' ? { ...s, trigger: { mode: 'timer', dtS } } : s
          )
        );
      },
    },
    {
      // Absent `fire` is Every update and keeps the spec's bytes.
      id: 'trigger-fire',
      label: 'Fire on',
      kind: 'segmented',
      tab: 'trigger',
      level: 'L1',
      when: (ctx) => triggerSource(ctx.state, ctx.ui) === 'pv',
      disabled: (ctx) => (ctx.state.trigger.mode === 'pv' ? false : 'Add a trigger PV first.'),
      options: () => [
        { value: EVERY_UPDATE, label: 'Every update' },
        ...CORRELATION_FIRE.map((value) => ({ value, label: FIRE_LABELS[value] })),
      ],
      get: (ctx) => ctx.state.fire ?? EVERY_UPDATE,
      set: (ctx, value) => {
        const fire = CORRELATION_FIRE.find((f) => f === value);
        if (fire === undefined && value !== EVERY_UPDATE) return;
        ctx.update((state) => setFire(state, fire));
      },
      ...optionalPath<S, M, U>({
        get: (ctx) => ctx.state.fire,
        set: (state) => setFire(state, undefined),
      }),
    },
  ];

  return {
    capacity: 1,
    group: GROUPS.trigger,
    headerField: triggerSourceField<M, U>(),
    tabs: [{ id: 'trigger', label: 'Trigger', fields: trigger }],
  };
}
