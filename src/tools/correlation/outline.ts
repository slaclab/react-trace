// Correlation's binding half.
//
// Outline: three sections whose id and kind are the role, each under its own
// group heading (the section schema's `group`).
//
//   Y        n/8   — Signals: the Ys in order, the frozen axis unit as the
//                    unit tag.
//   X        1/1   — X axis PV: the X PV; its add row while there is room.
//   Trigger  0–1   — Trigger: the trigger PV, if any. Its inline header field
//                    is the Timer | PV Source (`trigger-source` testid); its
//                    add row shows only while the user has chosen PV and not
//                    added one yet (`ui.pendingTrigger`).
//
// A row's status is the PV's tracker status (../shared/pvTracker.ts): ok, pending (checking),
// stale (unverified: no metadata within 3 s, still plotted) or refused with
// the tracker's message. A refused PV that came with the state stays listed;
// loading never mutates the state.
//
// Ops. `add` trims, refuses at once what the commit writer would refuse anyway
// (a full role, a duplicate), then probes the PV through the tracker (kind,
// and for a Y the frozen axis unit) and commits through `edit.addPv` against
// the latest state, returning its refusal. Adding the
// trigger PV clears `pendingTrigger`. `remove` and `move` go through
// `edit.removePv` / `edit.movePv`; `move` and the Plot on select share
// `correlationMoveRefusal`, and moving a PV into Trigger clears the
// pending flag too.
//
// Drawings. While `state.drawings` is not
// empty a Drawings section follows Trigger: the generic drawings section
// over Correlation's catalog and the value X axis. A drawing hidden by context
// (its Y removed or hidden, not the density Y, or drawn against another X) is
// dimmed with the reason from `correlationHiddenReason`, compared against the
// X the canvas draws (`model.drawnX`, else `state.x`). `remove` and the move
// rule check drawing ids before PV ids; removing a drawing goes through
// `update`, so the drawing ring records it and ⌘Z restores it.
//
// Cross-tool. A probe refused because the PV is a
// waveform carries the action "Open in Waveform", which hands `pv=<name>` to
// the Waveform tool through the shared `openTool` helper (posted to the host
// embedded, a new tab standalone). Every other refusal is text only.

import { CORRELATION_CATALOG } from '../../annotations/catalog';
import { VALUE_X_AXIS } from '../../annotations/catalog/xAxis';
import { drawingsSection } from '../../annotations/host/workbench';
import { correlationHiddenReason } from './drawings';
import { addPv, movePv, removeDrawing, removePv } from './edit';
import type { CorrelationPvs } from './pvs';
import { MAX_Y, type CorrelationState } from './query';
import { openTool } from '../../embed/openTool';
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
  correlationDrawingAxes,
  correlationItemId,
  correlationMoveRefusal,
  isRole,
  parseCorrelationItemId,
  ROLE_LABELS,
  type CorrelationSchemaModel,
  type CorrelationUi,
} from './schema';
import { isListedDrawing } from '../shared/drawingOutline';
import type { ProbeResult, PvInfo, PvModel, PvRole } from '../shared/pvTracker';

type S = CorrelationState;

/** Correlation's model: the schema's slice plus the tracker's model of its PVs. */
export interface CorrelationModel extends CorrelationSchemaModel {
  pvs: PvModel;
  /**
   * The X the canvas draws (the frame's X PV); the drawings' "x source
   * changed" reason compares it. `state.x` when absent.
   */
  drawnX?: string;
}

/** What the binding needs from the tool's owner (App.tsx). */
export interface CorrelationBindingInput {
  /** The latest state: an add commits against it after its async probe. */
  getState(): S;
  /** The latest model (the frozen axis unit at commit time). */
  getModel(): CorrelationModel;
  /** The tool's single writer. */
  update(fn: (state: S) => S): void;
  /** The tracker's typed-PV check. */
  pvs: Pick<CorrelationPvs, 'probe' | 'endProbe'>;
  /** The transient UI record; `pendingTrigger` shows the Trigger add row. */
  ui: CorrelationUi;
  /** The add rows' PV search; the workbench default when absent. */
  search?: PvSearch;
}

export const OPEN_IN_WAVEFORM = 'Open in Waveform';

/** Waveform's query for one live PV: `pv=<name>`, ":" left readable. */
export function waveformQuery(pv: string): string {
  return `pv=${encodeURIComponent(pv).replace(/%3A/gi, ':')}`;
}

/** The add refusal of a refused probe; a waveform PV offers to open in Waveform. */
export function probeRefusal(pv: string, result: Extract<ProbeResult, { ok: false }>): AddRefusal {
  if (result.reason !== 'waveform') return { message: result.message };
  return {
    message: result.message,
    action: { label: OPEN_IN_WAVEFORM, onClick: () => openTool('waveform', waveformQuery(pv)) },
  };
}

/** The row status dot of a PV's tracker status. */
export function rowStatus(info: PvInfo | null | undefined): RowStatus {
  switch (info?.status) {
    case 'ok':
      return 'ok';
    case 'unverified':
      return 'stale';
    case 'refused-kind':
    case 'refused-unit':
      return 'refused';
    default:
      return 'pending';
  }
}

function row(role: PvRole, pv: string, label: string, info: PvInfo | null | undefined): OutlineRow {
  const out: OutlineRow = {
    id: correlationItemId(role, pv),
    kind: role,
    label,
    status: rowStatus(info),
  };
  if (out.status === 'refused' && info?.message !== undefined) out.refusal = info.message;
  return out;
}

function infoOf(info: PvInfo | null, pv: string): PvInfo | null {
  return info !== null && info.pv === pv ? info : null;
}

function labelOf(state: S, pv: string): string {
  return Object.hasOwn(state.labels, pv) ? state.labels[pv] : pv;
}

function addRow(role: PvRole, search: PvSearch | undefined): OutlineSection['add'] {
  const add: NonNullable<OutlineSection['add']> = { placeholder: `Add ${ROLE_LABELS[role]} PV` };
  if (search !== undefined) add.search = search;
  return add;
}

/** The Outline view-model of `state`; the Trigger add row shows while `ui.pendingTrigger`. */
export function correlationOutline(
  state: S,
  model: CorrelationModel,
  ui: CorrelationUi,
  search?: PvSearch
): OutlineViewModel {
  const { pvs } = model;

  const x: OutlineSection = {
    id: 'x',
    kind: 'x',
    title: ROLE_LABELS.x,
    count: state.x === '' ? 0 : 1,
    capacity: 1,
    rows:
      state.x === '' ? [] : [row('x', state.x, labelOf(state, state.x), infoOf(pvs.x, state.x))],
    add: addRow('x', search),
  };
  const xUnit = state.x === '' ? '' : model.unitsOf(state.x);
  if (xUnit !== '') x.unit = xUnit;

  const y: OutlineSection = {
    id: 'y',
    kind: 'y',
    title: ROLE_LABELS.y,
    count: state.ys.length,
    capacity: MAX_Y,
    rows: state.ys.map((pv) =>
      row(
        'y',
        pv,
        labelOf(state, pv),
        pvs.ys.find((i) => i.pv === pv)
      )
    ),
    add: addRow('y', search),
  };
  if (pvs.axisUnit !== null && pvs.axisUnit !== '') y.unit = pvs.axisUnit;

  const trigPv = state.trigger.mode === 'pv' ? state.trigger.pv : '';
  const trig: OutlineSection = {
    id: 'trig',
    kind: 'trig',
    title: ROLE_LABELS.trig,
    count: trigPv === '' ? 0 : 1,
    capacity: 1,
    rows: trigPv === '' ? [] : [row('trig', trigPv, trigPv, infoOf(pvs.trig, trigPv))],
  };
  if (trigPv === '' && ui.pendingTrigger === true) trig.add = addRow('trig', search);

  const sections = [y, x, trig];
  if (state.drawings.length > 0) {
    const drawnX = model.drawnX ?? state.x;
    sections.push(
      drawingsSection(
        state.drawings,
        correlationDrawingAxes(state),
        (a) => correlationHiddenReason(a, state, drawnX, CORRELATION_CATALOG),
        { catalog: CORRELATION_CATALOG, xAxis: VALUE_X_AXIS }
      )
    );
  }
  return { sections };
}

/** Correlation's `ToolBinding`; rebuild it per render with the latest `ui`. */
export function correlationBinding(
  input: CorrelationBindingInput
): ToolBinding<S, CorrelationModel> {
  const { getState, getModel, update, pvs, ui, search } = input;
  const clearPending = () => {
    if (ui.pendingTrigger === true) ui.setPendingTrigger?.(false);
  };

  async function add(sectionId: string, raw: string): Promise<AddRefusal | void> {
    const pv = raw.trim();
    if (pv === '' || !isRole(sectionId)) return;
    const role = sectionId;
    // A full role or a duplicate needs no probe (and no listener).
    const early = addPv(getState(), role, pv).refusal;
    if (early !== undefined) return { message: early };

    const result = await pvs.probe(pv, role);
    if (!result.ok) return probeRefusal(pv, result);

    const units = { units: result.info.units, axisUnit: getModel().pvs.axisUnit };
    const refusal = addPv(getState(), role, pv, units).refusal;
    if (refusal !== undefined) {
      pvs.endProbe(pv);
      return { message: refusal };
    }
    update((state) => addPv(state, role, pv, units).state);
    if (role === 'trig') clearPending();
  }

  return {
    outline: (state, model) => correlationOutline(state, model, ui, search),
    ops: {
      add,
      remove(itemId) {
        // Drawings first: a drawing id is never read as a PV item.
        if (isListedDrawing(getState(), itemId)) {
          update((state) => removeDrawing(state, itemId, CORRELATION_CATALOG));
          return;
        }
        const item = parseCorrelationItemId(itemId);
        if (item === null) return;
        update((state) => removePv(state, item.role, item.pv));
      },
      move(itemId, sectionId) {
        if (correlationMoveRefusal(getState(), itemId, sectionId) !== null) return;
        const item = parseCorrelationItemId(itemId);
        if (item === null || !isRole(sectionId) || item.role === sectionId) return;
        update((state) => movePv(state, item.role, item.pv, sectionId).state);
        if (sectionId === 'trig') clearPending();
      },
    },
    moveRefusal: (itemId, sectionId) => correlationMoveRefusal(getState(), itemId, sectionId),
  };
}
