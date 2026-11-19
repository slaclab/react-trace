// Pins the shape of the ToolDefinition contract. The
// `@ts-expect-error` lines are the real assertions: `tsc -b` fails if any of
// them stops being an error, so a loosened contract breaks the build.

import { describe, expect, expectTypeOf, it } from 'vitest';
import type { PvSearch } from '../pvSearch';
import {
  FIELD_KINDS,
  FIELD_LEVELS,
  type Action,
  type AddRefusal,
  type Capabilities,
  type FieldDef,
  type FieldKind,
  type OutlineViewModel,
  type Selection,
  type Target,
  type ToolBinding,
  type ToolContext,
  type ToolDefinition,
  type ToolSchema,
} from './types';

interface State {
  colours: Record<string, string>;
  hidden: Record<string, boolean>;
  name: string;
  rate: number | null;
  mode: string;
}
interface Model {
  pvs: string[];
}
interface Ui {
  pendingTrigger: string | null;
}
type Ctx = ToolContext<State, Model, Ui>;
type Field = FieldDef<State, Model, Ui>;

const Icon = () => null;

// A static schema at module level, as every tool builds it.
const colour: Field = {
  id: 'curve-colour',
  label: 'Colour',
  kind: 'colour',
  tab: 'general',
  level: 'L1',
  row: 'swatch',
  get: (ctx) => ctx.state.colours[ctx.target.id] ?? '#000',
  set: (ctx, v) => ctx.update((s) => ({ ...s, colours: { ...s.colours, [ctx.target.id]: v } })),
  modified: (ctx) => ctx.target.id in ctx.state.colours,
  reset: (ctx) => ctx.update((s) => s),
};

const visible: Field = {
  id: 'visible',
  label: 'Visible',
  kind: 'toggle',
  tab: 'general',
  level: 'L1',
  row: 'eye',
  get: (ctx) => !ctx.state.hidden[ctx.target.id],
  set: () => {},
};

const schema: ToolSchema<State, Model, Ui> = {
  tool: {
    tabs: [
      {
        id: 'general',
        label: 'General',
        fields: [
          {
            id: 'rate',
            label: 'Rate',
            kind: 'number',
            tab: 'general',
            level: 'L3',
            min: 0,
            get: (ctx) => ctx.state.rate,
            set: () => {},
          },
          {
            id: 'status',
            label: 'Status',
            kind: 'readonly',
            tab: 'general',
            level: 'L1',
            group: 'status',
            get: (ctx) => `${ctx.model.pvs.length} PVs`,
          },
          {
            id: 'post-elog',
            label: 'Post to e-log',
            kind: 'action',
            tab: 'general',
            level: 'L1',
            when: (ctx) => ctx.capabilities.elog,
            disabled: (ctx) => (ctx.model.pvs.length ? false : 'Nothing to post'),
            run: () => {},
          },
        ],
      },
      {
        id: 'code',
        label: 'Code',
        fields: [
          { id: 'code', label: 'Code', kind: 'code', tab: 'code', level: 'L1', get: () => '{}' },
        ],
      },
    ],
  },
  sections: {
    y: {
      capacity: 4,
      headerField: {
        id: 'trigger-source',
        label: 'Trigger',
        kind: 'select',
        tab: 'general',
        level: 'L1',
        options: (ctx) =>
          ctx.model.pvs.map((pv) => ({ value: pv, label: pv, disabled: undefined })),
        get: (ctx) => ctx.ui.pendingTrigger ?? '',
        set: () => {},
      },
      tabs: [{ id: 'general', label: 'General', fields: [visible] }],
    },
  },
  items: {
    curve: {
      tabs: [
        {
          id: 'general',
          label: 'General',
          fields: [
            colour,
            visible,
            {
              id: 'role',
              label: 'Role',
              kind: 'select',
              tab: 'general',
              level: 'L1',
              options: () => [
                { value: 'x', label: 'X' },
                { value: 'trigger', label: 'Trigger', disabled: 'A waveform cannot trigger' },
              ],
              get: () => 'x',
              set: () => {},
            },
            {
              id: 'range',
              label: 'Range',
              kind: 'custom',
              tab: 'general',
              level: 'L2',
              get: () => [0, 10] as [number, number],
              set: () => {},
              render: ({ value, onChange, id }) => {
                void id;
                onChange([value[0], value[1] + 1]);
                return null;
              },
            },
          ],
        },
      ],
    },
  },
};

const binding: ToolBinding<State, Model> = {
  outline: (_state, model) => ({
    sections: [
      {
        id: 'y',
        kind: 'y',
        title: 'Y',
        unit: 'mm',
        count: model.pvs.length,
        capacity: 4,
        muted: false,
        rows: model.pvs.map((pv) => ({ id: pv, kind: 'curve', label: pv, status: 'ok' as const })),
        add: { placeholder: 'Add PV', disabled: false },
      },
    ],
  }),
  ops: {
    add: async (_section, pv) =>
      pv ? undefined : { message: 'Empty', action: { label: 'Open', onClick: () => {} } },
    remove: () => {},
    move: () => {},
  },
  moveRefusal: (item, section) => (item === section ? 'Same section' : null),
  footer: [{ id: 'add-axis', label: 'Add axis', icon: Icon, kind: 'button', onClick: () => {} }],
};

const definition: ToolDefinition<State, Model, Ui> = { schema, binding };

function ctx(target: Target, overrides: Partial<Ctx> = {}): Ctx {
  return {
    state: { colours: {}, hidden: {}, name: 'Plot 1', rate: null, mode: 'a' },
    model: { pvs: ['A', 'B'] },
    update: () => {},
    selection: null,
    target,
    capabilities: { elog: true },
    ui: { pendingTrigger: null },
    ...overrides,
  };
}

describe('ToolDefinition contract', () => {
  it('lists every field kind and level', () => {
    expect(FIELD_KINDS).toEqual([
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
    ]);
    expect(FIELD_LEVELS).toEqual(['L1', 'L2', 'L3']);
    expectTypeOf<Field['kind']>().toEqualTypeOf<FieldKind>();
  });

  it('builds the outline view-model from state and model', () => {
    const vm = definition.binding.outline(ctx({ level: 'tool', kind: 'stub', id: 'stub' }).state, {
      pvs: ['A'],
    });
    expect(vm.sections[0]).toMatchObject({
      count: 1,
      capacity: 4,
      rows: [{ id: 'A', kind: 'curve', status: 'ok' }],
    });
    expectTypeOf(vm).toEqualTypeOf<OutlineViewModel>();
  });

  it('add resolves to a refusal or nothing', async () => {
    await expect(binding.ops.add('y', 'A')).resolves.toBeUndefined();
    await expect(binding.ops.add('y', '')).resolves.toMatchObject({ message: 'Empty' });
    expectTypeOf(binding.ops.add).returns.toEqualTypeOf<Promise<AddRefusal | void>>();
    expectTypeOf(binding.moveRefusal).returns.toEqualTypeOf<string | null>();
  });

  it('field functions read the target and the capability record', () => {
    const fields = schema.tool.tabs[0].fields;
    const elog = fields.find((f) => f.id === 'post-elog')!;
    expect(elog.when?.(ctx({ level: 'tool', kind: 'stub', id: 'stub' }))).toBe(true);
    expect(
      elog.when?.(
        ctx({ level: 'tool', kind: 'stub', id: 'stub' }, { capabilities: { elog: false } })
      )
    ).toBe(false);
    expect(
      elog.disabled?.(ctx({ level: 'tool', kind: 'stub', id: 'stub' }, { model: { pvs: [] } }))
    ).toBe('Nothing to post');

    const c = ctx(
      { level: 'item', kind: 'curve', id: 'A' },
      { state: { colours: { A: '#f00' }, hidden: {}, name: '', rate: null, mode: 'a' } }
    );
    expect(colour.kind === 'colour' && colour.get(c)).toBe('#f00');
    expect(colour.modified?.(c)).toBe(true);
  });

  it('pins the context shape', () => {
    expectTypeOf<Ctx['target']>().toEqualTypeOf<Target>();
    expectTypeOf<Ctx['selection']>().toEqualTypeOf<Selection>();
    expectTypeOf<Ctx['capabilities']>().toEqualTypeOf<Capabilities>();
    expectTypeOf<Ctx['ui']>().toEqualTypeOf<Ui>();
    expectTypeOf<Target['level']>().toEqualTypeOf<'tool' | 'section' | 'item'>();
    expectTypeOf<Capabilities['elog']>().toEqualTypeOf<boolean>();
    expectTypeOf<Selection>().toEqualTypeOf<Target | null>();
  });

  it('narrows field value types by kind', () => {
    type Of<K extends FieldKind> = Extract<Field, { kind: K }>;
    expectTypeOf<ReturnType<Of<'toggle'>['get']>>().toEqualTypeOf<boolean>();
    expectTypeOf<ReturnType<Of<'number'>['get']>>().toEqualTypeOf<number | null>();
    expectTypeOf<ReturnType<Of<'colour'>['get']>>().toEqualTypeOf<string>();
    expectTypeOf<Of<'colour'>['row']>().toEqualTypeOf<'swatch' | undefined>();
    expectTypeOf<Of<'toggle'>['row']>().toEqualTypeOf<'eye' | 'lock' | undefined>();
    expectTypeOf<Of<'pv'>['search']>().toEqualTypeOf<PvSearch | undefined>();
    expectTypeOf<Action['disabled']>().toEqualTypeOf<false | string | undefined>();
  });

  it('rejects shapes the contract forbids', () => {
    // One line per shape so each `@ts-expect-error` covers exactly its own error.
    // prettier-ignore
    const rejected: Field[] = [
      // @ts-expect-error modified without reset: the dot comes as a pair
      { id: 'a', label: 'A', kind: 'text', tab: 't', level: 'L1', get: () => '', set: () => {}, modified: () => true },
      // @ts-expect-error an action has no dot
      { id: 'b', label: 'B', kind: 'action', tab: 't', level: 'L1', run: () => {}, modified: () => true, reset: () => {} },
      // @ts-expect-error a readonly field has no setter
      { id: 'c', label: 'C', kind: 'readonly', tab: 't', level: 'L1', get: () => '', set: () => {} },
      // @ts-expect-error only a colour field takes the swatch slot
      { id: 'd', label: 'D', kind: 'text', tab: 't', level: 'L1', get: () => '', set: () => {}, row: 'swatch' },
      // @ts-expect-error only a toggle takes the eye slot
      { id: 'e', label: 'E', kind: 'colour', tab: 't', level: 'L1', get: () => '', set: () => {}, row: 'eye' },
      // @ts-expect-error a select needs its options
      { id: 'f', label: 'F', kind: 'select', tab: 't', level: 'L1', get: () => '', set: () => {} },
      // @ts-expect-error a custom field needs its renderer
      { id: 'g', label: 'G', kind: 'custom', tab: 't', level: 'L1', get: () => 0, set: () => {} },
      // @ts-expect-error L4 is not a level
      { id: 'h', label: 'H', kind: 'text', tab: 't', level: 'L4', get: () => '', set: () => {} },
      // @ts-expect-error disabled returns false or a reason, never true
      { id: 'i', label: 'I', kind: 'text', tab: 't', level: 'L1', get: () => '', set: () => {}, disabled: () => true },
      // @ts-expect-error group is only 'status'
      { id: 'j', label: 'J', kind: 'readonly', tab: 't', level: 'L1', get: () => '', group: 'misc' },
    ];
    expect(rejected).toHaveLength(10);

    // @ts-expect-error the capability record requires elog
    const caps: Capabilities = { formulas: true };
    void caps;

    // prettier-ignore
    // @ts-expect-error a row status is one of the known dots
    const row: OutlineViewModel['sections'][number]['rows'][number] = { id: 'r', kind: 'k', label: 'l', status: 'green' };
    void row;
  });
});
