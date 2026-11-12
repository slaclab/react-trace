// Self-consistency of the stub fourth tool. This test checks
// only that the fixture is what the workbench tests assume it is: every field
// lives on a declared tab, every outline row and section has a schema kind,
// it carries one of each required feature, and its store, dots and ops behave.

import { describe, expect, it } from 'vitest';
import { FIELD_KINDS, type FieldDef, type ObjectSchema } from '../types';
import {
  STUB_ACTION_CAPABILITY,
  STUB_FULL_REFUSAL,
  STUB_LOCKED_REFUSAL,
  STUB_REFUSAL_ACTION,
  STUB_REFUSAL_MESSAGE,
  STUB_SIGNALS_CAPACITY,
  colourField,
  createStubTool,
  inspectField,
  item,
  labelField,
  offsetField,
  section,
  stubAutoColour,
  stubSchema,
  titleField,
  tool,
  windowField,
  type StubModel,
  type StubState,
  type StubUi,
} from './stubTool';

type Field = FieldDef<StubState, StubModel, StubUi>;

const objects = (): Array<[string, ObjectSchema<StubState, StubModel, StubUi>]> => [
  ['tool', stubSchema.tool],
  ...Object.entries(stubSchema.sections).map(
    ([k, v]) => [`section:${k}`, v] as [string, ObjectSchema<StubState, StubModel, StubUi>]
  ),
  ...Object.entries(stubSchema.items).map(
    ([k, v]) => [`item:${k}`, v] as [string, ObjectSchema<StubState, StubModel, StubUi>]
  ),
];

const allFields = (): Field[] =>
  objects().flatMap(([, schema]) => schema.tabs.flatMap((tab) => tab.fields));

const itemFields = (): Field[] =>
  Object.values(stubSchema.items).flatMap((s) => s.tabs.flatMap((t) => t.fields));

describe('stub tool schema', () => {
  it('puts every field on a tab of its own object, with unique ids per object', () => {
    for (const [name, schema] of objects()) {
      const tabIds = schema.tabs.map((t) => t.id);
      expect(new Set(tabIds).size, name).toBe(tabIds.length);
      const ids = schema.tabs.flatMap((t) => t.fields.map((f) => f.id));
      expect(new Set(ids).size, name).toBe(ids.length);
      for (const tab of schema.tabs) {
        for (const field of tab.fields) expect(field.tab, `${name} ${field.id}`).toBe(tab.id);
      }
    }
  });

  it('only uses known kinds, and dot fields carry both modified and reset', () => {
    for (const field of allFields()) {
      expect(FIELD_KINDS).toContain(field.kind);
      expect(typeof field.modified === 'function', field.id).toBe(
        typeof field.reset === 'function'
      );
    }
  });

  it('places the Code tab last on items', () => {
    for (const schema of Object.values(stubSchema.items)) {
      expect(schema.tabs.at(-1)?.id).toBe('code');
    }
  });

  it('carries one of each feature the workbench tests need', () => {
    const fields = itemFields();
    expect(fields.some((f) => f.kind === 'colour' && f.row === 'swatch')).toBe(true);
    expect(fields.some((f) => f.kind === 'toggle' && f.row === 'eye')).toBe(true);
    expect(fields.filter((f) => f.kind === 'custom')).toHaveLength(1);
    expect(fields.filter((f) => f.kind === 'action')).toHaveLength(1);
    expect(fields.filter((f) => f.group === 'status' && f.kind === 'readonly')).toHaveLength(1);
    expect(fields.some((f) => f.when !== undefined && f.kind !== 'action')).toBe(true);
    expect(fields.some((f) => f.level === 'L3')).toBe(true);
    expect(fields.some((f) => f.kind === 'select' || f.kind === 'segmented')).toBe(true);
    const general = stubSchema.tool.tabs.find((t) => t.id === 'general');
    expect(general?.summary).toBeTypeOf('function');
    expect(stubSchema.tool.tabs.at(-1)?.id).toBe('code');
  });

  it('has two sections, one with capacity, each with a header eye', () => {
    const sections = Object.entries(stubSchema.sections);
    expect(sections).toHaveLength(2);
    expect(stubSchema.sections.signals.capacity).toBe(STUB_SIGNALS_CAPACITY);
    expect(stubSchema.sections.locked.capacity).toBeUndefined();
    for (const [, s] of sections) {
      expect(s.headerField?.kind).toBe('toggle');
    }
  });

  it('keeps the L1 budget of each tab at 7 or fewer, status fields excluded', () => {
    for (const [, schema] of objects()) {
      for (const tab of schema.tabs) {
        const l1 = tab.fields.filter((f) => f.level === 'L1' && f.group !== 'status');
        expect(l1.length, tab.id).toBeLessThanOrEqual(7);
      }
    }
  });
});

describe('stub tool binding', () => {
  it('builds an outline whose sections and rows name schema kinds', () => {
    const stub = createStubTool();
    const outline = stub.definition.binding.outline(stub.getState(), stub.getModel());
    expect(outline.sections.map((s) => s.id)).toEqual(['signals', 'locked']);
    for (const s of outline.sections) {
      expect(stubSchema.sections[s.kind]).toBeDefined();
      expect(s.count).toBe(s.rows.length);
      expect(s.add?.placeholder).toBeTruthy();
      for (const row of s.rows) expect(stubSchema.items[row.kind]).toBeDefined();
    }
    expect(outline.sections[0].capacity).toBe(STUB_SIGNALS_CAPACITY);
    expect(stub.definition.binding.footer).toHaveLength(1);
  });

  it('tick pushes a new model with unchanged content and an equal outline', () => {
    const stub = createStubTool();
    let notified = 0;
    stub.subscribe(() => (notified += 1));
    const before = stub.getModel();
    const outlineBefore = stub.definition.binding.outline(stub.getState(), before);
    stub.tick();
    expect(notified).toBe(1);
    expect(stub.getModel()).not.toBe(before);
    expect(stub.getModel().status).toEqual(before.status);
    expect(stub.definition.binding.outline(stub.getState(), stub.getModel())).toEqual(
      outlineBefore
    );
  });

  it('shows row status and refusal from the model', () => {
    const stub = createStubTool();
    stub.setStatus('a', 'refused');
    const row = stub.definition.binding
      .outline(stub.getState(), stub.getModel())
      .sections[0].rows.find((r) => r.id === 'a');
    expect(row).toMatchObject({ status: 'refused', refusal: STUB_REFUSAL_MESSAGE });
  });

  it('refuses every drop into Locked and a drop into a full Signals', () => {
    const stub = createStubTool();
    const { moveRefusal, ops } = stub.definition.binding;
    expect(moveRefusal('a', 'locked')).toBe(STUB_LOCKED_REFUSAL);
    expect(moveRefusal('c', 'signals')).toBeNull();
    ops.move('a', 'locked');
    expect(stub.getState().items.find((i) => i.id === 'a')?.section).toBe('signals');
    ops.move('c', 'signals');
    expect(stub.getState().items.find((i) => i.id === 'c')?.section).toBe('signals');
    expect(stub.calls.move).toHaveLength(2);
    stub.update((s) => ({
      ...s,
      items: [...s.items, { ...s.items[0], id: 'd', pv: 'STUB:D', section: 'locked' }],
    }));
    expect(moveRefusal('d', 'signals')).toBe(STUB_FULL_REFUSAL);
  });

  it('adds, refuses duplicates and capacity, and refuses with an action', async () => {
    const stub = createStubTool();
    const { add } = stub.definition.binding.ops;
    await expect(add('signals', 'STUB:NEW')).resolves.toBeUndefined();
    expect(stub.getState().items.filter((i) => i.section === 'signals')).toHaveLength(3);
    await expect(add('signals', 'STUB:MORE')).resolves.toEqual({ message: STUB_FULL_REFUSAL });
    await expect(add('locked', 'STUB:A')).resolves.toMatchObject({
      message: expect.stringContaining('already'),
    });
    const refusal = await add('locked', 'REFUSE:X');
    expect(refusal).toMatchObject({
      message: STUB_REFUSAL_MESSAGE,
      action: { label: STUB_REFUSAL_ACTION },
    });
    refusal?.action?.onClick();
    expect(stub.calls.refusalAction).toBe(1);
    expect(stub.calls.add).toHaveLength(4);
  });

  it('holds a slow add until released, then commits it', async () => {
    const stub = createStubTool();
    let settled = false;
    const pending = stub.definition.binding.ops.add('locked', 'SLOW:X').then((r) => {
      settled = true;
      return r;
    });
    await Promise.resolve();
    expect(stub.pendingSlowAdds()).toBe(1);
    expect(settled).toBe(false);
    expect(stub.getState().items.some((i) => i.pv === 'SLOW:X')).toBe(false);
    await stub.releaseSlowAdds();
    await expect(pending).resolves.toBeUndefined();
    expect(stub.getState().items.some((i) => i.pv === 'SLOW:X')).toBe(true);
  });

  it('removes an item and counts footer clicks', () => {
    const stub = createStubTool();
    stub.definition.binding.ops.remove('b');
    expect(stub.getState().items.map((i) => i.id)).toEqual(['a', 'c']);
    stub.definition.binding.footer?.[0].onClick();
    expect(stub.calls.footer).toBe(1);
  });
});

describe('stub tool fields', () => {
  it('stampedValue colour: pinned off-palette, reset writes the slot colour', () => {
    const stub = createStubTool();
    const f = colourField;
    if (f.kind !== 'colour' || !f.modified) throw new Error('colour dot');
    expect(f.modified(stub.ctx(item('b')))).toBe(false);
    f.set(stub.ctx(item('b')), '#000000');
    expect(f.modified(stub.ctx(item('b')))).toBe(true);
    f.reset(stub.ctx(item('b')));
    expect(f.get(stub.ctx(item('b')))).toBe(stubAutoColour(1));
    expect(f.modified(stub.ctx(item('b')))).toBe(false);
  });

  it('optionalPath label and title: pinned when set, reset clears', () => {
    const stub = createStubTool();
    for (const [f, target] of [
      [labelField, item('a')],
      [titleField, tool],
    ] as const) {
      if (f.kind !== 'text' || !f.modified) throw new Error('text dot');
      expect(f.modified(stub.ctx(target))).toBe(false);
      f.set(stub.ctx(target), 'Pinned');
      expect(f.modified(stub.ctx(target))).toBe(true);
      f.reset(stub.ctx(target));
      expect(f.modified(stub.ctx(target))).toBe(false);
    }
    expect(stub.getState().title).toBeUndefined();
  });

  it('recordKey offset: pinned iff the record has the PV', () => {
    const stub = createStubTool();
    const f = offsetField;
    if (f.kind !== 'number' || !f.modified) throw new Error('offset dot');
    expect(f.modified(stub.ctx(item('a')))).toBe(false);
    f.set(stub.ctx(item('a')), 2);
    expect(stub.getState().offsets).toEqual({ 'STUB:A': 2 });
    expect(f.modified(stub.ctx(item('a')))).toBe(true);
    expect(f.modified(stub.ctx(item('b')))).toBe(false);
    f.reset(stub.ctx(item('a')));
    expect(stub.getState().offsets).toEqual({});
  });

  it('gates Window on Mode and the action row on its capability', () => {
    const stub = createStubTool();
    expect(windowField.when?.(stub.ctx(item('a')))).toBe(false);
    stub.update((s) => ({
      ...s,
      items: s.items.map((i) => (i.id === 'a' ? { ...i, mode: 'smooth' } : i)),
    }));
    expect(windowField.when?.(stub.ctx(item('a')))).toBe(true);

    expect(inspectField.when?.(stub.ctx(item('a')))).toBe(false);
    const capable = createStubTool({ capabilities: { [STUB_ACTION_CAPABILITY]: true } });
    expect(inspectField.when?.(capable.ctx(item('a')))).toBe(true);
    if (inspectField.kind !== 'action') throw new Error('action');
    inspectField.run(capable.ctx(item('a')));
    expect(capable.calls.action).toEqual(['a']);
    expect(stub.calls.action).toEqual([]);
  });

  it('reads every value field for each of its targets without throwing', () => {
    const stub = createStubTool();
    const targets = [
      [stubSchema.tool, [tool]],
      [stubSchema.sections.signals, [section('signals')]],
      [stubSchema.sections.locked, [section('locked')]],
      [stubSchema.items.signal, [item('a'), item('b'), item('c')]],
    ] as const;
    for (const [schema, list] of targets) {
      for (const target of list) {
        for (const field of schema.tabs.flatMap((t) => t.fields)) {
          if (field.kind === 'action') continue;
          expect(() => field.get(stub.ctx(target)), field.id).not.toThrow();
        }
      }
    }
  });
});
