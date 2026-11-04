// Correlation's `ToolDefinition`.
//
// The schema half is built once, here, at module level: `correlationSchema`,
// whose Trigger section carries the Source as its inline header field (the
// workbench gives it `data-testid="trigger-source"`). The binding half
// (`outline.ts`) is rebuilt per render by `correlationDefinition`.
//
// `pendingTrigger`: choosing PV as the trigger source writes
// nothing to state; it raises this flag on the tool's `ui` record, held in
// App.tsx through `useCorrelationUi`. While it is set (and no trigger PV is
// set) the Source reads PV and the Trigger add row shows. It is cleared by
// adding the trigger PV (the binding), choosing Timer (the Source field), or
// an Escape that no inner control claimed (`useCorrelationUi`).

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CorrelationState } from './query';
import type { CorrelationPvs } from './pvs';
import type { PvSearch } from '../../pvSearch';
import type { ToolDefinition, ToolSchema } from '../../workbench/types';
import { useLatest } from '../../workbench/useLatest';
import { correlationBinding, type CorrelationBindingInput, type CorrelationModel } from './outline';
import { correlationSchema, type CorrelationUi } from './schema';

export type { CorrelationBindingInput, CorrelationModel } from './outline';
export type { CorrelationUi } from './schema';

type S = CorrelationState;

/** Correlation's schema half, built once. */
export const CORRELATION_SCHEMA: ToolSchema<S, CorrelationModel, CorrelationUi> = correlationSchema<
  CorrelationModel,
  CorrelationUi
>();

/** Correlation's whole definition; call per render with the latest inputs. */
export function correlationDefinition(
  input: CorrelationBindingInput
): ToolDefinition<S, CorrelationModel, CorrelationUi> {
  return { schema: CORRELATION_SCHEMA, binding: correlationBinding(input) };
}

/** What `useCorrelationDefinition` reads each render. */
export interface CorrelationDefinitionInputs {
  state: S;
  model: CorrelationModel;
  update(fn: (state: S) => S): void;
  pvs: Pick<CorrelationPvs, 'probe' | 'endProbe'>;
  ui: CorrelationUi;
  search?: PvSearch;
}

/**
 * The definition for App.tsx: the binding reads the latest state, model and
 * PV checks after a commit, and is rebuilt only when `update`, `ui` or
 * `search` change.
 */
export function useCorrelationDefinition(
  inputs: CorrelationDefinitionInputs
): ToolDefinition<S, CorrelationModel, CorrelationUi> {
  // An add reads the latest state, model and PV checks after its probe.
  const latest = useLatest(inputs);
  const { update, ui, search } = inputs;
  return useMemo(
    () =>
      correlationDefinition({
        getState: () => latest.current.state,
        getModel: () => latest.current.model,
        update,
        pvs: {
          probe: (pv, role) => latest.current.pvs.probe(pv, role),
          endProbe: (pv) => latest.current.pvs.endProbe(pv),
        },
        ui,
        search,
      }),
    [latest, update, ui, search]
  );
}

/**
 * The model App.tsx hands the workbench: the binding's model plus the X the
 * canvas draws: the frame's X PV, else the state's `x`. New
 * drawings are stamped with it (`xRef`) and the Layers reasons compare it.
 */
export interface CorrelationToolModel extends CorrelationModel {
  drawnX: string;
}

/** The `ui` record with `pendingTrigger` and `drawingsHidden` always present. */
export type CorrelationUiRecord = CorrelationUi & {
  pendingTrigger: boolean;
  setPendingTrigger(pending: boolean): void;
  drawingsHidden: boolean;
  /**
   * Writes the record's `drawingsHidden` through `fn` (the drawing document's
   * `setUi`); the other fields have their own writers. Returning the record
   * unchanged commits nothing.
   */
  setUi(fn: (ui: CorrelationUi) => CorrelationUi): void;
};

/**
 * Correlation's transient UI record, for App.tsx to hold. While
 * `pendingTrigger` is set, an Escape that no inner control claimed (not
 * `defaultPrevented`, propagation not stopped) clears it; an Escape the
 * drawing host consumed (cancelling a gesture) is `defaultPrevented` and
 * leaves it set.
 */
export function useCorrelationUi(): CorrelationUiRecord {
  const [pendingTrigger, setPendingTrigger] = useState(false);
  const [drawingsHidden, setDrawingsHidden] = useState(false);

  useEffect(() => {
    if (!pendingTrigger) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) setPendingTrigger(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [pendingTrigger]);

  const setUi = useCallback(
    (fn: (ui: CorrelationUi) => CorrelationUi) =>
      setDrawingsHidden((prev) => fn({ drawingsHidden: prev }).drawingsHidden === true),
    []
  );
  return useMemo(
    () => ({ pendingTrigger, setPendingTrigger, drawingsHidden, setUi }),
    [pendingTrigger, drawingsHidden, setUi]
  );
}
