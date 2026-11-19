// The Waveform model: a pure derivation from the state, a summary of each
// curve's ring and the PVs' metadata. It decides, per row, whether the curve
// is drawn and why not (status and chip), each curve's length, the Live axis
// unit, the X axis, and the canvas state. It holds no frame data, so two
// derivations from equal inputs compare equal structurally (the Outline is
// re-rendered only when the model changes, not per frame).
//
// Rules:
//   - One axis, one unit: once every live and reference PV is settled the
//     axis unit is the EGU of the first PV in state order — live in order,
//     then the PV reference — with a non-empty EGU, regardless of connection,
//     length or visibility. A PV is settled when its metadata is in or its own
//     metadata window ended without it (`metaExpired`: its timeout passed, or
//     it reported disconnected first), and then counts as having no unit; a
//     late metadata can still set the unit. While a PV is in its window its
//     row says "waiting for metadata"; once the window ended with nothing
//     reported it is an error, "no metadata". A PV of another
//     non-empty unit is kept in its section, not drawn, with the "Open a new
//     Waveform tab (+)" message. Being a pure function of the state, the unit
//     is re-evaluated on every section change (a refused curve is admitted
//     when the unit changes) and never depends on the order frames arrived in.
//     The X source has no part in it. While undecided nothing is drawn.
//   - While Δ is on and the reference has no frame, no live curve is
//     drawn; the canvas and the Reference chip say what Δ waits for.
//   - In Δ against a snapshot each curve subtracts its own entry; an entry
//     counts only when the curve's ring was not reset after `snapshot.time`,
//     else the curve is not drawn and carries "not in snapshot".
//   - Live vs reference: in Δ a curve of another length than its
//     reference frame is not drawn and carries "length mismatch".
//   - One usability rule for the X source: a live curve is a candidate when
//     connected, non-empty, unit-accepted and (in Δ) of the reference's length.
//     The X source is usable when connected, non-empty, numeric and the length
//     of at least one candidate. Unusable → every curve on index, the axis
//     reads "Element" and the X row's chip names the reason; usable → a curve
//     of another length is hidden with the length-mismatch chip.
//   - The canvas message, in order: no live PV → "Add a waveform PV"; Δ waiting for a
//     reference frame; frames but nothing drawable → "No curve can be
//     drawn — see the Waveforms list" with counts; else, with nothing drawn
//     yet or the unit undecided, "waiting for data".

import type { RowStatus } from '../../workbench/types';
import { ringCapacity } from './frames';
import type { WaveformState } from './query';

/**
 * Structural equality over plain data (the model holds no typed arrays): the
 * compare behind "two derivations from equal inputs compare equal".
 */
export function sameData(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.hasOwn(b, k)) return false;
    if (!sameData((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) {
      return false;
    }
  }
  return true;
}

/** What the model needs of one curve's ring (and its listener). */
export interface WaveformRingSummary {
  /** The PV's listener reports it connected. */
  connected: boolean;
  /**
   * Element count of the latest frame held; null when the ring holds none.
   * A PV reference keeps its last frame while disconnected.
   */
  length: number | null;
  /** The ring's last reset (FrameRing.resetEpoch), ms. */
  resetEpoch: number;
  /** Arrival of the latest frame, ms; null when none. */
  arrival: number | null;
  /**
   * The value kind is numeric; absent = numeric. False (a string waveform)
   * refuses the PV in every role: live, PV reference and X source.
   */
  numeric?: boolean;
  /**
   * Live curves only: the frames the ring keeps when the memory budget holds
   * it below max(persistence, average); absent when it keeps what was asked.
   */
  historyLimit?: number;
}

/** A PV's metadata once it arrived; absent while it has not. */
export interface WaveformPvMeta {
  /** Engineering units; '' when the PV has none. */
  egu: string;
}

export type WaveformMetaMap = Readonly<Record<string, WaveformPvMeta | undefined>>;

export interface WaveformModelInput {
  state: WaveformState;
  /** By PV: live, PV reference and X source. */
  rings: Readonly<Record<string, WaveformRingSummary | undefined>>;
  meta: WaveformMetaMap;
  /** Every PV's metadata window passed: decide the unit with what arrived. */
  metaTimedOut: boolean;
  /** By PV: its own metadata window ended without metadata (timed out, or reported disconnected). */
  metaExpired?: Readonly<Record<string, boolean | undefined>>;
  /** Per live PV, the frames its rolling window keeps; absent = none. */
  rolling?: Readonly<Record<string, number | undefined>>;
}

export interface WaveformLiveRow {
  pv: string;
  status: RowStatus;
  /** Short text for the row's L0 status slot; null when nothing to say. */
  chip: string | null;
  /** The full reason (refusal or mismatch), for Properties and the tooltip. */
  message?: string;
  /** Latest frame length; null without a frame. */
  length: number | null;
  egu: string;
  hidden: boolean;
  /** Drawn on the canvas. */
  drawable: boolean;
  /** The frames the memory budget lets the curve keep, when below what was asked. */
  historyLimit?: number;
}

export interface WaveformReferenceRow {
  kind: 'pv' | 'snapshot' | 'rolling';
  /** The reference PV; null for a snapshot or a rolling reference. */
  pv: string | null;
  status: RowStatus;
  chip: string | null;
  message?: string;
  /** PV reference: its frame length; snapshot: null (one entry per curve). */
  length: number | null;
  hidden: boolean;
  drawable: boolean;
  /** Snapshot: when it was taken (ms) and how many curves it holds. */
  time?: number;
  curves?: number;
  /** Rolling: the window (s); a snapshot frozen from one: the window it came from. */
  seconds?: number;
  /** The reference has a per-element σ (rolling, or a snapshot frozen from one): the band and `s` exist. */
  spread?: boolean;
}

export interface WaveformXRow {
  pv: string;
  status: RowStatus;
  chip: string | null;
  length: number | null;
  egu: string;
  usable: boolean;
}

export interface WaveformXAxis {
  mode: 'index' | 'source';
  /** The X axis title: Label, else the X source's EGU, else "Element". */
  label: string;
  /** The X source's length when the axis uses it. */
  length: number | null;
}

export type WaveformCanvasState =
  | { kind: 'add'; message: string }
  | { kind: 'delta-waiting'; message: string }
  | {
      kind: 'none-drawable';
      message: string;
      counts: { live: number; hidden: number; refused: number };
    }
  | { kind: 'waiting'; message: string }
  | { kind: 'ready' };

export interface WaveformModel {
  /** The Live axis unit; null while undecided or when no PV has an EGU. */
  unit: string | null;
  unitDecided: boolean;
  live: WaveformLiveRow[];
  reference: WaveformReferenceRow | null;
  x: WaveformXRow | null;
  xAxis: WaveformXAxis;
  delta: { on: boolean; waiting: string | null };
  canvas: WaveformCanvasState;
}

export const ELEMENT_LABEL = 'Element';
export const CANVAS_ADD = 'Add a waveform PV';
export const CANVAS_NONE_DRAWABLE = 'No curve can be drawn — see the Waveforms list';
export const CANVAS_WAITING = 'waiting for data';
export const NOT_IN_SNAPSHOT = 'not in snapshot — take a new snapshot';
export const ROLLING_COLLECTING = 'collecting';
export const LENGTH_MISMATCH = 'length mismatch';
/** A PV in its metadata window: the axis unit waits for it. */
export const META_WAITING = 'waiting for metadata';
/** A PV whose metadata window ended with nothing reported. */
export const META_MISSING = 'no metadata';

/** A string waveform: its frames are all NaN, so it is never drawn. */
export const STRING_WAVEFORM = "string waveform — can't be plotted";

export function stringWaveformMessage(pv: string): string {
  return `${pv} holds strings; string waveforms can't be plotted.`;
}

export function historyLimitChip(frames: number): string {
  return `history limited to ${frames} frames`;
}

export function historyLimitMessage(length: number, frames: number, asked: number): string {
  return (
    `${length} elements per frame: Average and Persistence use ${frames} of ${asked} ` +
    'frames, to keep the history within the memory budget.'
  );
}

/** The health line's note on trimmed histories; null when no drawn curve is trimmed. */
export function historyLimitNotice(model: WaveformModel): string | null {
  const rows = model.live.filter((r) => r.drawable && r.historyLimit !== undefined);
  if (rows.length === 0) return null;
  const frames = Math.min(...rows.map((r) => r.historyLimit!));
  return `history limited to ${frames} frames for ${rows.map((r) => r.pv).join(', ')}`;
}

export function metaMissingMessage(pv: string): string {
  return `${pv} sent no metadata or data: check the name, or whether its IOC is up.`;
}

export function unitMessage(pv: string, units: string, axis: string): string {
  return `${pv} is in ${units}; the axis is ${axis}. Open a new Waveform tab (+) for it.`;
}

export function deltaWaitingMessage(ref: string): string {
  return `Δ needs a reference frame — waiting for ${ref}`;
}

/** HH:MM:SS in local time. */
export function clockTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function refPv(state: WaveformState): string | null {
  return state.reference?.kind === 'pv' ? state.reference.pv : null;
}

/** The axis unit over the live PVs, then the PV reference. */
export function axisUnitOf(
  state: WaveformState,
  meta: WaveformMetaMap,
  timedOut = false,
  expired: Readonly<Record<string, boolean | undefined>> = {}
): { decided: boolean; unit: string | null } {
  const ref = refPv(state);
  const order = ref === null ? state.pvs : [...state.pvs, ref];
  const decided = timedOut || order.every((pv) => meta[pv] !== undefined || expired[pv] === true);
  if (!decided) return { decided, unit: null };
  for (const pv of order) {
    const egu = meta[pv]?.egu ?? '';
    if (egu !== '') return { decided, unit: egu };
  }
  return { decided, unit: null };
}

function refused(egu: string, unit: string | null): boolean {
  return unit !== null && egu !== '' && egu !== unit;
}

export function deriveWaveformModel(input: WaveformModelInput): WaveformModel {
  const { state, rings, meta } = input;
  const expired = input.metaExpired ?? {};
  const { decided, unit } = axisUnitOf(state, meta, input.metaTimedOut, expired);
  const egu = (pv: string) => meta[pv]?.egu ?? '';
  // A PV with no metadata and no report: in its window, or its window ended.
  const metaGate = (pv: string): 'waiting' | 'missing' | null => {
    if (meta[pv] !== undefined || rings[pv] !== undefined) return null;
    return input.metaTimedOut || expired[pv] === true ? 'missing' : 'waiting';
  };
  const ref = state.reference;
  const delta = state.delta && ref !== null;

  // ── Reference ──────────────────────────────────────────────────────────
  let reference: WaveformReferenceRow | null = null;
  let refLength: number | null = null; // PV reference frame length, when usable
  let deltaWaiting: string | null = null;
  if (ref?.kind === 'pv') {
    const summary = rings[ref.pv];
    const hidden = state.hidden[ref.pv] === true;
    const unitRefused = decided && refused(egu(ref.pv), unit);
    const length = summary?.length ?? null;
    const strings = summary?.numeric === false;
    const hasFrame = !unitRefused && !strings && length !== null;
    if (hasFrame) refLength = length;
    let status: RowStatus = 'ok';
    let chip: string | null = null;
    let message: string | undefined;
    if (unitRefused) {
      status = 'refused';
      message = unitMessage(ref.pv, egu(ref.pv), unit!);
    } else if (strings) {
      status = 'error';
      chip = STRING_WAVEFORM;
      message = stringWaveformMessage(ref.pv);
    } else if (length === null) {
      status = summary !== undefined && !summary.connected ? 'error' : 'pending';
      chip = summary !== undefined && !summary.connected ? 'disconnected' : null;
      // A hidden reference has no listener: its window says nothing about it.
      const gate = hidden ? null : metaGate(ref.pv);
      if (gate === 'waiting') chip = META_WAITING;
      else if (gate === 'missing') {
        status = 'error';
        chip = META_MISSING;
        message = metaMissingMessage(ref.pv);
      }
    } else if (summary !== undefined && !summary.connected) {
      status = 'stale';
      chip =
        summary.arrival === null
          ? 'disconnected'
          : `disconnected, holding frame from ${clockTime(summary.arrival)}`;
    }
    if (delta && !hasFrame) {
      deltaWaiting = deltaWaitingMessage(ref.pv);
      if (!unitRefused && !strings) {
        status = 'pending';
        chip = deltaWaiting;
      }
    }
    reference = {
      kind: 'pv',
      pv: ref.pv,
      status,
      chip,
      ...(message !== undefined ? { message } : {}),
      length,
      hidden,
      drawable: hasFrame && decided && !hidden && !delta,
    };
  } else if (ref?.kind === 'snapshot') {
    reference = {
      kind: 'snapshot',
      pv: null,
      status: 'ok',
      chip: null,
      length: null,
      hidden: false,
      drawable: !delta,
      time: ref.time,
      curves: Object.keys(ref.frames).length,
      ...(ref.rolling !== undefined ? { seconds: ref.rolling } : {}),
      spread: ref.spread !== undefined,
    };
  } else if (ref?.kind === 'rolling') {
    // Collecting until some curve's window holds two frames (a σ exists).
    const kept = state.pvs.map((pv) => input.rolling?.[pv] ?? 0);
    const collecting = !kept.some((n) => n >= 2);
    reference = {
      kind: 'rolling',
      pv: null,
      status: collecting ? 'pending' : 'ok',
      chip: collecting ? ROLLING_COLLECTING : null,
      length: null,
      hidden: false,
      drawable: !delta,
      curves: kept.filter((n) => n >= 1).length,
      seconds: ref.seconds,
      spread: true,
    };
  }

  // ── Live, before the X source ────────────────────────────────────────────
  // Live curves compared against the PV reference's frame, and how many matched.
  let refCompared = 0;
  let refMatched = 0;
  const live: WaveformLiveRow[] = state.pvs.map((pv) => {
    const summary = rings[pv];
    const length = summary?.length ?? null;
    const row: WaveformLiveRow = {
      pv,
      status: 'ok',
      chip: null,
      length,
      egu: egu(pv),
      hidden: state.hidden[pv] === true,
      drawable: false,
    };
    if (decided && refused(row.egu, unit)) {
      row.status = 'refused';
      row.message = unitMessage(pv, row.egu, unit!);
      return row;
    }
    if (row.hidden) return row;
    const gate = metaGate(pv);
    if (gate === 'missing') {
      row.status = 'error';
      row.chip = META_MISSING;
      row.message = metaMissingMessage(pv);
      return row;
    }
    if (!decided || summary === undefined) {
      row.status = 'pending';
      if (gate === 'waiting') row.chip = META_WAITING;
      return row;
    }
    if (!summary.connected) {
      row.status = 'error';
      row.chip = 'disconnected';
      return row;
    }
    if (summary.numeric === false) {
      row.status = 'error';
      row.chip = STRING_WAVEFORM;
      row.message = stringWaveformMessage(pv);
      return row;
    }
    if (length === null) {
      row.status = 'pending';
      return row;
    }
    if (length === 0) {
      row.chip = 'empty';
      return row;
    }
    if (delta) {
      if (deltaWaiting !== null) return row;
      let against: { length: number; what: string } | null = null;
      if (ref?.kind === 'snapshot') {
        const entry = Object.prototype.hasOwnProperty.call(ref.frames, pv)
          ? ref.frames[pv]
          : undefined;
        if (entry === undefined || summary.resetEpoch > ref.time) {
          row.status = 'stale';
          row.chip = NOT_IN_SNAPSHOT;
          return row;
        }
        against = { length: entry.length, what: 'snapshot' };
      } else if (ref?.kind === 'rolling') {
        // The window follows the ring, so it holds a frame of this length as
        // soon as the ring does: Δ against it never waits or mismatches.
        if ((input.rolling?.[pv] ?? 0) === 0) {
          row.status = 'pending';
          row.chip = ROLLING_COLLECTING;
          return row;
        }
      } else if (refLength !== null) {
        against = { length: refLength, what: 'reference' };
        refCompared++;
        if (refLength === length) refMatched++;
      }
      if (against !== null && against.length !== length) {
        row.status = 'error';
        row.chip = LENGTH_MISMATCH;
        row.message = `${length} elements; ${against.what} has ${against.length}`;
        return row;
      }
    }
    row.drawable = true;
    if (summary.historyLimit !== undefined) {
      const asked = ringCapacity(state.persist, state.avg);
      row.historyLimit = summary.historyLimit;
      row.chip = historyLimitChip(summary.historyLimit);
      row.message = historyLimitMessage(length, summary.historyLimit, asked);
    }
    return row;
  });

  // The reference is the odd one out when it matches no live curve it is
  // subtracted from.
  if (reference?.kind === 'pv' && refCompared > 0 && refMatched === 0) {
    reference.status = 'error';
    reference.chip = LENGTH_MISMATCH;
  }

  // ── X source ──────────────────────────────────────────────────────
  let x: WaveformXRow | null = null;
  let xAxis: WaveformXAxis = { mode: 'index', label: ELEMENT_LABEL, length: null };
  if (state.xs !== '') {
    const summary = rings[state.xs];
    const length = summary?.length ?? null;
    const candidates = new Set(live.filter((r) => r.drawable).map((r) => r.length));
    let chip: string | null = null;
    let status: RowStatus = 'error';
    if (summary === undefined || (summary.connected && length === null)) {
      chip = CANVAS_WAITING;
      status = 'pending';
    } else if (!summary.connected) chip = 'disconnected';
    else if (length === 0) chip = 'empty';
    else if (summary.numeric === false) chip = 'not numeric';
    else if (!candidates.has(length)) chip = `length ${length} matches no curve`;
    const usable = chip === null;
    if (usable) status = 'ok';
    x = { pv: state.xs, status, chip, length, egu: egu(state.xs), usable };
    if (usable && state.xAxis === 'source') {
      xAxis = {
        mode: 'source',
        label: state.xLabel || x.egu || ELEMENT_LABEL,
        length,
      };
      for (const row of live) {
        if (row.drawable && row.length !== length) {
          row.drawable = false;
          row.status = 'error';
          row.chip = LENGTH_MISMATCH;
          row.message = `${row.length} elements; X axis PV has ${length}`;
        }
      }
    }
  }

  // ── Canvas ─────────────────────────────────────────────────────────
  let canvas: WaveformCanvasState;
  if (live.length === 0) canvas = { kind: 'add', message: CANVAS_ADD };
  else if (deltaWaiting !== null) canvas = { kind: 'delta-waiting', message: deltaWaiting };
  else if (live.some((r) => r.drawable)) canvas = { kind: 'ready' };
  else if (decided && live.some((r) => r.length !== null || r.hidden || r.status === 'refused')) {
    canvas = {
      kind: 'none-drawable',
      message: CANVAS_NONE_DRAWABLE,
      counts: {
        live: live.length,
        hidden: live.filter((r) => r.hidden).length,
        refused: live.filter((r) => r.status === 'refused').length,
      },
    };
  } else canvas = { kind: 'waiting', message: CANVAS_WAITING };

  return {
    unit,
    unitDecided: decided,
    live,
    reference,
    x,
    xAxis,
    delta: { on: delta, waiting: deltaWaiting },
    canvas,
  };
}
