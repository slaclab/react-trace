// The drawing menu (a right-click on a drawing, on the plot or on its card):
// headed by the drawing's name, it offers Edit, then Lock (Unlock while
// locked) and Delete. Its actions are offered only there, never in a signal
// or point menu.
import { describe, expect, it, vi } from 'vitest';
import {
  CONTEXT_ACTIONS,
  resolveMenu,
  type ContextMenuWriters,
  type DrawingOffer,
  type MenuEnv,
  type MenuModel,
} from './registry';

const env = (): MenuEnv => ({ copyText: vi.fn(), copyImage: vi.fn(), showPvInfo: vi.fn() });

function labels(menu: MenuModel | null): string[] {
  if (menu === null) return [];
  return menu.groups.flatMap((g, i) => [...(i > 0 ? ['|'] : []), ...g.map((it) => it.label)]);
}

const item = (menu: MenuModel | null, id: string) => menu?.groups.flat().find((i) => i.id === id);

function offer(over: Partial<DrawingOffer> = {}): DrawingOffer {
  return {
    name: 'H-line 2.35 mA',
    locked: false,
    edit: vi.fn(),
    setLocked: vi.fn(),
    remove: vi.fn(),
    ...over,
  };
}

const drawingRequest = { scope: 'drawing' as const, signals: [], drawing: 'd1' };

describe('the drawing menu', () => {
  it('is headed by the drawing’s name and offers Edit, Lock and Delete', () => {
    const o = offer();
    const menu = resolveMenu(drawingRequest, { drawing: () => o }, env());
    expect(menu?.header).toBe('H-line 2.35 mA');
    expect(labels(menu)).toEqual(['Edit', '|', 'Lock', 'Delete']);
    expect(item(menu, 'delete-drawing')?.danger).toBe(true);
    item(menu, 'edit-drawing')?.run?.();
    item(menu, 'lock-drawing')?.run?.();
    item(menu, 'delete-drawing')?.run?.();
    expect(o.edit).toHaveBeenCalledTimes(1);
    expect(o.setLocked).toHaveBeenCalledWith(true);
    expect(o.remove).toHaveBeenCalledTimes(1);
  });

  it('offers Unlock while the drawing is locked; Delete stays', () => {
    const o = offer({ locked: true });
    const menu = resolveMenu(drawingRequest, { drawing: () => o }, env());
    expect(labels(menu)).toEqual(['Edit', '|', 'Unlock', 'Delete']);
    item(menu, 'lock-drawing')?.run?.();
    expect(o.setLocked).toHaveBeenCalledWith(false);
  });

  it('opens nothing for an id that is no drawing, and leaves out what is not offered', () => {
    expect(resolveMenu(drawingRequest, { drawing: () => null }, env())).toBeNull();
    expect(resolveMenu(drawingRequest, {}, env())).toBeNull();
    const menu = resolveMenu(
      drawingRequest,
      { drawing: () => offer({ edit: undefined, setLocked: undefined }) },
      env()
    );
    expect(labels(menu)).toEqual(['Delete']);
  });

  it('its actions are offered only in the drawing scope', () => {
    const ids = ['edit-drawing', 'lock-drawing', 'delete-drawing'];
    for (const action of CONTEXT_ACTIONS) {
      expect([action.id, action.scopes.includes('drawing')]).toEqual([
        action.id,
        ids.includes(action.id),
      ]);
    }
    const w: ContextMenuWriters = { drawing: () => offer() };
    const signal = resolveMenu({ scope: 'signal', signals: [{ id: 'd1', pv: 'X' }] }, w, env());
    const point = resolveMenu(
      { scope: 'point', signals: [] },
      { ...w, resetZoom: () => ({ run: () => {} }) },
      env()
    );
    for (const menu of [signal, point]) {
      for (const id of ids) expect(item(menu, id)).toBeUndefined();
    }
  });
});
