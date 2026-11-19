// The stub fourth tool: the worked example the properties
// panel, field-renderer and layout tests run against, and the proof of
// Goal 1 — a fourth tool hands the workbench a `ToolDefinition` and writes no
// layout code.
//
// It carries one of everything the workbench must render:
// - two sections: `signals` with a capacity, `locked` whose move-refusal rule
//   rejects every drop;
// - items with a Colour (`row: 'swatch'`) and a Visible (`row: 'eye'`) field;
// - one custom field, one action row (gated on the `inspect` capability), one
//   footer action, one read-only Status field (`group: 'status'`), one
//   `when`-gated field, one Advanced (L3) field;
// - a field built with each dot helper (stampedValue, optionalPath,
//   recordKey) at item level, plus an optionalPath dot at tool level;
// - a tool-level `general` tab with a `summary` and a tool-level `code` tab
//   (the chart source);
// - an async `ops.add` that refuses (with or without an action) or is slow
//   until the test releases it.
//
// State lives in a tiny store (`createStubTool`) with a `tick()` that pushes a
// new model object with unchanged content, so render-count tests can prove
// that unchanged data causes no commits in either half of the panel.
// `withSections` patches section kinds (a `group`, a `placement`)
// over the same binding, for the panel's grouping and Axes tests.
//
// Fixtures are exempt from check-chrome-literals, so colour literals are fine.

import { createElement } from 'react';
import { TrashCan } from '@carbon/icons-react';
import { optionalPath, recordKey, stampedValue } from '../../tools/dotHelpers';
import type {
  Action,
  AddRefusal,
  Capabilities,
  FieldDef,
  OutlineViewModel,
  RowStatus,
  SectionSchema,
  Selection,
  Target,
  ToolBinding,
  ToolContext,
  ToolDefinition,
  ToolSchema,
} from '../types';

// ------------------------------------------------------------------ shapes --

export type StubSectionId = 'signals' | 'locked';
export type StubMode = 'raw' | 'smooth';

export interface StubItem {
  id: string;
  pv: string;
  section: StubSectionId;
  /** Stamped from the palette at the item's position unless pinned. */
  colour: string;
  visible: boolean;
  /** The row lock slot's value (`row: 'lock'`). */
  pinned: boolean;
  /** Undefined = automatic (the PV name). optionalPath dot. */
  label?: string;
  mode: StubMode;
  /** Only shown while `mode === 'smooth'` (the `when`-gated field). */
  window: number | null;
  /** The Advanced (L3) field. */
  gain: number | null;
  /** The custom field's value. */
  tags: string;
  /** Line width in px, on the Line tab (a select with a disabled option). */
  width: string;
}

export interface StubState {
  /** Undefined = automatic ("Stub"). optionalPath dot at tool level. */
  title?: string;
  items: StubItem[];
  /** Per-PV offsets; the recordKey dot. */
  offsets: Record<string, number>;
  /** Section header eyes. */
  sectionVisible: Record<StubSectionId, boolean>;
  /** A reference PV at tool level (the `pv` field kind). */
  reference: string;
}

export interface StubModel {
  /** Bumped by `tick()`; nothing in the schema or outline reads it. */
  tick: number;
  /** Per-item data status, the read-only Status field and the row dot. */
  status: Record<string, RowStatus>;
}

export interface StubUi {
  /** Item ids the action row ran for, in order (the action writes no state). */
  actionRuns: string[];
}

export type StubCtx = ToolContext<StubState, StubModel, StubUi>;
type StubField = FieldDef<StubState, StubModel, StubUi>;

// --------------------------------------------------------------- constants --

export const STUB_TOOL_ID = 'stub';
export const STUB_DEFAULT_TITLE = 'Stub';
export const STUB_PALETTE = ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728'] as const;
export const STUB_SIGNALS_CAPACITY = 3;
/** The capability the action row needs; absent → the row is hidden. */
export const STUB_ACTION_CAPABILITY = 'inspect';
export const STUB_LOCKED_REFUSAL = 'Locked accepts no drops';
export const STUB_FULL_REFUSAL = `Signals is full (${STUB_SIGNALS_CAPACITY}/${STUB_SIGNALS_CAPACITY})`;
/** A PV starting with this prefix is refused with an action. */
export const STUB_REFUSE_PREFIX = 'REFUSE:';
export const STUB_REFUSAL_MESSAGE = 'Not a stub signal';
export const STUB_REFUSAL_ACTION = 'Open elsewhere';
/** A PV starting with this prefix stays pending until `releaseSlowAdds()`. */
export const STUB_SLOW_PREFIX = 'SLOW:';

export const STUB_SECTION_TITLES: Record<StubSectionId, string> = {
  signals: 'Signals',
  locked: 'Locked',
};

/** The colour the automatic rule stamps at `index` in `state.items`. */
export function stubAutoColour(index: number): string {
  return STUB_PALETTE[((index % STUB_PALETTE.length) + STUB_PALETTE.length) % STUB_PALETTE.length];
}

// ----------------------------------------------------------------- helpers --

function itemOf(state: StubState, id: string): StubItem | undefined {
  return state.items.find((item) => item.id === id);
}

function patchItem(state: StubState, id: string, patch: Partial<StubItem>): StubState {
  return {
    ...state,
    items: state.items.map((item) => (item.id === id ? { ...item, ...patch } : item)),
  };
}

/** The target's item; fields only render for items that exist. */
function targetItem(ctx: StubCtx): StubItem {
  const item = itemOf(ctx.state, ctx.target.id);
  if (item === undefined) throw new Error(`stub: no item ${ctx.target.id}`);
  return item;
}

function setItem(ctx: StubCtx, patch: Partial<StubItem>): void {
  const id = ctx.target.id;
  ctx.update((state) => patchItem(state, id, patch));
}

function numberOrNull(value: number | null): number | null {
  return value === null || Number.isNaN(value) ? null : value;
}

// ----------------------------------------------------------------- fields --

/** Row swatch; stampedValue dot (pinned iff not this slot's palette colour). */
export const colourField: StubField = {
  id: 'stub-colour',
  label: 'Colour',
  kind: 'colour',
  tab: 'general',
  level: 'L1',
  row: 'swatch',
  get: (ctx) => targetItem(ctx).colour,
  set: (ctx, value) => setItem(ctx, { colour: value }),
  ...stampedValue<StubState, StubModel, string, StubUi>({
    get: (ctx) => targetItem(ctx).colour,
    isAutomatic: (value, ctx) =>
      value === stubAutoColour(ctx.state.items.findIndex((i) => i.id === ctx.target.id)),
    automatic: (ctx) => stubAutoColour(ctx.state.items.findIndex((i) => i.id === ctx.target.id)),
    set: (state, target, value) => patchItem(state, target.id, { colour: value }),
  }),
};

/** Row eye; no automatic rule, so no dot. */
export const visibleField: StubField = {
  id: 'stub-visible',
  label: 'Visible',
  kind: 'toggle',
  tab: 'general',
  level: 'L1',
  row: 'eye',
  get: (ctx) => targetItem(ctx).visible,
  set: (ctx, value) => setItem(ctx, { visible: value }),
};

/**
 * Row lock glyph (`row: 'lock'`), after the eye; no automatic rule, so no dot.
 * It sits on the Line tab so the General tab's field order stays as pinned.
 */
export const lockField: StubField = {
  id: 'stub-pinned',
  label: 'Lock',
  kind: 'toggle',
  tab: 'line',
  level: 'L1',
  row: 'lock',
  get: (ctx) => targetItem(ctx).pinned,
  set: (ctx, value) => setItem(ctx, { pinned: value }),
};

/** optionalPath dot: undefined is automatic (shows the PV name). */
export const labelField: StubField = {
  id: 'stub-label',
  label: 'Display name',
  kind: 'text',
  tab: 'general',
  level: 'L1',
  placeholder: 'PV name',
  get: (ctx) => targetItem(ctx).label ?? '',
  set: (ctx, value) => setItem(ctx, { label: value === '' ? undefined : value }),
  ...optionalPath<StubState, StubModel, StubUi>({
    get: (ctx) => targetItem(ctx).label,
    set: (state, target, value) => patchItem(state, target.id, { label: value }),
  }),
};

/** recordKey dot: pinned iff `state.offsets` holds the item's PV. */
export const offsetField: StubField = {
  id: 'stub-offset',
  label: 'Offset',
  kind: 'number',
  tab: 'general',
  level: 'L2',
  step: 0.1,
  get: (ctx) => ctx.state.offsets[targetItem(ctx).pv] ?? 0,
  set: (ctx, value) => {
    const pv = targetItem(ctx).pv;
    ctx.update((state) => ({ ...state, offsets: { ...state.offsets, [pv]: value ?? 0 } }));
  },
  ...recordKey<StubState, StubModel, StubUi, Record<string, number>>({
    record: (state) => state.offsets,
    key: (ctx) => itemOf(ctx.state, ctx.target.id)?.pv,
    write: (state, offsets) => ({ ...state, offsets }),
  }),
};

export const modeField: StubField = {
  id: 'stub-mode',
  label: 'Mode',
  kind: 'segmented',
  tab: 'general',
  level: 'L1',
  options: () => [
    { value: 'raw', label: 'Raw' },
    { value: 'smooth', label: 'Smooth' },
  ],
  get: (ctx) => targetItem(ctx).mode,
  set: (ctx, value) => setItem(ctx, { mode: value === 'smooth' ? 'smooth' : 'raw' }),
};

/** The `when`-gated field: absent unless Mode is Smooth. */
export const windowField: StubField = {
  id: 'stub-window',
  label: 'Window',
  kind: 'number',
  tab: 'general',
  level: 'L2',
  min: 1,
  unit: 'samples',
  when: (ctx) => itemOf(ctx.state, ctx.target.id)?.mode === 'smooth',
  get: (ctx) => targetItem(ctx).window,
  set: (ctx, value) => setItem(ctx, { window: numberOrNull(value) }),
};

/** The Advanced (L3) field. */
export const gainField: StubField = {
  id: 'stub-gain',
  label: 'Gain',
  kind: 'number',
  tab: 'general',
  level: 'L3',
  get: (ctx) => targetItem(ctx).gain,
  set: (ctx, value) => setItem(ctx, { gain: numberOrNull(value) }),
};

/** The read-only Status field, outside the L1 budget. */
export const statusField: StubField = {
  id: 'stub-status',
  label: 'Status',
  kind: 'readonly',
  tab: 'general',
  level: 'L1',
  group: 'status',
  get: (ctx) => ctx.model.status[ctx.target.id] ?? 'pending',
};

/** The custom field: a tool-supplied renderer (a plain input). */
export const tagsField: StubField = {
  id: 'stub-tags',
  label: 'Tags',
  kind: 'custom',
  tab: 'general',
  level: 'L2',
  get: (ctx) => targetItem(ctx).tags,
  set: (ctx, value: string) => setItem(ctx, { tags: value }),
  render: ({ value, onChange, id }) =>
    createElement('input', {
      id,
      'data-testid': 'stub-tags-input',
      value: value as string,
      onChange: (event: { target: { value: string } }) => onChange(event.target.value),
    }),
};

/** The action row; hidden unless the `inspect` capability is present. */
export const inspectField: StubField = {
  id: 'stub-inspect',
  label: 'Inspect data',
  kind: 'action',
  tab: 'general',
  level: 'L1',
  when: (ctx) => ctx.capabilities[STUB_ACTION_CAPABILITY] === true,
  run: (ctx) => {
    ctx.ui.actionRuns.push(ctx.target.id);
  },
};

export const lineWidthField: StubField = {
  id: 'stub-line-width',
  label: 'Line width',
  kind: 'select',
  tab: 'line',
  level: 'L1',
  options: () => [
    { value: '1', label: '1 px' },
    { value: '2', label: '2 px' },
    { value: '4', label: '4 px', disabled: 'Too wide for the stub' },
  ],
  get: (ctx) => targetItem(ctx).width,
  set: (ctx, value) => setItem(ctx, { width: value }),
};

export const itemCodeField: StubField = {
  id: 'stub-item-code',
  label: 'Code',
  kind: 'code',
  tab: 'code',
  level: 'L1',
  get: (ctx) => JSON.stringify(itemOf(ctx.state, ctx.target.id) ?? null, null, 2),
};

// Tool level.

/** optionalPath dot at tool level: the plot title. */
export const titleField: StubField = {
  id: 'stub-title',
  label: 'Title',
  kind: 'text',
  tab: 'general',
  level: 'L1',
  placeholder: STUB_DEFAULT_TITLE,
  get: (ctx) => ctx.state.title ?? '',
  set: (ctx, value) =>
    ctx.update((state) => ({ ...state, title: value === '' ? undefined : value })),
  ...optionalPath<StubState, StubModel, StubUi>({
    get: (ctx) => ctx.state.title,
    set: (state, _target, value) => ({ ...state, title: value }),
  }),
};

/** The tool-level chart source (`code` tab). */
export const toolCodeField: StubField = {
  id: 'stub-tool-code',
  label: 'Chart source',
  kind: 'code',
  tab: 'code',
  level: 'L1',
  get: (ctx) => JSON.stringify({ title: ctx.state.title ?? STUB_DEFAULT_TITLE }),
};

/** The tool-level `general` tab's one-line summary. */
export function stubToolSummary(ctx: StubCtx): string {
  return ctx.state.reference === '' ? 'no reference' : `ref ${ctx.state.reference}`;
}

export const referenceField: StubField = {
  id: 'stub-reference',
  label: 'Reference PV',
  kind: 'pv',
  tab: 'general',
  level: 'L2',
  get: (ctx) => ctx.state.reference,
  set: (ctx, value) => ctx.update((state) => ({ ...state, reference: value })),
};

// Section level.

function sectionId(ctx: StubCtx): StubSectionId {
  return ctx.target.id === 'locked' ? 'locked' : 'signals';
}

/** The section header's eye (also a field of the section's own tab). */
export const sectionVisibleField: StubField = {
  id: 'stub-section-visible',
  label: 'Visible',
  kind: 'toggle',
  tab: 'general',
  level: 'L1',
  row: 'eye',
  get: (ctx) => ctx.state.sectionVisible[sectionId(ctx)],
  set: (ctx, value) => {
    const id = sectionId(ctx);
    ctx.update((state) => ({
      ...state,
      sectionVisible: { ...state.sectionVisible, [id]: value },
    }));
  },
};

export const sectionCountField: StubField = {
  id: 'stub-section-count',
  label: 'Signals',
  kind: 'readonly',
  tab: 'general',
  level: 'L1',
  group: 'status',
  get: (ctx) => String(ctx.state.items.filter((i) => i.section === sectionId(ctx)).length),
};

// ----------------------------------------------------------------- schema --

const itemSchema = {
  tabs: [
    {
      id: 'general',
      label: 'General',
      fields: [
        colourField,
        visibleField,
        labelField,
        modeField,
        windowField,
        offsetField,
        tagsField,
        gainField,
        statusField,
        inspectField,
      ],
    },
    { id: 'line', label: 'Line', fields: [lineWidthField, lockField] },
    { id: 'code', label: 'Code', fields: [itemCodeField] },
  ],
};

function sectionSchema(capacity?: number): SectionSchema<StubState, StubModel, StubUi> {
  return {
    ...(capacity === undefined ? {} : { capacity }),
    headerField: sectionVisibleField,
    tabs: [{ id: 'general', label: 'General', fields: [sectionVisibleField, sectionCountField] }],
  };
}

/** The static half, built once at module level. */
export const stubSchema: ToolSchema<StubState, StubModel, StubUi> = {
  tool: {
    tabs: [
      {
        id: 'general',
        label: 'General',
        fields: [titleField, referenceField],
        summary: stubToolSummary,
      },
      { id: 'code', label: 'Code', fields: [toolCodeField] },
    ],
  },
  sections: {
    signals: sectionSchema(STUB_SIGNALS_CAPACITY),
    locked: sectionSchema(),
  },
  items: { signal: itemSchema },
};

export const STUB_ITEM_KIND = 'signal';

/** `definition` with its section kinds patched (e.g. a `group` or `placement`), same binding. */
export function withSections(
  definition: ToolDefinition<StubState, StubModel, StubUi>,
  patch: Partial<Record<StubSectionId, Partial<SectionSchema<StubState, StubModel, StubUi>>>>
): ToolDefinition<StubState, StubModel, StubUi> {
  const sections = { ...definition.schema.sections };
  for (const [kind, extra] of Object.entries(patch)) {
    sections[kind] = { ...sections[kind], ...extra };
  }
  return { schema: { ...definition.schema, sections }, binding: definition.binding };
}

// ------------------------------------------------------------------ store --

export interface StubToolOptions {
  state?: Partial<StubState>;
  model?: Partial<StubModel>;
  ui?: Partial<StubUi>;
  capabilities?: Partial<Capabilities>;
}

export interface StubCalls {
  add: Array<{ sectionId: string; pv: string }>;
  remove: string[];
  move: Array<{ itemId: string; sectionId: string }>;
  footer: number;
  refusalAction: number;
  /** Item ids the action row ran for. */
  readonly action: string[];
}

export interface StubTool {
  definition: ToolDefinition<StubState, StubModel, StubUi>;
  getState(): StubState;
  getModel(): StubModel;
  getUi(): StubUi;
  capabilities: Capabilities;
  /** The tool's single writer, as handed to `ctx.update`. */
  update(fn: (state: StubState) => StubState): void;
  /** Push a new model object with unchanged content. */
  tick(): void;
  setStatus(itemId: string, status: RowStatus): void;
  /** Resolve every pending `SLOW:` add. */
  releaseSlowAdds(): Promise<void>;
  pendingSlowAdds(): number;
  subscribe(listener: () => void): () => void;
  /** A full `ToolContext` for `target`, reading the store's current values. */
  ctx(target: Target, selection?: Selection): StubCtx;
  calls: StubCalls;
}

export function stubItem(
  id: string,
  pv: string,
  index: number,
  patch: Partial<StubItem> = {}
): StubItem {
  return {
    id,
    pv,
    section: 'signals',
    colour: stubAutoColour(index),
    visible: true,
    pinned: false,
    mode: 'raw',
    window: null,
    gain: null,
    tags: '',
    width: '1',
    ...patch,
  };
}

/** Two signals and one locked item: room for one more in Signals. */
export function stubInitialState(): StubState {
  return {
    items: [
      stubItem('a', 'STUB:A', 0),
      stubItem('b', 'STUB:B', 1),
      stubItem('c', 'STUB:C', 2, { section: 'locked' }),
    ],
    offsets: {},
    sectionVisible: { signals: true, locked: true },
    reference: '',
  };
}

export const tool: Target = { level: 'tool', kind: STUB_TOOL_ID, id: STUB_TOOL_ID };
export const section = (id: StubSectionId): Target => ({ level: 'section', kind: id, id });
export const item = (id: string): Target => ({ level: 'item', kind: STUB_ITEM_KIND, id });

function countIn(state: StubState, sectionKey: StubSectionId): number {
  return state.items.filter((i) => i.section === sectionKey).length;
}

function moveRefusalOf(state: StubState, itemId: string, sectionKey: string): string | null {
  const current = itemOf(state, itemId);
  if (current === undefined) return `No item ${itemId}`;
  if (current.section === sectionKey) return null;
  if (sectionKey === 'locked') return STUB_LOCKED_REFUSAL;
  if (sectionKey === 'signals' && countIn(state, 'signals') >= STUB_SIGNALS_CAPACITY) {
    return STUB_FULL_REFUSAL;
  }
  if (sectionKey !== 'signals') return `No section ${sectionKey}`;
  return null;
}

function outlineOf(state: StubState, model: StubModel): OutlineViewModel {
  const sections: StubSectionId[] = ['signals', 'locked'];
  return {
    sections: sections.map((key) => {
      const rows = state.items
        .filter((i) => i.section === key)
        .map((i) => {
          const status = model.status[i.id] ?? 'ok';
          return {
            id: i.id,
            kind: STUB_ITEM_KIND,
            label: i.label ?? i.pv,
            status,
            ...(status === 'refused' ? { refusal: STUB_REFUSAL_MESSAGE } : {}),
          };
        });
      return {
        id: key,
        kind: key,
        title: STUB_SECTION_TITLES[key],
        count: rows.length,
        ...(key === 'signals' ? { capacity: STUB_SIGNALS_CAPACITY, unit: 'mm' } : {}),
        muted: !state.sectionVisible[key],
        rows,
        add: { placeholder: `Add to ${STUB_SECTION_TITLES[key]}` },
      };
    }),
  };
}

export function createStubTool(options: StubToolOptions = {}): StubTool {
  let state: StubState = { ...stubInitialState(), ...options.state };
  let model: StubModel = { tick: 0, status: {}, ...options.model };
  const ui: StubUi = { actionRuns: [], ...options.ui };
  const capabilities: Capabilities = { elog: false, ...options.capabilities } as Capabilities;
  const listeners = new Set<() => void>();
  const slow: Array<{ resolve(): void; done: Promise<void> }> = [];
  let nextId = 1;
  const calls: StubCalls = {
    add: [],
    remove: [],
    move: [],
    footer: 0,
    refusalAction: 0,
    get action() {
      return ui.actionRuns;
    },
  };

  const emit = () => {
    for (const listener of [...listeners]) listener();
  };
  const update = (fn: (s: StubState) => StubState) => {
    const next = fn(state);
    if (next === state) return;
    state = next;
    emit();
  };

  const commitAdd = (sectionKey: string, pv: string): AddRefusal | void => {
    if (sectionKey !== 'signals' && sectionKey !== 'locked') {
      return { message: `No section ${sectionKey}` };
    }
    if (state.items.some((i) => i.pv === pv)) return { message: `${pv} is already here` };
    if (sectionKey === 'signals' && countIn(state, 'signals') >= STUB_SIGNALS_CAPACITY) {
      return { message: STUB_FULL_REFUSAL };
    }
    const id = `n${nextId++}`;
    update((s) => ({
      ...s,
      items: [...s.items, stubItem(id, pv, s.items.length, { section: sectionKey })],
    }));
  };

  const binding: ToolBinding<StubState, StubModel> = {
    outline: outlineOf,
    ops: {
      async add(sectionKey, pv) {
        calls.add.push({ sectionId: sectionKey, pv });
        if (pv.startsWith(STUB_REFUSE_PREFIX)) {
          return {
            message: STUB_REFUSAL_MESSAGE,
            action: {
              label: STUB_REFUSAL_ACTION,
              onClick: () => {
                calls.refusalAction += 1;
              },
            },
          };
        }
        if (pv.startsWith(STUB_SLOW_PREFIX)) {
          let settled!: () => void;
          const done = new Promise<void>((resolve) => (settled = resolve));
          await new Promise<void>((resolve) => slow.push({ resolve, done }));
          try {
            return commitAdd(sectionKey, pv);
          } finally {
            settled();
          }
        }
        // The commit writer, not the add row, checks capacity and duplicates.
        return commitAdd(sectionKey, pv);
      },
      remove(itemId) {
        calls.remove.push(itemId);
        update((s) => ({ ...s, items: s.items.filter((i) => i.id !== itemId) }));
      },
      move(itemId, sectionKey) {
        calls.move.push({ itemId, sectionId: sectionKey });
        if (moveRefusalOf(state, itemId, sectionKey) !== null) return;
        update((s) => patchItem(s, itemId, { section: sectionKey as StubSectionId }));
      },
    },
    moveRefusal: (itemId, sectionKey) => moveRefusalOf(state, itemId, sectionKey),
    footer: [
      {
        id: 'stub-clear',
        label: 'Clear all',
        icon: TrashCan,
        kind: 'button',
        onClick: () => {
          calls.footer += 1;
        },
      } satisfies Action,
    ],
  };

  return {
    definition: { schema: stubSchema, binding },
    getState: () => state,
    getModel: () => model,
    getUi: () => ui,
    capabilities,
    update,
    tick() {
      model = { ...model, tick: model.tick + 1 };
      emit();
    },
    setStatus(itemId, status) {
      model = { ...model, status: { ...model.status, [itemId]: status } };
      emit();
    },
    async releaseSlowAdds() {
      const released = slow.splice(0);
      for (const entry of released) entry.resolve();
      // Resolve once every released add has run its commit.
      await Promise.all(released.map((entry) => entry.done));
    },
    pendingSlowAdds: () => slow.length,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    ctx: (target, selection = null) => ({
      state,
      model,
      update,
      selection,
      target,
      capabilities,
      ui,
    }),
    calls,
  };
}
