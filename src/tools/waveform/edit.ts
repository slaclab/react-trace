// The Waveform state's one writer. Every change to a
// `WaveformState` — an add, remove or Plot on move, a Properties field,
// a snapshot taken by the controller, App.tsx's `update(fn)` — goes through a
// function here, and every one ends in `normalizeWaveformState`, so no caller
// ever holds a non-canonical state. All functions are pure: they take the
// latest state and return the next.
//
// Group moves never lose a PV: moving into an occupied Reference-by-PV or
// X source swaps the two PVs (the displaced one takes the mover's old slot, a
// Live position is kept), a Reference-by-snapshot is replaced, and the only
// refusal is a full Live ("Live is full (8/8)", the Plot on select's disabled
// text). Styles are keyed by PV, so a curve keeps its style across a move
// between Live and Reference and when an earlier curve is removed. The
// X-source item has a Label only (`xLabel`), so a move into or out of X source
// carries the Label and the normalizer drops the rest of the record.
//
// `addPv` checks capacity and duplicates inside the commit, against the state
// it is handed — the caller passes the latest state, after its async probe —
// and returns the refusal rather than letting the normalizer truncate the
// curves. Units are not checked here: a curve of another
// unit is kept and the model marks it not drawn.

import type { Catalog } from '../../annotations/catalog/types';
import type { Annotation } from '../../annotations/model';
import {
  MAX_LIVE,
  normalizeWaveformState,
  sameWaveformState,
  type WaveformRolling,
  type WaveformSnapshot,
  type WaveformState,
  type WaveformStyle,
} from './query';
import { patchFields, withRecord } from '../shared/recordEdit';

/** The Outline sections a PV can sit in (one at a time). */
export type WaveformGroup = 'live' | 'reference' | 'xsource';

/** A group's name, in the Plot on select, the add rows and refusals. */
export const GROUP_LABELS: Record<WaveformGroup, string> = {
  live: 'Live',
  reference: 'Reference',
  xsource: 'X axis PV',
};

/** The next state and, when the edit was refused, why (the state is then unchanged). */
export interface EditResult {
  state: WaveformState;
  refusal?: string;
}

/**
 * The one commit: apply `fn` and normalize, drawings against `catalog`.
 * Every writer below ends here. Reference-preserving: a field `fn` left
 * alone keeps its reference, and an edit that changes nothing returns `state`.
 */
export function apply(
  state: WaveformState,
  fn: (s: WaveformState) => WaveformState,
  catalog?: Catalog
): WaveformState {
  const next = normalizeWaveformState(fn(state), catalog);
  return next === state || sameWaveformState(next, state) ? state : next;
}

/** The refusal shown when Live has no room (also the Plot on select's disabled text). */
export function liveFullMessage(): string {
  return `Live is full (${MAX_LIVE}/${MAX_LIVE})`;
}

function refPv(state: WaveformState): string {
  return state.reference?.kind === 'pv' ? state.reference.pv : '';
}

/** The section `pv` sits in, or null. A snapshot reference holds no PV. */
export function groupOf(state: WaveformState, pv: string): WaveformGroup | null {
  if (pv === '') return null;
  if (state.pvs.includes(pv)) return 'live';
  if (refPv(state) === pv) return 'reference';
  if (state.xs === pv) return 'xsource';
  return null;
}

/**
 * Add `pv` to `group`, checked against `state` (pass the latest one). Refuses
 * a full Live ("Live is full (8/8)"), an occupied Reference-by-PV or X source
 * ("Reference is full (1/1)", "X axis PV is full (1/1)") and a PV already in
 * any section. A PV reference replaces a snapshot. An empty name adds nothing.
 */
export function addPv(state: WaveformState, group: WaveformGroup, raw: string): EditResult {
  const pv = raw.trim();
  if (pv === '') return { state };
  const at = groupOf(state, pv);
  if (at !== null) return { state, refusal: `${pv} is already in ${GROUP_LABELS[at]}` };
  if (group === 'live') {
    if (state.pvs.length >= MAX_LIVE) return { state, refusal: liveFullMessage() };
    return { state: apply(state, (s) => ({ ...s, pvs: [...s.pvs, pv] })) };
  }
  if (group === 'reference') {
    if (refPv(state) !== '') return { state, refusal: 'Reference is full (1/1)' };
    return { state: apply(state, (s) => ({ ...s, reference: { kind: 'pv', pv } })) };
  }
  if (state.xs !== '') return { state, refusal: `${GROUP_LABELS.xsource} is full (1/1)` };
  return { state: apply(state, (s) => ({ ...s, xs: pv })) };
}

/** Remove `pv` from whichever section holds it; its style and hidden record go with it. */
export function removePv(state: WaveformState, pv: string): WaveformState {
  const at = groupOf(state, pv);
  if (at === null) return state;
  return apply(state, (s) => {
    if (at === 'live') return { ...s, pvs: s.pvs.filter((p) => p !== pv) };
    if (at === 'reference') return { ...s, reference: null };
    return { ...s, xs: '' };
  });
}

/** Clear the reference, PV, snapshot or rolling (Δ turns off with it). */
export function removeReference(state: WaveformState): WaveformState {
  return apply(state, (s) => ({ ...s, reference: null }));
}

/**
 * Why `pv` cannot move to `to`, or null when it can. Shared by the Outline's
 * row drag and the Plot on select. Only a full Live refuses; an
 * occupied Reference or X source swaps, and a move out of Live into a swap
 * leaves Live's count unchanged.
 */
export function moveRefusal(state: WaveformState, pv: string, to: WaveformGroup): string | null {
  const from = groupOf(state, pv);
  if (from === null || from === to) return null;
  if (to === 'live' && state.pvs.length >= MAX_LIVE) return liveFullMessage();
  return null;
}

// The Label a PV carries in its section: the X title for the X source, else
// its style's label.
function labelOf(state: WaveformState, pv: string, group: WaveformGroup): string | undefined {
  return group === 'xsource' ? state.xLabel : state.styles[pv]?.label;
}

// Put `label` on a PV arriving in a curve section, keeping its other fields.
function withLabel(
  styles: Record<string, WaveformStyle>,
  pv: string,
  label: string | undefined
): Record<string, WaveformStyle> {
  if (label === undefined) return styles;
  return { ...styles, [pv]: { ...(styles[pv] ?? {}), label } };
}

/**
 * Move `pv` to `to` without losing any PV: an occupied Reference-by-PV
 * or X source swaps with the PV's old slot, a snapshot reference is replaced,
 * and a full Live refuses with the state unchanged. Styles and hidden records
 * stay keyed by PV; a Label crosses into and out of X source.
 */
export function movePv(state: WaveformState, pv: string, to: WaveformGroup): EditResult {
  const from = groupOf(state, pv);
  if (from === null || from === to) return { state };
  const refusal = moveRefusal(state, pv, to);
  if (refusal !== null) return { state, refusal };

  // What the target slot held before (single-PV sections only).
  const displaced = to === 'reference' ? refPv(state) : to === 'xsource' ? state.xs : '';
  const pvLabel = labelOf(state, pv, from);
  const displacedLabel = displaced !== '' ? labelOf(state, displaced, to) : undefined;

  return {
    state: apply(state, (s) => {
      let { pvs, reference, xs, xLabel, styles } = s;
      // Take the PV out of its slot; a displaced PV fills that slot.
      if (from === 'live') {
        pvs = pvs.flatMap((p) => (p === pv ? (displaced !== '' ? [displaced] : []) : [p]));
      } else if (from === 'reference') {
        reference = displaced !== '' ? { kind: 'pv', pv: displaced } : null;
      } else {
        xs = displaced;
        xLabel = undefined;
      }
      // Put it in the target (a snapshot reference is simply replaced).
      if (to === 'live') pvs = [...pvs, pv];
      else if (to === 'reference') reference = { kind: 'pv', pv };
      else xs = pv;
      // Labels follow their PV between the X title and a curve's style.
      if (to === 'xsource') {
        xLabel = pvLabel;
        styles = withLabel(styles, displaced, displacedLabel);
      } else if (from === 'xsource') {
        styles = withLabel(styles, pv, pvLabel);
        if (displaced !== '') xLabel = displacedLabel;
      }
      const next: WaveformState = { ...s, pvs, reference, xs, styles };
      if (xLabel === undefined) delete next.xLabel;
      else next.xLabel = xLabel;
      return next;
    }),
  };
}

/** Hide or show a Live or Reference curve (the Outline eye; `hidden` record). */
export function setHidden(state: WaveformState, pv: string, hidden: boolean): WaveformState {
  return apply(state, (s) => ({
    ...s,
    hidden: withRecord<true>(s.hidden, pv, hidden ? true : undefined),
  }));
}

/** The Visible field's setter: the inverse of `setHidden`. */
export function setVisible(state: WaveformState, pv: string, visible: boolean): WaveformState {
  return setHidden(state, pv, !visible);
}

// Merge `patch` into `style`: a field given as undefined is reset; an
// undefined patch resets the whole record. Returns undefined when empty.
function merged(
  style: WaveformStyle | undefined,
  patch: WaveformStyle | undefined
): WaveformStyle | undefined {
  if (patch === undefined) return undefined;
  const out = patchFields(style, patch);
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Pin (or, with undefined fields, reset) style fields of a Live or Reference
 * PV; an undefined patch resets the whole record (present = pinned).
 */
export function setStyle(
  state: WaveformState,
  pv: string,
  patch: WaveformStyle | undefined
): WaveformState {
  return apply(state, (s) => ({
    ...s,
    styles: withRecord(s.styles, pv, merged(s.styles[pv], patch)),
  }));
}

/** Pin (or with undefined, reset) a Label: the X title for the X source, else a curve's. */
export function setLabel(
  state: WaveformState,
  pv: string,
  label: string | undefined
): WaveformState {
  if (pv !== '' && state.xs === pv) {
    return apply(state, (s) => {
      const next = { ...s };
      if (label === undefined) delete next.xLabel;
      else next.xLabel = label;
      return next;
    });
  }
  return setStyle(state, pv, { label });
}

/**
 * Pin (or reset) fields of the snapshot or rolling reference's own style;
 * no-op for a PV reference (its style lives in `styles`) or none.
 */
export function setReferenceStyle(
  state: WaveformState,
  patch: WaveformStyle | undefined
): WaveformState {
  const ref = state.reference;
  if (ref?.kind === 'snapshot') {
    const style = merged(ref.style, patch);
    const snapshot: WaveformSnapshot = { ...ref };
    if (style !== undefined) snapshot.style = style;
    else delete snapshot.style;
    return apply(state, (s) => ({ ...s, reference: snapshot }));
  }
  if (ref?.kind === 'rolling') {
    const style = merged(ref.style, patch);
    const rolling: WaveformRolling = { kind: 'rolling', seconds: ref.seconds };
    if (style !== undefined) rolling.style = style;
    return apply(state, (s) => ({ ...s, reference: rolling }));
  }
  return apply(state, (s) => s);
}

/** The own style of a snapshot or rolling reference, for a replacement to inherit. */
function ownReferenceStyle(state: WaveformState): WaveformStyle | undefined {
  const ref = state.reference;
  return ref?.kind === 'snapshot' || ref?.kind === 'rolling' ? ref.style : undefined;
}

/**
 * A rolling reference over the last `seconds`: replaces any
 * reference, PV or snapshot, at once; keeps a snapshot's or earlier rolling
 * reference's own style. `null` clears a rolling reference (and only that).
 */
export function setRolling(state: WaveformState, seconds: number | null): WaveformState {
  if (seconds === null) {
    return state.reference?.kind === 'rolling' ? removeReference(state) : apply(state, (s) => s);
  }
  const style = ownReferenceStyle(state);
  const rolling: WaveformRolling = { kind: 'rolling', seconds };
  if (style !== undefined) rolling.style = style;
  return apply(state, (s) => ({ ...s, reference: rolling }));
}

/** The ±kσ spread band, 0 for none. */
export function setSpread(state: WaveformState, k: number): WaveformState {
  return apply(state, (s) => ({ ...s, spread: k }));
}

/** What the controller captures for Snapshot → reference. */
export interface SnapshotInput {
  /** Per Live PV, its last published pre-Δ frame (kept by identity). */
  frames: Readonly<Record<string, Float64Array>>;
  /** When it was taken, ms since the epoch. */
  time: number;
  /** The snapshot item's style; absent keeps an earlier snapshot's pinned style. */
  style?: WaveformStyle;
  /** Frozen from a rolling reference: its per-element σ per PV and its window (s). */
  spread?: Readonly<Record<string, Float64Array>>;
  rolling?: number;
}

/**
 * Snapshot → reference: replaces any reference, PV or snapshot, at once.
 * The snapshot is session state, never serialized; so is Δ against it.
 */
export function setSnapshot(state: WaveformState, input: SnapshotInput): WaveformState {
  const style = input.style ?? ownReferenceStyle(state);
  const snapshot: WaveformSnapshot = { kind: 'snapshot', frames: input.frames, time: input.time };
  if (style !== undefined) snapshot.style = style;
  if (input.spread !== undefined) snapshot.spread = input.spread;
  if (input.rolling !== undefined) snapshot.rolling = input.rolling;
  return apply(state, (s) => ({ ...s, reference: snapshot }));
}

/**
 * Subtract reference on or off; stays off without a reference. Against a
 * snapshot this is session-only: the serializer writes `delta` only with `ref`.
 */
export function setDelta(state: WaveformState, delta: boolean): WaveformState {
  return apply(state, (s) => ({ ...s, delta }));
}

// ------------------------------------------------------------------ drawings

/**
 * Append `drawing`. It is validated against `catalog` like every
 * drawing; one the catalog rejects is not added.
 */
export function addDrawing(
  state: WaveformState,
  drawing: Annotation,
  catalog?: Catalog
): WaveformState {
  return apply(state, (s) => ({ ...s, drawings: [...s.drawings, drawing] }), catalog);
}

/**
 * Patch the drawing `id`; a key given as undefined is removed. An unknown id
 * changes nothing (the same state is returned).
 */
export function patchDrawing(
  state: WaveformState,
  id: string,
  patch: Partial<Annotation>,
  catalog?: Catalog
): WaveformState {
  if (!state.drawings.some((a) => a.id === id)) return state;
  return apply(
    state,
    (s) => ({
      ...s,
      drawings: s.drawings.map((a) =>
        a.id === id ? (patchFields<Partial<Annotation>>(a, patch) as Annotation) : a
      ),
    }),
    catalog
  );
}

/** Remove the drawing `id`; an unknown id changes nothing (the same state is returned). */
export function removeDrawing(state: WaveformState, id: string, catalog?: Catalog): WaveformState {
  if (!state.drawings.some((a) => a.id === id)) return state;
  return apply(state, (s) => ({ ...s, drawings: s.drawings.filter((a) => a.id !== id) }), catalog);
}
