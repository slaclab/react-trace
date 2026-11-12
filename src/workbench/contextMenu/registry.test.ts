import { describe, expect, it, vi } from 'vitest';
import {
  CONTEXT_ACTIONS,
  copyPvItem,
  menuHeader,
  resolveMenu,
  type ContextMenuWriters,
  type MenuEnv,
  type MenuModel,
  type MenuRequest,
  type MenuSignal,
} from './registry';

const A: MenuSignal = { id: 'live:A', pv: 'TEST:LONG:SIGNAL:NAME:01:WAVEFORM' };
const B: MenuSignal = { id: 'live:B', pv: 'PROBE:WF' };

function env(over: Partial<MenuEnv> = {}): MenuEnv {
  return {
    copyText: vi.fn(),
    copyImage: vi.fn(),
    showPvInfo: vi.fn(),
    ...over,
  };
}

const run = () => {};
const offer = { run };

/** Every writer a tool can wire, each offering its item. */
const ALL: ContextMenuWriters = {
  copyValue: () => ({ text: '1.5' }),
  copyShot: () => ({ text: '1\n2', label: 'Copy this shot (2 values)' }),
  copyFit: () => ({ text: 'slope 1' }),
  useAsReference: () => offer,
  snapshotReference: () => offer,
  freezeShot: () => offer,
  useAsX: () => offer,
  openIn: () => [{ label: 'Trace', run }],
  correlateAgainst: () => ({ ...offer, label: 'Correlate against TEST:B' }),
  pvInfo: async () => [],
  inspect: () => offer,
  createFormula: () => offer,
  moveTo: () => [{ label: 'Y-Axis 1', selected: true, run }],
  hide: () => ({ hidden: false, set: vi.fn() }),
  remove: () => offer,
  addHere: () => [{ label: 'Add note here', run }],
  resetZoom: () => offer,
  copyImage: () => async () => null,
  viewLink: () => 'http://x/waveform.html?pv=A',
};

/** The labels of a menu, groups separated by '|'. */
function labels(menu: MenuModel | null): string[] {
  if (menu === null) return [];
  return menu.groups.flatMap((g, i) => [...(i > 0 ? ['|'] : []), ...g.map((it) => it.label)]);
}

/** The writers each tool wires (its own; the schema ones per the tool's fields). */
const TOOLS: Record<'trace' | 'correlation' | 'waveform', ContextMenuWriters> = {
  trace: {
    copyValue: ALL.copyValue,
    openIn: ALL.openIn,
    correlateAgainst: ALL.correlateAgainst,
    pvInfo: ALL.pvInfo,
    inspect: ALL.inspect,
    createFormula: ALL.createFormula,
    moveTo: ALL.moveTo,
    hide: ALL.hide,
    remove: ALL.remove,
    addHere: ALL.addHere,
    resetZoom: ALL.resetZoom,
    copyImage: ALL.copyImage,
    viewLink: ALL.viewLink,
  },
  correlation: {
    copyFit: ALL.copyFit,
    useAsX: () => ({ ...offer, label: 'Use as X (swap with PROBE:X)' }),
    openIn: ALL.openIn,
    pvInfo: ALL.pvInfo,
    hide: ALL.hide,
    remove: ALL.remove,
    addHere: ALL.addHere,
    resetZoom: ALL.resetZoom,
    copyImage: ALL.copyImage,
    viewLink: ALL.viewLink,
  },
  waveform: {
    copyShot: ALL.copyShot,
    useAsReference: ALL.useAsReference,
    snapshotReference: ALL.snapshotReference,
    freezeShot: ALL.freezeShot,
    openIn: ALL.openIn,
    pvInfo: ALL.pvInfo,
    hide: ALL.hide,
    remove: ALL.remove,
    addHere: ALL.addHere,
    resetZoom: ALL.resetZoom,
    copyImage: ALL.copyImage,
    viewLink: ALL.viewLink,
  },
};

const signal = (s: MenuSignal = A): MenuRequest => ({ scope: 'signal', signals: [s] });
const point = (s: MenuSignal | null = A): MenuRequest => ({
  scope: 'point',
  signals: s ? [s] : [],
  reading: { header: 'element 107 · 1.000 mm · A', text: 'A\telement 107\t1.000 mm' },
});

describe('the signal menu per tool (the mock-up scenes 1, 3 and 4)', () => {
  it('Waveform', () => {
    expect(labels(resolveMenu(signal(), TOOLS.waveform, env()))).toEqual([
      'Copy PV name',
      'Copy this shot (2 values)',
      '|',
      'Use as reference',
      'Take snapshot as reference',
      '|',
      'Open in',
      'PV info…',
      '|',
      'Hide',
      'Remove',
    ]);
  });

  it('Trace', () => {
    expect(labels(resolveMenu(signal(), TOOLS.trace, env()))).toEqual([
      'Copy PV name',
      'Copy value at cursor',
      '|',
      'Open in',
      'Correlate against TEST:B',
      'PV info…',
      '|',
      'Inspect data',
      'Create formula from this curve',
      '|',
      'Move to axis',
      'Hide',
      'Remove',
    ]);
  });

  it('Correlation', () => {
    expect(labels(resolveMenu(signal(), TOOLS.correlation, env()))).toEqual([
      'Copy PV name',
      'Copy fit (slope, offset, R²)',
      '|',
      'Use as X (swap with PROBE:X)',
      'Open in',
      'PV info…',
      '|',
      'Hide',
      'Remove',
    ]);
  });
});

describe('the point menu (scene 2)', () => {
  it('Waveform: the reading, the shot, the marks, the view and sharing', () => {
    const menu = resolveMenu(point(), TOOLS.waveform, env());
    expect(menu?.header).toBe('element 107 · 1.000 mm · A');
    expect(labels(menu)).toEqual([
      'Copy reading',
      'Copy PV name',
      'Copy this shot (2 values)',
      '|',
      'Use this shot as reference',
      'Freeze this shot',
      'Add note here',
      '|',
      'Reset zoom',
      '|',
      'Copy plot as image',
      'Copy link to this view',
    ]);
  });

  it('away from every curve: no PV items', () => {
    const menu = resolveMenu(point(null), TOOLS.trace, env());
    expect(labels(menu)).not.toContain('Copy PV name');
    expect(labels(menu)).toContain('Copy reading');
  });
});

describe('placement contract (scene 7)', () => {
  // Action id → [signal, point]: where it may appear at all.
  const PLACEMENT: Record<string, [boolean, boolean]> = {
    'copy-pv': [true, true],
    'copy-value': [true, false],
    'copy-reading': [false, true],
    'open-in': [true, false],
    'pv-info': [true, false],
    'add-here': [false, true],
    'copy-image': [false, true],
    'copy-link': [false, true],
    'use-as-reference': [true, false],
    'snapshot-reference': [true, true],
    'freeze-shot': [false, true],
    'copy-shot': [true, true],
    'correlate-against': [true, false],
    'inspect-data': [true, false],
    'create-formula': [true, false],
    'use-as-x': [true, false],
    'copy-fit': [true, true],
    hide: [true, false],
    remove: [true, false],
    'move-to-axis': [true, false],
    'reset-zoom': [false, true],
  };

  it('every action is placed, and only where the table puts it', () => {
    expect(Object.keys(PLACEMENT).sort()).toEqual(CONTEXT_ACTIONS.map((a) => a.id).sort());
    for (const action of CONTEXT_ACTIONS) {
      const [inSignal, inPoint] = PLACEMENT[action.id];
      expect([action.id, action.scopes.includes('signal')]).toEqual([action.id, inSignal]);
      expect([action.id, action.scopes.includes('point')]).toEqual([action.id, inPoint]);
    }
  });

  it('an unwired action is left out: a new action reaches every tool that wires it', () => {
    const none = resolveMenu(signal(), {}, env());
    expect(labels(none)).toEqual(['Copy PV name']);
  });
});

describe('several picked rows', () => {
  it('offers only what acts on all of them; Copy PV names is one name per line', () => {
    const e = env();
    const menu = resolveMenu({ scope: 'signal', signals: [A, B] }, TOOLS.waveform, e);
    expect(menu?.header).toBe('2 signals');
    expect(labels(menu)).toEqual(['Copy PV names', '|', 'Hide', 'Remove']);
    copyPvItem(menu!)?.run?.();
    expect(e.copyText).toHaveBeenCalledWith(`${A.pv}\n${B.pv}`, '2 PV names');
  });

  it('Hide while any is shown, Show once all are hidden', () => {
    const set = vi.fn();
    const w: ContextMenuWriters = { hide: (s) => ({ hidden: s === A, set }) };
    const req: MenuRequest = { scope: 'signal', signals: [A, B] };
    const menu = resolveMenu(req, w, env());
    const hide = menu!.groups.flat().find((i) => i.id === 'hide')!;
    expect(hide.label).toBe('Hide');
    hide.run?.();
    expect(set).toHaveBeenCalledTimes(2);
    expect(set).toHaveBeenCalledWith(true);
    const allHidden = resolveMenu(req, { hide: () => ({ hidden: true, set }) }, env());
    expect(allHidden!.groups.flat().find((i) => i.id === 'hide')!.label).toBe('Show');
  });
});

describe('items', () => {
  it('Copy PV name copies the full name and names it in the toast; it carries the shortcut', () => {
    const e = env();
    const menu = resolveMenu(signal(), {}, e)!;
    const item = copyPvItem(menu)!;
    expect(item.shortcut).toMatch(/C$/);
    item.run?.();
    expect(e.copyText).toHaveBeenCalledWith(A.pv, A.pv);
  });

  it('a disabled offer shows its reason', () => {
    const menu = resolveMenu(
      signal(),
      { snapshotReference: () => ({ run, disabled: 'No live curve has data yet' }) },
      env()
    )!;
    const item = menu.groups.flat().find((i) => i.id === 'snapshot-reference')!;
    expect(item.disabled).toBe('No live curve has data yet');
  });

  it('Open in and Move to axis are submenus', () => {
    const menu = resolveMenu(signal(), TOOLS.trace, env())!;
    const items = menu.groups.flat();
    expect(items.find((i) => i.id === 'open-in')?.children?.map((c) => c.label)).toEqual(['Trace']);
    expect(items.find((i) => i.id === 'move-to-axis')?.children?.[0]).toMatchObject({
      label: 'Y-Axis 1',
      selected: true,
    });
  });

  it('PV info hands the dialog the tool’s rows', () => {
    const e = env();
    const rows = Promise.resolve([{ label: 'Units', value: 'mm' }]);
    const menu = resolveMenu(signal(), { pvInfo: () => rows }, e)!;
    menu.groups
      .flat()
      .find((i) => i.id === 'pv-info')!
      .run?.();
    expect(e.showPvInfo).toHaveBeenCalledWith(A, rows);
  });

  it('Copy link and Copy plot as image go through the host', () => {
    const e = env();
    const menu = resolveMenu(point(), TOOLS.waveform, e)!;
    const items = menu.groups.flat();
    items.find((i) => i.id === 'copy-link')!.run?.();
    expect(e.copyText).toHaveBeenCalledWith('http://x/waveform.html?pv=A', 'link');
    items.find((i) => i.id === 'copy-image')!.run?.();
    expect(e.copyImage).toHaveBeenCalledTimes(1);
  });
});

describe('menuHeader', () => {
  it('is the full PV name, the count, or the reading', () => {
    expect(menuHeader(signal())).toBe(A.pv);
    expect(menuHeader({ scope: 'signal', signals: [A, B] })).toBe('2 signals');
    expect(menuHeader(point())).toBe('element 107 · 1.000 mm · A');
  });

  it('nothing applies → no menu', () => {
    expect(resolveMenu({ scope: 'point', signals: [] }, {}, env())).toBeNull();
  });
});
