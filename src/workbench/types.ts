// The ToolDefinition contract: everything a tool hands the
// workbench, and nothing the workbench may assume beyond it.
//
// Two halves:
// - Schema half (`ToolSchema`): static, built once at module level per tool.
//   It names the tool-, section- and item-level objects, their field groups
//   (`tabs`) and fields (kind, group, level L1/L2/L3, `when`, `get`/`set`, an
//   optional row slot, and `modified`/`reset` on dot-bearing fields only),
//   the custom and action kinds, the `group: 'status'` read-only fields
//   and option-level disabled reasons.
// - Binding half (`ToolBinding`): rebuilt per render. The outline view-model
//   (sections with count/capacity/muted, rows with kind/status/refusal, the
//   per-section add row and its PV search), the structural ops (`add` is async
//   and returns a refusal or nothing; `remove`, `move`), `moveRefusal`, and
//   footer actions.
//
// How the properties panel shows the schema (one page, nothing in tabs):
// - Sections are the top block's lists. A section kind's `group` names the
//   heading it sits under (Signals, Reference, Trigger, Drawings…); sections
//   sharing a group share one heading. Its rows are cards that open in place
//   and show the item's `tabs` as titled blocks.
// - A section kind's own fields show under its cards (`placement: 'group'`,
//   the default) or inside the plot-wide Axes section (`placement: 'axes'`).
// - The tool-level `tabs` are the plot-wide collapsible sections (Acquisition,
//   Axes, Display, Statistics), each with an optional one-line `summary`; the
//   tool-level tab `code` is the one "Show chart source" link at the bottom.
//
// Rate rule: the workbench reads the binding through a
// latest-ref, keys its effects on ids, and compares the outline view-model
// structurally (rows by id + kind + status + label) before re-rendering; row
// slots re-render through their own field getters.
//
// `ctx` (`ToolContext`): field functions read `target` (the object the field
// renders for), never `selection`. `capabilities` is one record computed per
// tool (no `isEmbedded()` in a schema). `ui` is tool-owned transient UI
// state (Correlation's `pendingTrigger`).
//
// Types only, apart from the kind and level lists the renderers switch on.

import type { ComponentType, ReactNode } from 'react';
import type { PvSearch } from '../pvSearch';

// ---------------------------------------------------------------- context --

/** The three levels of object a tool exposes; `tool` is the plot itself. */
export type TargetLevel = 'tool' | 'section' | 'item';

/** The object a field renders for: a section or item kind plus its id. */
export interface Target {
  level: TargetLevel;
  /** The schema kind (`sections[kind]`, `items[kind]`; the tool id at tool level). */
  kind: string;
  id: string;
}

/**
 * What the user has selected in the workbench; `null` is the tool level
 * (nothing selected). Fields never read it: they read `ctx.target`.
 */
export type Selection = Target | null;

/**
 * One capability record per tool. A control whose service the deployment
 * cannot provide is hidden (today only `elog`); `formulas` and any further key
 * are the tool's own, computed once, never `isEmbedded()` in a schema.
 */
export interface Capabilities {
  elog: boolean;
  formulas?: boolean;
  readonly [capability: string]: boolean | undefined;
}

/** Tool-owned transient UI state; the workbench passes it through untouched. */
export type ToolUi = object;

/** The context every field function and `when`/`disabled`/`options` receives. */
export interface ToolContext<State, Model, Ui extends ToolUi = ToolUi> {
  state: State;
  model: Model;
  /** The tool's single writer: a pure state transform. */
  update(fn: (state: State) => State): void;
  selection: Selection;
  /** Set per row and section header by the Outline, from the selection by the properties panel. */
  target: Target;
  capabilities: Capabilities;
  ui: Ui;
}

// ----------------------------------------------------------------- fields --

/** Every field kind the properties panel renders (including `custom` and `action`). */
export const FIELD_KINDS = [
  'text',
  'number',
  'select',
  'toggle',
  'segmented',
  'colour',
  'pv',
  'readonly',
  'code',
  'custom',
  'action',
] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];

/** L1 always shown, L2 below it, L3 inside the More disclosure. */
export const FIELD_LEVELS = ['L1', 'L2', 'L3'] as const;
export type FieldLevel = (typeof FIELD_LEVELS)[number];

/** A select or segmented option; `disabled` is the reason it cannot be picked. */
export interface FieldOption {
  value: string;
  label: string;
  disabled?: string;
}

/**
 * The modified dot and its reset. Both or neither: they come from the
 * tool's dot helpers, so the workbench never sees a default.
 */
export type DotProps<State, Model, Ui extends ToolUi> =
  | {
      modified(ctx: ToolContext<State, Model, Ui>): boolean;
      reset(ctx: ToolContext<State, Model, Ui>): void;
    }
  | { modified?: never; reset?: never };

/** What every field carries, whatever its kind. */
export interface FieldBase<State, Model, Ui extends ToolUi> {
  /** Stable id; the Properties rendering carries it as `#id`. */
  id: string;
  label: string;
  /** The id of the field group (a `TabDef.id` of the same object) it lives in. */
  tab: string;
  level: FieldLevel;
  /** Shown only when true; absent = always. */
  when?(ctx: ToolContext<State, Model, Ui>): boolean;
  /** `false`, or the reason the field is temporarily unusable. */
  disabled?(ctx: ToolContext<State, Model, Ui>): false | string;
  /** `'status'`: read-only, rendered outside the L1 budget. */
  group?: 'status';
  /** A sub-heading inside its group (`Y axis`, `X axis`); shown where it changes. */
  subgroup?: string;
  help?: string;
}

/** A field that holds a value of type `V`, read and written through `ctx`. */
type ValueField<State, Model, Ui extends ToolUi, K extends FieldKind, V> = FieldBase<
  State,
  Model,
  Ui
> & {
  kind: K;
  get(ctx: ToolContext<State, Model, Ui>): V;
  set(ctx: ToolContext<State, Model, Ui>, value: V): void;
} & DotProps<State, Model, Ui>;

/** A field that only displays a value. No setter, so no dot. */
type ReadField<State, Model, Ui extends ToolUi, K extends FieldKind> = FieldBase<
  State,
  Model,
  Ui
> & {
  kind: K;
  get(ctx: ToolContext<State, Model, Ui>): string;
  set?: never;
  modified?: never;
  reset?: never;
};

export type TextField<S, M, U extends ToolUi = ToolUi> = ValueField<S, M, U, 'text', string> & {
  placeholder?: string;
  row?: never;
};

/** `null` is an empty input (the tool decides whether that means automatic). */
export type NumberField<S, M, U extends ToolUi = ToolUi> = ValueField<
  S,
  M,
  U,
  'number',
  number | null
> & {
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  row?: never;
};

export type SelectField<S, M, U extends ToolUi = ToolUi> = ValueField<S, M, U, 'select', string> & {
  options(ctx: ToolContext<S, M, U>): FieldOption[];
  row?: never;
};

export type SegmentedField<S, M, U extends ToolUi = ToolUi> = ValueField<
  S,
  M,
  U,
  'segmented',
  string
> & {
  options(ctx: ToolContext<S, M, U>): FieldOption[];
  row?: never;
};

/**
 * `row: 'eye'` renders it as the row's (or section header's) visibility eye;
 * `row: 'lock'` renders it as the row's lock glyph, after the eye (rows only).
 */
export type ToggleField<S, M, U extends ToolUi = ToolUi> = ValueField<
  S,
  M,
  U,
  'toggle',
  boolean
> & {
  row?: 'eye' | 'lock';
};

/** `row: 'swatch'` renders it as the row's colour swatch. */
export type ColourField<S, M, U extends ToolUi = ToolUi> = ValueField<S, M, U, 'colour', string> & {
  row?: 'swatch';
};

/** A PV name on the shared PV field; `search` overrides the default Mole search. */
export type PvField<S, M, U extends ToolUi = ToolUi> = ValueField<S, M, U, 'pv', string> & {
  search?: PvSearch;
  row?: never;
};

export type ReadonlyField<S, M, U extends ToolUi = ToolUi> = ReadField<S, M, U, 'readonly'> & {
  row?: never;
};

/** Source text shown with a Copy button (the Code tab). */
export type CodeField<S, M, U extends ToolUi = ToolUi> = ReadField<S, M, U, 'code'> & {
  row?: never;
};

/** What a custom renderer receives inside the workbench's label/level/dot/reset chrome. */
export interface CustomFieldRenderProps<S, M, U extends ToolUi, V> {
  ctx: ToolContext<S, M, U>;
  value: V;
  onChange(value: V): void;
  /** The control's `#id`, on the Properties rendering only. */
  id?: string;
}

/** A tool-supplied renderer (Trace's formula editor, archiver picker, time range…). */
export type CustomField<S, M, U extends ToolUi = ToolUi, V = unknown> = ValueField<
  S,
  M,
  U,
  'custom',
  V
> & {
  render(props: CustomFieldRenderProps<S, M, U, V>): ReactNode;
  row?: never;
};

/** A button in the properties panel (Inspect data, Create formula, Remove axis): no value, no dot. */
export type ActionField<S, M, U extends ToolUi = ToolUi> = FieldBase<S, M, U> & {
  kind: 'action';
  run(ctx: ToolContext<S, M, U>): void;
  get?: never;
  set?: never;
  modified?: never;
  reset?: never;
  row?: never;
};

/** One properties-panel field; the union is discriminated on `kind`. */
export type FieldDef<S, M, U extends ToolUi = ToolUi> =
  | TextField<S, M, U>
  | NumberField<S, M, U>
  | SelectField<S, M, U>
  | SegmentedField<S, M, U>
  | ToggleField<S, M, U>
  | ColourField<S, M, U>
  | PvField<S, M, U>
  | ReadonlyField<S, M, U>
  | CodeField<S, M, U>
  // A custom field's value type is the tool's own; the union erases it.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  | CustomField<S, M, U, any>
  | ActionField<S, M, U>;

// ---------------------------------------------------------------- schema --

/**
 * One titled group of an object's fields: a block of a card, a collapsible
 * plot-wide section at tool level (`summary` is its closed one-line state), or
 * at tool level the chart source (id `code`).
 */
export interface TabDef<S, M, U extends ToolUi = ToolUi> {
  id: string;
  label: string;
  fields: FieldDef<S, M, U>[];
  /** The one-line state shown beside a plot-wide section's title (e.g. `Y auto · X index`). */
  summary?(ctx: ToolContext<S, M, U>): string;
}

/** The field groups of one object kind. */
export interface ObjectSchema<S, M, U extends ToolUi = ToolUi> {
  tabs: TabDef<S, M, U>[];
}

/** Where a section kind's own fields show. */
export type SectionPlacement = 'group' | 'axes';

/** A section kind: optional capacity (`n/cap` in its header) and one inline header field. */
export interface SectionSchema<S, M, U extends ToolUi = ToolUi> extends ObjectSchema<S, M, U> {
  capacity?: number;
  /** Rendered in the section header with `data-testid=<field id>` and no `#id`. */
  headerField?: FieldDef<S, M, U>;
  /** The top-block heading the section sits under; absent = the section's own title. */
  group?: string;
  /** `group` (default): fields under the section's cards; `axes`: inside the Axes section. */
  placement?: SectionPlacement;
}

/** The static half: built once at module level, never per render. */
export interface ToolSchema<S, M, U extends ToolUi = ToolUi> {
  /** The tool-level object: the plot. */
  tool: ObjectSchema<S, M, U>;
  sections: Record<string, SectionSchema<S, M, U>>;
  items: Record<string, ObjectSchema<S, M, U>>;
}

// ---------------------------------------------------------------- binding --

/** An actions-bar entry, also used for Outline footer actions. */
export interface Action {
  id: string;
  label: string;
  icon: ComponentType<{ size?: number | string }>;
  kind: 'button' | 'toggle';
  pressed?: boolean;
  /** `false`, or the reason it is temporarily unusable. */
  disabled?: false | string;
  shortcut?: string;
  /**
   * The host's ⋯ menu placement: an action carrying it and no `bar` is
   * reported with `placement: "menu"`, menu entries sorted by `order`, under
   * `label` when given instead of the bar label.
   */
  menu?: { order: number; label?: string };
  /**
   * The host's tile-bar placement: an action carrying it is reported with
   * `placement: "bar"`, bar entries sorted by `order`. An action with neither
   * placement is not reported.
   */
  bar?: { order: number };
  /**
   * The Carbon component name of `icon`, reported as the `canopy:tool-actions` `icon`.
   * Declared beside the component, never derived: minified builds lose names.
   */
  iconName?: string;
  /** The external URL the action opens, when it opens one (docs, bug report). */
  href?: string;
  onClick(): void;
}

/** The row status dot. `refused` pairs with the row's `refusal` text. */
export type RowStatus = 'ok' | 'pending' | 'stale' | 'error' | 'refused';

export interface OutlineRow {
  id: string;
  /** The item kind (`schema.items[kind]`). */
  kind: string;
  label: string;
  status: RowStatus;
  refusal?: string;
}

/** A section's add row; `search` replaces the default PV search. */
export interface OutlineAdd {
  placeholder: string;
  /** `false`, or why nothing can be added right now. */
  disabled?: false | string;
  search?: PvSearch;
}

export interface OutlineSection {
  id: string;
  /** The section kind (`schema.sections[kind]`). */
  kind: string;
  title: string;
  unit?: string;
  count: number;
  capacity?: number;
  /** Renders the whole section muted. */
  muted?: boolean;
  rows: OutlineRow[];
  add?: OutlineAdd;
}

export interface OutlineViewModel {
  sections: OutlineSection[];
}

/** An add the tool refused, with an optional way out ("Open in Waveform"). */
export interface AddRefusal {
  message: string;
  action?: { label: string; onClick(): void };
}

/** Structural row operations; every other edit goes through a field's `set`. */
export interface ToolOps {
  /** Resolves to a refusal, or nothing once the item is added. */
  add(sectionId: string, pv: string): Promise<AddRefusal | void>;
  remove(itemId: string): void;
  move(itemId: string, sectionId: string): void;
}

/** The per-render half, read through a latest-ref (rate rule). */
export interface ToolBinding<S, M> {
  outline(state: S, model: M): OutlineViewModel;
  ops: ToolOps;
  /** Why `itemId` cannot move to `sectionId`, or `null`; the same rule the Plot on options use. */
  moveRefusal(itemId: string, sectionId: string): string | null;
  footer?: Action[];
}

/** The whole tool, schema plus binding. */
export interface ToolDefinition<State, Model, Ui extends ToolUi = ToolUi> {
  schema: ToolSchema<State, Model, Ui>;
  binding: ToolBinding<State, Model>;
}
