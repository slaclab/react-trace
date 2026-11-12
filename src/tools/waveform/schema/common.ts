// Waveform field schemas; the layout is listed in ./index.ts.
// The schema's types, item ids, the move rule, and the field helpers the
// sections and items share.

import {
  GROUP_LABELS,
  apply,
  moveRefusal,
  setReferenceStyle,
  setStyle,
  type WaveformGroup,
} from '../edit';
import { clockTime, type WaveformModel } from '../model';
import { type WaveformPlotInput } from '../plotOption';
import {
  MAX_DEC,
  MIN_DEC,
  type WaveformAxisScale,
  type WaveformState,
  type WaveformStyle,
} from '../query';
import { optionalPath, recordKey, type Dot } from '../../dotHelpers';
import { GROUPS, summary } from '../../vocabulary';
import type { FieldDef, FieldOption, Target, ToolContext, ToolUi } from '../../../workbench/types';
import { patchFields } from '../../shared/recordEdit';

// ------------------------------------------------------------------ types --

/** The slice of Waveform's model the schema reads. */
export interface WaveformSchemaModel {
  /** The derived model (axis unit, rows, X axis) the Outline and canvas also read. */
  waveform: WaveformModel;
  /** The chart-option input of `state`: exactly what the chart's `waveformPlotOption` receives. */
  fragmentInput(state: WaveformState): WaveformPlotInput;
}

/**
 * The slice of Waveform's transient UI record the schema reads: the plot's
 * Hide all flag (`tool.ts`'s `WaveformUiRecord`). A record with a `setUi`
 * writer is written through it; otherwise through `waveformSchema`'s option.
 */
export interface WaveformUi extends ToolUi {
  /** Hide all drawings; absent means shown. */
  drawingsHidden?: boolean;
}

/** Writes the UI record (`tool.ts`'s `setUi`). */
export type WaveformUiWriter = (fn: (ui: WaveformUi) => WaveformUi) => void;

/** What `waveformSchema` takes from its owner. */
export interface WaveformSchemaOptions {
  /** The Hide-all eye's writer when the `ui` record carries none. */
  setUi?: WaveformUiWriter;
}

export type S = WaveformState;
export type Ctx<M, U extends ToolUi> = ToolContext<S, M, U>;

// ---------------------------------------------------------------- targets --

/** The groups, in Outline order; a section's id and kind are its group. */
export const WAVEFORM_GROUPS: readonly WaveformGroup[] = ['live', 'reference', 'xsource'];

export { GROUP_LABELS };

/** The snapshot reference's item id (it holds no PV); its kind is `reference`. */
export const SNAPSHOT_ITEM_ID = 'snapshot';
/** The rolling reference's item id (it holds no PV either); its kind is `reference`. */
export const ROLLING_ITEM_ID = 'rolling';

export function isGroup(value: string): value is WaveformGroup {
  return (WAVEFORM_GROUPS as readonly string[]).includes(value);
}

/** An item's id: its group and PV. */
export function waveformItemId(group: WaveformGroup, pv: string): string {
  return `${group}:${pv}`;
}

/**
 * The group and PV of an item id (`pv` null for the snapshot reference);
 * null when it is not one.
 */
export function parseWaveformItemId(
  id: string
): { group: WaveformGroup; pv: string | null } | null {
  if (id === SNAPSHOT_ITEM_ID || id === ROLLING_ITEM_ID) return { group: 'reference', pv: null };
  const colon = id.indexOf(':');
  if (colon <= 0) return null;
  const group = id.slice(0, colon);
  const pv = id.slice(colon + 1);
  return isGroup(group) && pv !== '' ? { group, pv } : null;
}

/**
 * Why the item `itemId` cannot move to the section `sectionId`, or null. The
 * one move rule: the Group select's disabled options and the
 * binding's `moveRefusal` (row drags) both read it. Only a full Live refuses
 * ("Live is full (8/8)"); an occupied Reference or X source swaps. The
 * snapshot is not a PV and moves nowhere, so it is never refused here (the
 * binding does not offer it a drag).
 */
export function waveformMoveRefusal(state: S, itemId: string, sectionId: string): string | null {
  const item = parseWaveformItemId(itemId);
  if (item === null || item.pv === null || !isGroup(sectionId)) return null;
  return moveRefusal(state, item.pv, sectionId);
}

// ---------------------------------------------------------------- helpers --

export function pvOf(target: Target): string | undefined {
  return parseWaveformItemId(target.id)?.pv ?? undefined;
}

/** The snapshot or rolling reference item: no PV, its style on the reference object. */
export function isSnapshotItem(target: Target): boolean {
  return target.id === SNAPSHOT_ITEM_ID || target.id === ROLLING_ITEM_ID;
}

/** The line width a curve draws at when Width is automatic (`plotOption.ts`). */
export const DEFAULT_LINE_WIDTH = 1.5;

/** Every section of a style a field reads: a curve's record, or the snapshot's own. */
export function styleOf(ctx: { state: S; target: Target }): WaveformStyle {
  if (isSnapshotItem(ctx.target)) {
    const ref = ctx.state.reference;
    return ref?.kind === 'snapshot' || ref?.kind === 'rolling' ? (ref.style ?? {}) : {};
  }
  const pv = pvOf(ctx.target);
  return (pv === undefined ? undefined : ctx.state.styles[pv]) ?? {};
}

/** Write a style patch for the target: the snapshot's own record, or the curve's. */
export function writeStyle(state: S, target: Target, patch: WaveformStyle): S {
  if (isSnapshotItem(target)) return setReferenceStyle(state, patch);
  const pv = pvOf(target);
  return pv === undefined ? state : setStyle(state, pv, patch);
}

/** A style field's dot: pinned iff the record holds the field; reset deletes it. */
export function styleOptional<M, U extends ToolUi>(key: keyof WaveformStyle): Dot<S, M, U> {
  return optionalPath<S, M, U>({
    get: (ctx) => styleOf(ctx)[key],
    set: (state, target) => writeStyle(state, target, { [key]: undefined }),
  });
}

export function hiddenRecord<M, U extends ToolUi>(): Dot<S, M, U> {
  return recordKey<S, M, U, S['hidden']>({
    record: (state) => state.hidden,
    key: (ctx) => pvOf(ctx.target),
    write: (state, hidden) => apply(state, (s) => ({ ...s, hidden })),
  });
}

/** `state` with the Live axis scale patched (a key given as undefined is removed). */
export function patchYScale(state: S, patch: WaveformAxisScale): S {
  return apply(state, (s) => ({ ...s, yScale: patchFields(s.yScale, patch) }));
}

/** `state` with the X axis scale patched (a key given as undefined is removed). */
export function patchXScale(state: S, patch: WaveformAxisScale): S {
  return apply(state, (s) => ({ ...s, xScale: patchFields(s.xScale, patch) }));
}

export function xScaleOptional<M, U extends ToolUi>(bound: 'min' | 'max'): Dot<S, M, U> {
  return optionalPath<S, M, U>({
    get: (ctx) => ctx.state.xScale?.[bound],
    set: (state) => patchXScale(state, { [bound]: undefined }),
  });
}

export function scaleOptional<M, U extends ToolUi>(bound: 'min' | 'max'): Dot<S, M, U> {
  return optionalPath<S, M, U>({
    get: (ctx) => ctx.state.yScale?.[bound],
    set: (state) => patchYScale(state, { [bound]: undefined }),
  });
}

export type ToolToggleKey = 'legend' | 'grid' | 'crosshair' | 'tooltip';

export function toggle<M, U extends ToolUi>(
  id: string,
  label: string,
  key: ToolToggleKey,
  tab: string
): FieldDef<S, M, U> {
  return {
    id,
    label,
    kind: 'toggle',
    tab,
    level: 'L2',
    get: (ctx) => ctx.state[key],
    set: (ctx, value) => ctx.update((state) => apply(state, (s) => ({ ...s, [key]: value }))),
  };
}

/**
 * A whole-number setting within [lo, hi]: a value is rounded, and one outside
 * the domain (or empty) writes nothing, as Correlation's Max points.
 */
export function intField<M, U extends ToolUi>(spec: {
  id: string;
  label: string;
  tab: string;
  level: 'L1' | 'L2' | 'L3';
  key: 'persist' | 'avg' | 'hz';
  lo: number;
  hi: number;
  unit?: string;
  help?: string;
}): FieldDef<S, M, U> {
  const { key, lo, hi } = spec;
  return {
    id: spec.id,
    label: spec.label,
    kind: 'number',
    tab: spec.tab,
    level: spec.level,
    min: lo,
    max: hi,
    step: 1,
    ...(spec.unit !== undefined ? { unit: spec.unit } : {}),
    ...(spec.help !== undefined ? { help: spec.help } : {}),
    get: (ctx) => ctx.state[key],
    set: (ctx, value) => {
      if (value === null || !Number.isFinite(value)) return;
      const n = Math.round(value);
      if (n >= lo && n <= hi) ctx.update((state) => apply(state, (s) => ({ ...s, [key]: n })));
    },
  };
}

/** The Decimation a typed value commits to: 0 (off) or a count in [256, 100000]; null refuses. */
export function commitDecimation(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const n = Math.round(value);
  if (n <= 0) return 0;
  return n >= MIN_DEC && n <= MAX_DEC ? n : null;
}

export const PLOT_AGAINST_OPTIONS = (hasSource: boolean): FieldOption[] => [
  { value: 'index', label: 'Element #' },
  hasSource
    ? { value: 'source', label: GROUPS.xPv }
    : { value: 'source', label: GROUPS.xPv, disabled: 'Add an X axis PV first.' },
];

export const DRAW_AS_OPTIONS: FieldOption[] = [
  { value: 'dashed', label: 'Dashed line' },
  { value: 'band', label: 'Shaded band' },
];

/** Reference › Source: what the reference is, read-only. */
export function referenceSourceText(state: S, model?: WaveformModel): string {
  const ref = state.reference;
  if (ref === null) return 'None — add a PV, take a snapshot or turn on Rolling mean';
  if (ref.kind === 'pv') return `PV ${ref.pv}`;
  if (ref.kind === 'rolling') {
    const row = model?.reference;
    const tail =
      row?.kind === 'rolling' && row.chip !== null
        ? ` — ${row.chip}`
        : ' — Snapshot → reference freezes it';
    return `Rolling mean of the last ${ref.seconds} s${tail}`;
  }
  const n = Object.keys(ref.frames).length;
  const from = ref.rolling === undefined ? '' : ` of rolling ${ref.rolling} s`;
  return `Snapshot ${clockTime(ref.time)} of ${n} ${n === 1 ? 'curve' : 'curves'}${from} — this session only`;
}

export const SPREAD_OPTIONS: FieldOption[] = [
  { value: '0', label: 'None' },
  { value: '1', label: '±1σ' },
  { value: '2', label: '±2σ' },
  { value: '3', label: '±3σ' },
];

// --------------------------------------------------------------- summaries --

/** An axis scale as a summary word: `auto`, or its fixed range (`0–10`; an open side `auto`). */
function scaleText(scale: WaveformAxisScale | undefined): string {
  if (scale?.auto !== false) return 'auto';
  return `${scale.min ?? 'auto'}–${scale.max ?? 'auto'}`;
}

/** The Axes summary: `Y auto · X index`, `Y 0–10 log · X pv 2–40`. */
export function axesSummary(state: S): string {
  const against = state.xs === '' || state.xAxis === 'index' ? 'index' : 'pv';
  const xScale = scaleText(state.xScale);
  return summary(
    `Y ${scaleText(state.yScale)}${state.yScale?.log === true ? ' log' : ''}`,
    `X ${against}${xScale === 'auto' ? '' : ` ${xScale}`}`
  );
}

/** The Statistics summary: `off`, or `on · 5 metrics`. */
export function statisticsSummary(state: S): string {
  if (!state.stats) return 'off';
  const n = state.metrics.length;
  return summary('on', `${n} ${n === 1 ? 'metric' : 'metrics'}`);
}
