// Waveform's binding half.
//
// Outline: three sections whose id and kind are the group (`schema/`), each
// under its own heading (the schema's `group`: Signals, Reference, X axis PV).
//
//   Live       n/8  — the live curves in order, the axis unit as unit tag.
//   Reference  0–1  — the PV reference, or the snapshot (item `snapshot`).
//   X          0–1  — the X axis PV.
//
// A row's status and chip come from the controller's `model` (`model.ts`): the
// status is the dot, and the full message (a unit refusal, a length mismatch)
// or else the chip ("disconnected", "not in snapshot …") is the row's status
// text. Swatch and eye are not built here: the Outline renders the item's own
// Colour and Visible fields (`row: 'swatch'` / `'eye'`) where the item has
// them, so an X axis PV card has neither and a snapshot card no eye.
//
// Ops. `add` trims, refuses at once what the commit writer would refuse anyway
// (a full section, a duplicate), then probes the PV with the waveform kind
// rule and commits through `edit.addPv` against the latest state, returning
// its refusal. Adding to Reference sets a PV reference
// (replacing a snapshot). `remove` and `move` go through `edit.removePv` /
// `edit.movePv` (the snapshot through `edit.removeReference`); `move` and the
// Plot on select share `waveformMoveRefusal` ("Live is full (8/8)"; an
// occupied Reference or X axis PV swaps).
//
// Drawings: a drawings section, listed while the state
// holds drawings, from the generic `drawingsSection` over `state.drawings`. A
// drawing hidden by context (`waveformHiddenReason`: the x the chart plots,
// Δ) is dimmed with its reason. `remove` deletes a drawing through `update`;
// a drawing moves nowhere.
//
// Rate rule: `model` is compared structurally. While the state is the same
// object, the derived model is structurally equal and the rendered x is the
// same, `outline` returns the very view-model it returned last, so a data tick
// re-renders no Outline.

import { WAVEFORM_CATALOG } from '../../annotations/catalog';
import { VALUE_X_AXIS } from '../../annotations/catalog/xAxis';
import { drawingsSection } from '../../annotations/host/workbench';
import { waveformHiddenReason } from './drawings';
import {
  addPv,
  movePv,
  removeDrawing,
  removePv,
  removeReference,
  type WaveformGroup,
} from './edit';
import { clockTime, sameData, type WaveformModel } from './model';
import { MAX_LIVE, type WaveformState } from './query';
import type { PvSearch } from '../../pvSearch';
import type {
  AddRefusal,
  OutlineRow,
  OutlineSection,
  OutlineViewModel,
  RowStatus,
  ToolBinding,
} from '../../workbench/types';
import {
  GROUP_LABELS,
  isGroup,
  ROLLING_ITEM_ID,
  SNAPSHOT_ITEM_ID,
  parseWaveformItemId,
  waveformItemId,
  waveformMoveRefusal,
  WAVEFORM_DRAWING_AXES,
  type WaveformSchemaModel,
} from './schema';
import type { ProbeResult } from '../shared/pvTracker';
import { DRAWING_STAYS_REASON, isListedDrawing } from '../shared/drawingOutline';

type S = WaveformState;

/** Waveform's model: the schema's slice (the derived `waveform` model and the chart input). */
export type WaveformToolModel = WaveformSchemaModel;

/** The typed-PV check with the waveform kind rule (`tool.ts`: `createWaveformProbe`). */
export interface WaveformProbe {
  /** Resolves once the PV is verified or its metadata timeout passed. */
  probe(pv: string): Promise<ProbeResult>;
  /** Drop the probe's hold on the PV. */
  endProbe(pv: string): void;
}

/** What the binding needs from the tool's owner (App.tsx). */
export interface WaveformBindingInput {
  /** The latest state: an add commits against it after its async probe. */
  getState(): S;
  /** The tool's single writer. */
  update(fn: (state: S) => S): void;
  /** The waveform-kind probe. */
  probe: WaveformProbe;
  /** The add rows' PV search; the workbench default when absent. */
  search?: PvSearch;
  /**
   * The x the chart plots, `renderedXSource(model, frames)`: what a
   * drawing's `xRef` is checked against. Absent, no drawing is hidden for its x.
   */
  getRenderedX?(): string | undefined;
}

/** Why a snapshot or rolling row cannot be dragged elsewhere: it holds no PV. */
export const SNAPSHOT_MOVE_REFUSAL = 'A snapshot holds no PV; it stays in Reference';
export const ROLLING_MOVE_REFUSAL = 'A rolling mean holds no PV; it stays in Reference';

interface RowFacts {
  status: RowStatus;
  chip: string | null;
  message?: string;
}

function row(
  id: string,
  kind: WaveformGroup,
  label: string,
  facts: RowFacts | undefined
): OutlineRow {
  const out: OutlineRow = { id, kind, label, status: facts?.status ?? 'pending' };
  const text = facts?.message ?? facts?.chip ?? null;
  if (text !== null && text !== '') out.refusal = text;
  return out;
}

function curveLabel(state: S, pv: string): string {
  return state.styles[pv]?.label ?? pv;
}

/** The section titles; the X axis PV section reads `X` under its group heading. */
const SECTION_TITLES: Record<WaveformGroup, string> = {
  live: GROUP_LABELS.live,
  reference: GROUP_LABELS.reference,
  xsource: 'X',
};

const ADD_PLACEHOLDERS: Record<WaveformGroup, string> = {
  live: 'Add Live PV',
  reference: 'Add Reference PV',
  xsource: 'Add X axis PV',
};

function addRow(group: WaveformGroup, search: PvSearch | undefined): OutlineSection['add'] {
  const add: NonNullable<OutlineSection['add']> = { placeholder: ADD_PLACEHOLDERS[group] };
  if (search !== undefined) add.search = search;
  return add;
}

/**
 * The drawings section over `state.drawings`: a drawing hidden by context
 * is dimmed with the reason. `renderedX` absent skips the x check.
 */
export function waveformDrawingsSection(
  state: S,
  model: WaveformModel,
  renderedX?: string
): OutlineSection {
  const deltaOn = model.delta.on;
  return drawingsSection(
    state.drawings,
    WAVEFORM_DRAWING_AXES,
    (a) => waveformHiddenReason(a, renderedX ?? a.xRef ?? '', deltaOn, WAVEFORM_CATALOG),
    { catalog: WAVEFORM_CATALOG, xAxis: VALUE_X_AXIS }
  );
}

/** The Outline view-model of `state` and the derived `model`. */
export function waveformOutline(
  state: S,
  model: WaveformModel,
  search?: PvSearch,
  renderedX?: string
): OutlineViewModel {
  const liveRows = state.pvs.map((pv) =>
    row(
      waveformItemId('live', pv),
      'live',
      curveLabel(state, pv),
      model.live.find((r) => r.pv === pv)
    )
  );
  const live: OutlineSection = {
    id: 'live',
    kind: 'live',
    title: SECTION_TITLES.live,
    count: state.pvs.length,
    capacity: MAX_LIVE,
    rows: liveRows,
    add: addRow('live', search),
  };
  if (model.unit !== null && model.unit !== '') live.unit = model.unit;

  const ref = state.reference;
  const refFacts = model.reference ?? undefined;
  const refRows: OutlineRow[] = [];
  if (ref?.kind === 'pv') {
    refRows.push(
      row(
        waveformItemId('reference', ref.pv),
        'reference',
        curveLabel(state, ref.pv),
        refFacts?.pv === ref.pv ? refFacts : undefined
      )
    );
  } else if (ref?.kind === 'snapshot') {
    refRows.push(
      row(
        SNAPSHOT_ITEM_ID,
        'reference',
        ref.style?.label ?? `Snapshot ${clockTime(ref.time)}`,
        refFacts?.kind === 'snapshot' ? refFacts : undefined
      )
    );
  } else if (ref?.kind === 'rolling') {
    refRows.push(
      row(
        ROLLING_ITEM_ID,
        'reference',
        ref.style?.label ?? `Rolling mean ${ref.seconds} s`,
        refFacts?.kind === 'rolling' ? refFacts : undefined
      )
    );
  }
  const reference: OutlineSection = {
    id: 'reference',
    kind: 'reference',
    title: SECTION_TITLES.reference,
    count: refRows.length,
    capacity: 1,
    rows: refRows,
  };
  if (ref === null) reference.add = addRow('reference', search);

  const xFacts = model.x !== null && model.x.pv === state.xs ? model.x : undefined;
  const xsource: OutlineSection = {
    id: 'xsource',
    kind: 'xsource',
    title: SECTION_TITLES.xsource,
    count: state.xs === '' ? 0 : 1,
    capacity: 1,
    rows:
      state.xs === ''
        ? []
        : [row(waveformItemId('xsource', state.xs), 'xsource', state.xs, xFacts)],
  };
  if (state.xs === '') xsource.add = addRow('xsource', search);

  const sections = [live, reference, xsource];
  if (state.drawings.length > 0) sections.push(waveformDrawingsSection(state, model, renderedX));
  return { sections };
}

/** Waveform's `ToolBinding`; the owner rebuilds it when `update` or `search` change. */
export function waveformBinding(input: WaveformBindingInput): ToolBinding<S, WaveformToolModel> {
  const { getState, update, probe, search, getRenderedX } = input;

  // Rate rule: the last view-model, kept while state, model and rendered x are unchanged.
  let last: {
    state: S;
    model: WaveformModel;
    renderedX: string | undefined;
    outline: OutlineViewModel;
  } | null = null;

  function outline(state: S, model: WaveformToolModel): OutlineViewModel {
    const derived = model.waveform;
    const renderedX = getRenderedX?.();
    if (
      last !== null &&
      last.state === state &&
      last.renderedX === renderedX &&
      sameData(last.model, derived)
    ) {
      return last.outline;
    }
    const next = waveformOutline(state, derived, search, renderedX);
    // A new state object of the same content keeps the previous view-model too.
    const kept = last !== null && sameData(last.outline, next) ? last.outline : next;
    last = { state, model: derived, renderedX, outline: kept };
    return kept;
  }

  async function add(sectionId: string, raw: string): Promise<AddRefusal | void> {
    const pv = raw.trim();
    if (pv === '' || !isGroup(sectionId)) return;
    const group = sectionId;
    // A full section or a duplicate needs no probe (and no listener).
    const early = addPv(getState(), group, pv).refusal;
    if (early !== undefined) return { message: early };

    const result = await probe.probe(pv);
    if (!result.ok) return { message: result.message };
    // The controller listens to the state's PVs itself; the probe's hold ends here.
    probe.endProbe(pv);

    const refusal = addPv(getState(), group, pv).refusal;
    if (refusal !== undefined) return { message: refusal };
    update((state) => addPv(state, group, pv).state);
  }

  function moveRefusal(itemId: string, sectionId: string): string | null {
    if (isListedDrawing(getState(), itemId)) return DRAWING_STAYS_REASON;
    const item = parseWaveformItemId(itemId);
    if (item !== null && item.pv === null && sectionId !== item.group && isGroup(sectionId)) {
      return itemId === ROLLING_ITEM_ID ? ROLLING_MOVE_REFUSAL : SNAPSHOT_MOVE_REFUSAL;
    }
    return waveformMoveRefusal(getState(), itemId, sectionId);
  }

  return {
    outline,
    ops: {
      add,
      remove(itemId) {
        if (isListedDrawing(getState(), itemId)) {
          update((state) => removeDrawing(state, itemId, WAVEFORM_CATALOG));
          return;
        }
        const item = parseWaveformItemId(itemId);
        if (item === null) return;
        const pv = item.pv;
        if (pv === null) update((state) => removeReference(state));
        else update((state) => removePv(state, pv));
      },
      move(itemId, sectionId) {
        if (isListedDrawing(getState(), itemId)) return;
        const item = parseWaveformItemId(itemId);
        if (item === null || item.pv === null || !isGroup(sectionId)) return;
        if (moveRefusal(itemId, sectionId) !== null) return;
        const pv = item.pv;
        update((state) => movePv(state, pv, sectionId).state);
      },
    },
    moveRefusal,
  };
}
