// Waveform's `ToolDefinition`.
//
// The schema half is built once, here, at module level: `WAVEFORM_SCHEMA`
// over the concrete model. The binding half (`outline.ts`) is built by
// `waveformDefinition`; `useWaveformDefinition` keeps it across renders and
// lets an add read the latest state after its async probe.
//
// The probe is the PV tracker of `../shared/pvTracker.ts` with the waveform
// kind rule (`WAVEFORM_KINDS`): a waveform PV is accepted, a scalar refused
// with reason `scalar`. Units are not checked at add (a curve of another
// unit is kept and the model marks it not drawn), so the probe asks as the
// tracker's `x` role, which has no unit check.

import { useMemo, useState } from 'react';
import type { Annotation } from '../../annotations/model';
import type { WaveformState } from './query';
import type { PvSearch } from '../../pvSearch';
import type { ToolDefinition, ToolSchema } from '../../workbench/types';
import { useLatest } from '../../workbench/useLatest';
import {
  waveformBinding,
  type WaveformBindingInput,
  type WaveformProbe,
  type WaveformToolModel,
} from './outline';
import { waveformSchema, type WaveformUi } from './schema';
import { PvTracker, WAVEFORM_KINDS, type MetaPVService } from '../shared/pvTracker';

export type { WaveformBindingInput, WaveformProbe, WaveformToolModel } from './outline';
export type { WaveformUi } from './schema';

type S = WaveformState;

/** Waveform's schema half, built once. */
export const WAVEFORM_SCHEMA: ToolSchema<S, WaveformToolModel, WaveformUi> = waveformSchema<
  WaveformToolModel,
  WaveformUi
>();

/** Waveform's whole definition over `input`. */
export function waveformDefinition(
  input: WaveformBindingInput,
  schema: ToolSchema<S, WaveformToolModel, WaveformUi> = WAVEFORM_SCHEMA
): ToolDefinition<S, WaveformToolModel, WaveformUi> {
  return { schema, binding: waveformBinding(input) };
}

/** A probe with the waveform kind rule over `service`, plus its disposal. */
export function createWaveformProbe(service: MetaPVService): WaveformProbe & { dispose(): void } {
  const tracker = new PvTracker(service, WAVEFORM_KINDS);
  return {
    probe: (pv) => tracker.probe(pv, 'x'),
    endProbe: (pv) => tracker.endProbe(pv),
    dispose: () => tracker.dispose(),
  };
}

/**
 * Waveform's transient UI record, the workbench's `ui`: session state,
 * never serialized. `drawingsHidden` is the plot's Hide all flag.
 */
export interface WaveformUiRecord {
  /** Hide all drawings; absent means shown. */
  drawingsHidden?: boolean;
}

/** What `useWaveformDefinition` reads each render. */
export interface WaveformDefinitionInputs {
  state: S;
  update(fn: (state: S) => S): void;
  probe: WaveformProbe;
  search?: PvSearch;
  /** The plot's drawings (`state.drawings`), for the drawings section. */
  drawings?: readonly Annotation[];
  /** The x the chart plots, `renderedXSource(model, frames)`: what a drawing is bound to. */
  renderedX?: string;
  /** Whether the chart draws Δ. */
  delta?: boolean;
  /** The UI record (Hide all). */
  ui?: WaveformUiRecord;
  /** Writes the UI record. */
  setUi?(fn: (ui: WaveformUiRecord) => WaveformUiRecord): void;
}

/**
 * The definition for App.tsx: an add reads the latest state and probe after
 * its probe resolves; the binding (and its view-model cache) is rebuilt only
 * when `update`, `search` or the rendered x change (the rendered x is a
 * string, equal across frames, so a new frame never rebuilds it). Drawings and
 * Δ come from the state and model the binding is handed; the Hide-all eye
 * writes the latest `setUi`.
 */
export function useWaveformDefinition(
  inputs: WaveformDefinitionInputs
): ToolDefinition<S, WaveformToolModel, WaveformUi> {
  // An add reads the latest state and probe after its probe resolves.
  const latest = useLatest(inputs);
  const { update, search, renderedX } = inputs;
  // The schema, built once per owner: the Hide-all eye writes the latest `setUi`.
  const [schema] = useState(() =>
    waveformSchema<WaveformToolModel, WaveformUi>({
      setUi: (fn) => latest.current.setUi?.(fn),
    })
  );
  return useMemo(
    () =>
      waveformDefinition(
        {
          getState: () => latest.current.state,
          update,
          probe: {
            probe: (pv) => latest.current.probe.probe(pv),
            endProbe: (pv) => latest.current.probe.endProbe(pv),
          },
          search,
          // A string, equal across frames: only an x-source change rebuilds the binding.
          getRenderedX: () => renderedX,
        },
        schema
      ),
    [latest, update, search, schema, renderedX]
  );
}
