// The correlation state's one writer. Every change to a
// `CorrelationState` — an Outline add, remove or role move, a Properties field,
// App.tsx's `update(fn)` — goes through a function here, and every one ends in
// `normalizeCorrelationState`, so no caller ever holds a non-canonical
// state. All functions are pure: they take the latest state and return the next.
//
// Role moves never lose a PV: moving into an occupied single-slot role
// (X, Trigger) swaps the two PVs, moving into Trigger in Timer mode replaces the
// timer, and the only refusal is a full Y. Per-PV records are keyed by PV, so a
// move carries the label (Y legend name <-> X title) and the normalizer drops
// colour, visibility and markers once the PV is no longer a Y.
//
// `addPv` checks capacity, duplicates and unit inside the commit, against the
// state it is handed — the caller passes the latest state, after its async
// probe — and returns the refusal rather than letting the normalizer truncate
// the Ys.
//
// The statistics metrics (metrics.ts) have their own writers: set the
// whole list, patch one metric by id, add a custom (refused at `MAX_METRICS`,
// its id `nextCustomId`, so a live id is never reused), remove, move one place
// up or down (clamped at the ends), and reset to the default list. A patch of a
// preset's label, expression or unit is undone by the normalizer, which
// re-stamps presets; only `on` and `strip` stick.
//
// The drawings have add, patch and remove. They go through `apply` like
// every other edit, and the normalizer is reference-preserving: a drawing
// commit leaves every other field's reference alone, and a settings edit
// leaves `drawings` alone, so the history ring sees only drawing edits.

import { CORRELATION_CATALOG } from '../../annotations/catalog';
import type { Catalog } from '../../annotations/catalog/types';
import { VALUE_X_AXIS } from '../../annotations/catalog/xAxis';
import { validateAnnotationIn, type Annotation } from '../../annotations/model';
import {
  DEFAULT_DT_S,
  keepCorrelationReferences,
  MAX_Y,
  normalizeCorrelationState,
  type CorrelationFire,
  type CorrelationMarker,
  type CorrelationState,
} from './query';
import { CORRELATION_METRICS } from './metrics';
import {
  MAX_METRICS,
  defaultMetrics,
  isCustomId,
  metricsFullMessage,
  nextCustomId,
  type Metric,
} from '../../statistics/model';
import { patchFields, withRecord } from '../shared/recordEdit';
import { unitMessage, type PvRole } from '../shared/pvTracker';

export { metricsFullMessage };

/** The next state and, when the edit was refused, why (the state is then unchanged). */
export interface EditResult {
  state: CorrelationState;
  refusal?: string;
}

/**
 * The one commit: apply `fn` and normalize, the drawings validated against
 * `catalog` (default `CORRELATION_CATALOG`). Every field equal to `state`'s
 * keeps `state`'s reference. Every writer below ends here.
 */
export function apply(
  state: CorrelationState,
  fn: (s: CorrelationState) => CorrelationState,
  catalog?: Catalog
): CorrelationState {
  return keepCorrelationReferences(state, normalizeCorrelationState(fn(state), catalog));
}

const TIMER = { mode: 'timer', dtS: DEFAULT_DT_S } as const;

/** The refusal shown when Y has no room. */
export function yFullMessage(): string {
  return `Y is full (${MAX_Y}/${MAX_Y})`;
}

function triggerPv(state: CorrelationState): string {
  return state.trigger.mode === 'pv' ? state.trigger.pv : '';
}

/** Whether `pv` holds `role` in `state`. */
export function hasRole(state: CorrelationState, role: PvRole, pv: string): boolean {
  if (pv === '') return false;
  if (role === 'x') return state.x === pv;
  if (role === 'trig') return triggerPv(state) === pv;
  return state.ys.includes(pv);
}

/** Unit check for an added Y: the PV's units and the frozen Y axis unit (null while unset). */
export interface AddUnits {
  units?: string;
  axisUnit?: string | null;
}

/**
 * Add `pv` to `role`, checked against `state` (pass the latest one). Refuses a
 * full role ("Y is full (8/8)", "X is full (1/1)", "Trigger is full (1/1)"), a
 * duplicate Y, and a Y whose units differ from the axis unit while a Y holds
 * it. A Y equal to the X is allowed. An empty name adds nothing.
 */
export function addPv(
  state: CorrelationState,
  role: PvRole,
  raw: string,
  units: AddUnits = {}
): EditResult {
  const pv = raw.trim();
  if (pv === '') return { state };
  if (role === 'x') {
    if (state.x === pv) return { state, refusal: `${pv} is already the X` };
    if (state.x !== '') return { state, refusal: 'X is full (1/1)' };
    return { state: apply(state, (s) => ({ ...s, x: pv })) };
  }
  if (role === 'trig') {
    const current = triggerPv(state);
    if (current === pv) return { state, refusal: `${pv} is already the Trigger` };
    if (current !== '') return { state, refusal: 'Trigger is full (1/1)' };
    return { state: apply(state, (s) => ({ ...s, trigger: { mode: 'pv', pv } })) };
  }
  if (state.ys.includes(pv)) return { state, refusal: `${pv} is already a Y` };
  if (state.ys.length >= MAX_Y) return { state, refusal: yFullMessage() };
  const { units: own = '', axisUnit = null } = units;
  if (
    state.ys.length > 0 &&
    own !== '' &&
    axisUnit !== null &&
    axisUnit !== '' &&
    own !== axisUnit
  ) {
    return { state, refusal: unitMessage(pv, own, axisUnit) };
  }
  return { state: apply(state, (s) => ({ ...s, ys: [...s.ys, pv] })) };
}

/** Remove `pv` from `role`; removing the trigger PV returns to Timer 1 s. */
export function removePv(state: CorrelationState, role: PvRole, pv: string): CorrelationState {
  if (!hasRole(state, role, pv)) return state;
  return apply(state, (s) => {
    if (role === 'x') return { ...s, x: '' };
    if (role === 'trig') return { ...s, trigger: TIMER };
    return { ...s, ys: s.ys.filter((y) => y !== pv) };
  });
}

/**
 * Why `pv` cannot move from `from` to `to`, or undefined when it can. Shared by
 * the Outline's row drag and the Role select. Only a full Y refuses;
 * the single-slot roles swap.
 */
export function moveRefusal(
  state: CorrelationState,
  from: PvRole,
  pv: string,
  to: PvRole
): string | undefined {
  if (from === to || !hasRole(state, from, pv)) return undefined;
  if (to === 'y' && !state.ys.includes(pv) && state.ys.length >= MAX_Y) return yFullMessage();
  return undefined;
}

/**
 * Move `pv` from `from` to `to` without losing any PV: an occupied X or
 * Trigger swaps with the PV's old slot (a Y's position is kept), a Timer is
 * replaced, and a full Y refuses with the state unchanged.
 */
export function movePv(state: CorrelationState, from: PvRole, pv: string, to: PvRole): EditResult {
  if (from === to || !hasRole(state, from, pv)) return { state };
  const refusal = moveRefusal(state, from, pv, to);
  if (refusal !== undefined) return { state, refusal };

  // What the target slot held before (single-slot roles only).
  const displaced = to === 'x' ? state.x : to === 'trig' ? triggerPv(state) : '';

  return {
    state: apply(state, (s) => {
      let { x, ys, trigger } = s;
      // Take the PV out of its slot; a displaced PV fills that slot.
      if (from === 'x') x = '';
      else if (from === 'trig') trigger = TIMER;
      else ys = ys.flatMap((y) => (y === pv ? (displaced !== '' ? [displaced] : []) : [y]));
      if (displaced !== '' && from === 'x') x = displaced;
      if (displaced !== '' && from === 'trig') trigger = { mode: 'pv', pv: displaced };
      // Put it in the target.
      if (to === 'x') x = pv;
      else if (to === 'trig') trigger = { mode: 'pv', pv };
      else if (!ys.includes(pv)) ys = [...ys, pv];
      return { ...s, x, ys, trigger };
    }),
  };
}

/** Timer mode; an interval already set is kept, a trigger PV is dropped for Timer 1 s. */
export function setTimer(state: CorrelationState): CorrelationState {
  if (state.trigger.mode === 'timer') return apply(state, (s) => s);
  return apply(state, (s) => ({ ...s, trigger: TIMER }));
}

/** Fire on; undefined = Every update. Kept by the normalizer in PV mode only. */
export function setFire(
  state: CorrelationState,
  fire: CorrelationFire | undefined
): CorrelationState {
  return apply(state, (s) => {
    const next = { ...s };
    if (fire === undefined) delete next.fire;
    else next.fire = fire;
    return next;
  });
}

/** Pin (or with undefined, reset) a label: a Y's legend name, the X's axis title. */
export function setLabel(
  state: CorrelationState,
  pv: string,
  label: string | undefined
): CorrelationState {
  return apply(state, (s) => ({ ...s, labels: withRecord(s.labels, pv, label) }));
}

/** Pin (or with undefined, reset) a Y's colour. */
export function setColor(
  state: CorrelationState,
  pv: string,
  color: string | undefined
): CorrelationState {
  return apply(state, (s) => ({ ...s, colors: withRecord(s.colors, pv, color) }));
}

/** Hide or show a Y (the Outline eye). */
export function setHidden(state: CorrelationState, pv: string, hidden: boolean): CorrelationState {
  return apply(state, (s) => ({
    ...s,
    hidden: withRecord<true>(s.hidden, pv, hidden ? true : undefined),
  }));
}

/**
 * Merge marker fields into a Y's record; a field given as undefined is reset,
 * and `undefined` for the whole patch resets the marker.
 */
export function setMarker(
  state: CorrelationState,
  pv: string,
  patch: CorrelationMarker | undefined
): CorrelationState {
  return apply(state, (s) => {
    if (patch === undefined) return { ...s, markers: withRecord(s.markers, pv, undefined) };
    return { ...s, markers: withRecord(s.markers, pv, patchFields(s.markers[pv], patch)) };
  });
}

/** The fields of a metric a patch may change. */
export type MetricPatch = Partial<Pick<Metric, 'label' | 'expr' | 'unit' | 'on' | 'strip'>>;

/** Replace the whole metric list (normalized: deduplicated, capped, presets re-stamped). */
export function setMetrics(state: CorrelationState, metrics: readonly Metric[]): CorrelationState {
  return apply(state, (s) => ({ ...s, metrics: [...metrics] }));
}

/** Merge `patch` into the metric `id`; an unknown id changes nothing. */
export function patchMetric(
  state: CorrelationState,
  id: string,
  patch: MetricPatch
): CorrelationState {
  if (!state.metrics.some((m) => m.id === id)) return state;
  return apply(state, (s) => ({
    ...s,
    metrics: s.metrics.map((m) => (m.id === id ? { ...m, ...patch } : m)),
  }));
}

/**
 * Append a custom metric, on and without a strip, labelled "Metric <k>" (k the
 * number of customs after it) unless `init` names it. Refuses a full list.
 */
export function addMetric(
  state: CorrelationState,
  init: Partial<Pick<Metric, 'label' | 'expr' | 'unit'>> = {}
): EditResult & { id?: string } {
  if (state.metrics.length >= MAX_METRICS) return { state, refusal: metricsFullMessage() };
  const id = nextCustomId(state.metrics);
  const customs = state.metrics.filter((m) => isCustomId(m.id)).length;
  const metric: Metric = {
    id,
    label: init.label ?? `Metric ${customs + 1}`,
    expr: init.expr ?? '',
    unit: init.unit ?? '',
    on: true,
    strip: false,
  };
  return { state: apply(state, (s) => ({ ...s, metrics: [...s.metrics, metric] })), id };
}

/** Remove the metric `id` (a preset too: re-add it only through a reset or `setMetrics`). */
export function removeMetric(state: CorrelationState, id: string): CorrelationState {
  if (!state.metrics.some((m) => m.id === id)) return state;
  return apply(state, (s) => ({ ...s, metrics: s.metrics.filter((m) => m.id !== id) }));
}

/** Move the metric `id` one column left (-1) or right (1); a no-op at the ends. */
export function moveMetric(
  state: CorrelationState,
  id: string,
  direction: -1 | 1
): CorrelationState {
  const from = state.metrics.findIndex((m) => m.id === id);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= state.metrics.length) return state;
  return apply(state, (s) => {
    const metrics = [...s.metrics];
    [metrics[from], metrics[to]] = [metrics[to], metrics[from]];
    return { ...s, metrics };
  });
}

/** Back to the default metric list (every preset, the first five on, no strips). */
export function resetMetrics(state: CorrelationState): CorrelationState {
  return apply(state, (s) => ({ ...s, metrics: defaultMetrics(CORRELATION_METRICS) }));
}

/** The fields of a drawing a patch may change (its id stays). */
export type DrawingPatch = Partial<Omit<Annotation, 'id'>>;

/**
 * Append `drawing`, validated against `catalog`; one the catalog rejects is
 * not added and `state` itself is returned.
 */
export function addDrawing(
  state: CorrelationState,
  drawing: Annotation,
  catalog?: Catalog
): CorrelationState {
  if (
    validateAnnotationIn(catalog ?? CORRELATION_CATALOG, drawing, VALUE_X_AXIS, 'Correlation') ===
    null
  ) {
    return state;
  }
  return apply(state, (s) => ({ ...s, drawings: [...s.drawings, drawing] }), catalog);
}

/**
 * Merge `patch` into the drawing `id`; a key given as undefined is removed. An
 * unknown id, or a patch that changes nothing, returns `state` itself.
 */
export function patchDrawing(
  state: CorrelationState,
  id: string,
  patch: DrawingPatch,
  catalog?: Catalog
): CorrelationState {
  const current = state.drawings.find((a) => a.id === id);
  if (current === undefined) return state;
  const own = current as unknown as Record<string, unknown>;
  const unchanged = (Object.keys(patch) as (keyof DrawingPatch)[]).every((key) =>
    patch[key] === undefined
      ? !Object.prototype.hasOwnProperty.call(own, key)
      : JSON.stringify(patch[key]) === JSON.stringify(own[key])
  );
  if (unchanged) return state;
  return apply(
    state,
    (s) => ({
      ...s,
      drawings: s.drawings.map((a) =>
        a.id === id ? ({ ...patchFields<Partial<Annotation>>(a, patch), id } as Annotation) : a
      ),
    }),
    catalog
  );
}

/** Remove the drawing `id`; an unknown id changes nothing. */
export function removeDrawing(
  state: CorrelationState,
  id: string,
  catalog?: Catalog
): CorrelationState {
  if (!state.drawings.some((a) => a.id === id)) return state;
  return apply(state, (s) => ({ ...s, drawings: s.drawings.filter((a) => a.id !== id) }), catalog);
}
