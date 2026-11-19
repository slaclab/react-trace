// The drawing menu's writer derived from a drawing card's own fields
// (`schemaMenuWriters`): every tool's drawing card comes from
// `createDrawingSchema`, so Trace, Correlation and Waveform cards all name
// the drawing by its row, open it on Edit, and lock and delete it through
// the card's own Locked toggle and Delete action.
import { describe, expect, it, vi } from 'vitest';
import { BUILTIN_CATALOG } from '../catalog';
import type { AxisRef } from '../catalog/types';
import type { Annotation } from '../model';
import { createDrawingSchema, DRAWING_ITEM_KIND, type DrawingAccess } from './workbench';
import type { FieldDef, Target, ToolContext } from '../../workbench/types';
import { resolveMenu, type MenuEnv, type MenuModel } from '../../workbench/contextMenu/registry';
import { schemaMenuWriters } from '../../workbench/contextMenu/schemaWriters';

const env = (): MenuEnv => ({ copyText: vi.fn(), copyImage: vi.fn(), showPvInfo: vi.fn() });

function labels(menu: MenuModel | null): string[] {
  if (menu === null) return [];
  return menu.groups.flatMap((g, i) => [...(i > 0 ? ['|'] : []), ...g.map((it) => it.label)]);
}

const item = (menu: MenuModel | null, id: string) => menu?.groups.flat().find((i) => i.id === id);

const drawingRequest = { scope: 'drawing' as const, signals: [], drawing: 'd1' };

interface Host {
  drawings: Annotation[];
  axes: AxisRef[];
}

const access: DrawingAccess<Host> = {
  list: (state) => state.drawings,
  patch: (state, id, fn) => ({
    ...state,
    drawings: state.drawings.map((a) => (a.id === id ? fn(a) : a)),
  }),
  remove: (state, id) => ({ ...state, drawings: state.drawings.filter((a) => a.id !== id) }),
  axes: (state) => state.axes,
};

const SCHEMA = createDrawingSchema<Host, unknown>(access, { catalog: BUILTIN_CATALOG });
const FIELDS = SCHEMA.tabs.flatMap((t) => t.fields) as FieldDef<Host, unknown>[];

describe('the drawing writer from a drawing card', () => {
  function harness(a: Annotation) {
    const box: { state: Host } = { state: { drawings: [a], axes: [{ id: 'y1', name: 'Y' }] } };
    const ctx = (id: string): ToolContext<Host, unknown> => {
      const target: Target = { level: 'item', kind: DRAWING_ITEM_KIND, id };
      return {
        state: box.state,
        model: undefined,
        update: (fn) => {
          box.state = fn(box.state);
        },
        selection: null,
        target,
        capabilities: { elog: false },
        ui: {},
      };
    };
    const open = vi.fn();
    const w = schemaMenuWriters<Host, unknown, object>({
      item: (id) =>
        box.state.drawings.some((d) => d.id === id) ? { fields: FIELDS, ctx: ctx(id) } : null,
      remove: () => {},
      open,
      label: () => 'V-line 12:00:00',
    });
    return { box, w, open };
  }

  const vline: Annotation = {
    id: 'v1',
    kind: 'vline',
    points: [{ t: 1, v: 0 }],
    axisId: 'y1',
    color: '#336699',
    width: 1,
    text: '',
  };

  it('names the drawing by its row, edits by opening its card, locks and deletes through its fields', () => {
    const { box, w, open } = harness(vline);
    const menu = resolveMenu(drawingRequest, w, env());
    expect(menu).toBeNull(); // 'd1' is no row
    const req = { ...drawingRequest, drawing: 'v1' };
    const m = resolveMenu(req, w, env());
    expect(m?.header).toBe('V-line 12:00:00');
    expect(labels(m)).toEqual(['Edit', '|', 'Lock', 'Delete']);
    item(m, 'edit-drawing')?.run?.();
    expect(open).toHaveBeenCalledWith('v1');
    item(m, 'lock-drawing')?.run?.();
    expect(box.state.drawings[0].locked).toBe(true);
    const locked = resolveMenu(req, w, env());
    expect(labels(locked)).toEqual(['Edit', '|', 'Unlock', 'Delete']);
    item(locked, 'delete-drawing')?.run?.();
    expect(box.state.drawings).toEqual([]);
  });

  it('is null for an item that is no drawing', () => {
    const w = schemaMenuWriters<Host, unknown, object>({
      item: () => ({
        fields: FIELDS.filter((f) => f.id !== 'annotation-delete'),
        ctx: {} as ToolContext<Host, unknown>,
      }),
      remove: () => {},
    });
    expect(w.drawing?.('x')).toBeNull();
  });
});
