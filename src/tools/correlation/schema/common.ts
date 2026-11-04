// Correlation field schemas; the layout is listed in ./index.ts.
//
// The schema's types, its targets and the one move rule, and the field
// helpers the Plot tabs, the sections and the items share.

import { DRAWINGS_SECTION_KIND } from '../../../annotations/host/workbench';
import type { CorrelationFragmentInput } from '../codeFragments';
import { apply, moveRefusal, setMarker } from '../edit';
import {
  CORRELATION_AXES,
  MARKER_SHAPES,
  type CorrelationAxisScale,
  type CorrelationMarker,
  type CorrelationState,
} from '../query';
import { optionalPath, recordKey, type Dot } from '../../dotHelpers';
import type {
  FieldDef,
  FieldLevel,
  FieldOption,
  Target,
  ToolContext,
  ToolUi,
} from '../../../workbench/types';
import { patchFields } from '../../shared/recordEdit';
import type { PvRole } from '../../shared/pvTracker';
import { DRAWING_STAYS_REASON, isListedDrawing } from '../../shared/drawingOutline';
import { ANNOTATIONS_ONLY_REASON } from './drawings';

// ------------------------------------------------------------------ types --

/** The slice of Correlation's model the schema reads. */
export interface CorrelationSchemaModel {
  /** The chart-option input of `state`: exactly what the chart's `plotOption` receives. */
  fragmentInput(state: CorrelationState): CorrelationFragmentInput;
  /** A PV's engineering units; '' while unknown. */
  unitsOf(pv: string): string;
}

/** Correlation's transient UI record (held in App.tsx). */
export interface CorrelationUi {
  /** The user chose Trigger › PV and has not added the PV yet. */
  pendingTrigger?: boolean;
  /** Raise or clear `pendingTrigger`; the binding owns its lifecycle. */
  setPendingTrigger?(pending: boolean): void;
  /** Hide all drawings; absent means shown. */
  drawingsHidden?: boolean;
  /** Write the record through `fn` (the Drawings eye writes `drawingsHidden`). */
  setUi?(fn: (ui: CorrelationUi) => CorrelationUi): void;
}

export type S = CorrelationState;

// ---------------------------------------------------------------- targets --

/** The role sections, in panel order; a section's id and kind are its role. */
export const CORRELATION_ROLES: readonly PvRole[] = ['y', 'x', 'trig'];

/** A role section's title. */
export const ROLE_LABELS: Record<PvRole, string> = { x: 'X', y: 'Y', trig: 'Trigger' };

export function isRole(value: string): value is PvRole {
  return (CORRELATION_ROLES as readonly string[]).includes(value);
}

/** An item's id: its role and PV (a PV may hold X and Y at once). */
export function correlationItemId(role: PvRole, pv: string): string {
  return `${role}:${pv}`;
}

/** The role and PV of an item id; null when it is not one. */
export function parseCorrelationItemId(id: string): { role: PvRole; pv: string } | null {
  const colon = id.indexOf(':');
  if (colon <= 0) return null;
  const role = id.slice(0, colon);
  const pv = id.slice(colon + 1);
  return isRole(role) && pv !== '' ? { role, pv } : null;
}

/**
 * Why the item `itemId` cannot move to the section `sectionId`, or null. The
 * one move rule: the Plot on select's disabled options and the binding's
 * `moveRefusal` (card drags) both read it. A drawing never moves and no PV
 * moves into Drawings; otherwise only a full Y refuses; the single-slot
 * roles swap.
 */
export function correlationMoveRefusal(state: S, itemId: string, sectionId: string): string | null {
  // Drawings first: a drawing never moves, whichever section it is dropped on.
  if (isListedDrawing(state, itemId)) return DRAWING_STAYS_REASON;
  if (sectionId === DRAWINGS_SECTION_KIND) return ANNOTATIONS_ONLY_REASON;
  const item = parseCorrelationItemId(itemId);
  if (item === null || !isRole(sectionId)) return null;
  return moveRefusal(state, item.role, item.pv, sectionId) ?? null;
}

// ---------------------------------------------------------------- helpers --

export type Ctx<M, U extends ToolUi> = ToolContext<S, M, U>;

export type AxisRole = 'x' | 'y';

export function itemOf(target: Target): { role: PvRole; pv: string } | null {
  return parseCorrelationItemId(target.id);
}

export function pvOf(target: Target): string | undefined {
  return itemOf(target)?.pv;
}

export function roleOf(target: Target): PvRole | undefined {
  return itemOf(target)?.role;
}

export function scaleKey(role: AxisRole): 'xScale' | 'yScale' {
  return role === 'x' ? 'xScale' : 'yScale';
}

/** `state` with one axis scale patched (a key given as undefined is removed). */
export function patchScale(state: S, role: AxisRole, patch: CorrelationAxisScale): S {
  const key = scaleKey(role);
  return apply(state, (s) => ({ ...s, [key]: patchFields(s[key], patch) }));
}

export function scaleOptional<M, U extends ToolUi>(
  role: AxisRole,
  bound: 'min' | 'max'
): Dot<S, M, U> {
  return optionalPath<S, M, U>({
    get: (ctx) => ctx.state[scaleKey(role)]?.[bound],
    set: (state) => patchScale(state, role, { [bound]: undefined }),
  });
}

export function markerOptional<M, U extends ToolUi>(key: keyof CorrelationMarker): Dot<S, M, U> {
  return optionalPath<S, M, U>({
    get: (ctx) => {
      const pv = pvOf(ctx.target);
      return pv === undefined ? undefined : ctx.state.markers[pv]?.[key];
    },
    set: (state, target) => {
      const pv = pvOf(target);
      return pv === undefined ? state : setMarker(state, pv, { [key]: undefined });
    },
  });
}

export function pvRecord<M, U extends ToolUi, K extends 'labels' | 'colors' | 'hidden'>(
  key: K
): Dot<S, M, U> {
  return recordKey<S, M, U, S[K]>({
    record: (state) => state[key],
    key: (ctx) => pvOf(ctx.target),
    write: (state, record) => apply(state, (s) => ({ ...s, [key]: record })),
  });
}

export function toggle<M, U extends ToolUi>(
  id: string,
  label: string,
  key: 'fit' | 'legend' | 'grid' | 'crosshair' | 'fade' | 'tooltip',
  tab: string,
  level: FieldLevel
): FieldDef<S, M, U> {
  return {
    id,
    label,
    kind: 'toggle',
    tab,
    level,
    get: (ctx) => ctx.state[key],
    set: (ctx, value) => ctx.update((state) => apply(state, (s) => ({ ...s, [key]: value }))),
  };
}

export const VIEW_OPTIONS: FieldOption[] = [
  { value: 'scatter', label: 'Scatter' },
  { value: 'density', label: 'Density' },
];

export const AXES_LABELS: Record<(typeof CORRELATION_AXES)[number], string> = {
  shared: 'Shared',
  overlay: 'Overlay',
  split: 'Split',
};

export const SHAPE_LABELS: Record<(typeof MARKER_SHAPES)[number], string> = {
  circle: 'Circle',
  rect: 'Square',
  roundRect: 'Rounded square',
  triangle: 'Triangle',
  diamond: 'Diamond',
  pin: 'Pin',
  arrow: 'Arrow',
};

/** The trigger Source as both controls show it. */
export function triggerSource(state: S, ui: CorrelationUi): 'pv' | 'timer' {
  return state.trigger.mode === 'pv' || ui.pendingTrigger === true ? 'pv' : 'timer';
}

/** The unit an axis shows: the X's units, or the first Y's that has one. */
export function axisUnit(model: CorrelationSchemaModel, state: S, role: AxisRole): string {
  if (role === 'x') return state.x === '' ? '' : model.unitsOf(state.x);
  for (const y of state.ys) {
    const units = model.unitsOf(y);
    if (units !== '') return units;
  }
  return '';
}

/** One axis in the Axes summary: `Y auto`, or its fixed range `Y 0–10`. */
export function scaleSummary(name: string, scale: CorrelationAxisScale | undefined): string {
  if (scale?.auto !== false) return `${name} auto`;
  const bound = (v: number | undefined) => (v === undefined ? 'auto' : String(v));
  return `${name} ${bound(scale.min)}–${bound(scale.max)}`;
}
