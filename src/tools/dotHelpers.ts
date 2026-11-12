// The tool-side builders for a field's modified dot and its reset.
//
// A dot-bearing field spreads one of these into its schema entry, so no tool
// hand-writes the dot rule and the workbench never sees a default: it only
// calls `modified(ctx)` and `reset(ctx)`. Three shapes cover every dot:
//
// - `optionalPath`: the field is an optional value. Pinned iff a value is
//   present; reset writes `undefined`.
// - `recordKey`: the field lives in a per-PV record. Pinned iff the record has
//   an entry for this key; reset deletes the entry.
// - `stampedValue`: the tool stamps an automatic value (a palette colour, an
//   axis slot) into the object. Pinned iff the stored value is not one the
//   tool's automatic rule produces for this object; reset writes the automatic
//   value for the object's slot. The tool supplies both the predicate and the
//   slot value, so a value equal to a *different* slot's automatic value is
//   judged by the tool's rule, not by a global list here.
//
// A field with no automatic rule (axis Side) uses no helper and has no dot.
//
// Readers take the whole ctx and read `ctx.target`, never `ctx.selection`;
// writers are pure state transforms handed to `ctx.update`, given the target
// captured when reset was invoked.

import type { Target, ToolContext, ToolUi } from '../workbench/types';

/** The dot half of `DotProps`: both functions, ready to spread into a field. */
export interface Dot<State, Model, Ui extends ToolUi = ToolUi> {
  modified(ctx: ToolContext<State, Model, Ui>): boolean;
  reset(ctx: ToolContext<State, Model, Ui>): void;
}

/** Pinned iff `get` yields a value; reset writes `undefined` through `set`. */
export function optionalPath<State, Model, Ui extends ToolUi = ToolUi>(spec: {
  get(ctx: ToolContext<State, Model, Ui>): unknown;
  set(state: State, target: Target, value: undefined): State;
}): Dot<State, Model, Ui> {
  return {
    modified: (ctx) => spec.get(ctx) !== undefined,
    reset: (ctx) => {
      const target = ctx.target;
      ctx.update((state) => spec.set(state, target, undefined));
    },
  };
}

type PvRecord = Readonly<Record<string, unknown>>;

/**
 * Pinned iff the per-PV record holds an entry for `key(ctx)`; reset hands
 * `write` a copy of the record without that entry. A missing record or an
 * undefined key is never pinned, and its reset changes nothing.
 */
export function recordKey<
  State,
  Model,
  Ui extends ToolUi = ToolUi,
  R extends PvRecord = PvRecord,
>(spec: {
  record(state: State): R | undefined;
  key(ctx: ToolContext<State, Model, Ui>): string | undefined;
  write(state: State, record: R): State;
}): Dot<State, Model, Ui> {
  return {
    modified: (ctx) => {
      const key = spec.key(ctx);
      const record = spec.record(ctx.state);
      return key !== undefined && record !== undefined && Object.hasOwn(record, key);
    },
    reset: (ctx) => {
      const key = spec.key(ctx);
      if (key === undefined) return;
      ctx.update((state) => {
        const record = spec.record(state);
        if (record === undefined || !Object.hasOwn(record, key)) return state;
        const rest: Record<string, unknown> = { ...record };
        delete rest[key];
        return spec.write(state, rest as R);
      });
    },
  };
}

/**
 * Pinned iff `isAutomatic` rejects the stored value; reset writes
 * `automatic(ctx)` (the object's own slot value) through `set`.
 */
export function stampedValue<State, Model, Value, Ui extends ToolUi = ToolUi>(spec: {
  get(ctx: ToolContext<State, Model, Ui>): Value;
  isAutomatic(value: Value, ctx: ToolContext<State, Model, Ui>): boolean;
  automatic(ctx: ToolContext<State, Model, Ui>): Value;
  set(state: State, target: Target, value: Value): State;
}): Dot<State, Model, Ui> {
  return {
    modified: (ctx) => !spec.isAutomatic(spec.get(ctx), ctx),
    reset: (ctx) => {
      const target = ctx.target;
      const value = spec.automatic(ctx);
      ctx.update((state) => spec.set(state, target, value));
    },
  };
}
