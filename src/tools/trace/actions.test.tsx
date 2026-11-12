// @vitest-environment jsdom
//
// Trace's canvas actions: every action renders in the workbench's actions bar
// embedded and standalone, Post to e-log is hidden without a logbook, a
// temporarily unusable action is disabled with its reason, and each shortcut
// fires its action exactly once. Under the host bar: the bar and menu
// placements, `save` as "Export trace file" without a shortcut, the view-mode
// toggle, and Ctrl+S posting `canopy:save-view`.
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode, useState } from 'react';

import { TESTIDS } from '../../workbench/testids';
import { ActionsBar } from '../../workbench/ActionsBar';
import {
  CanvasActionsProvider,
  createActionRegistry,
  formatShortcut,
  useActionShortcuts,
  type ActionRegistry,
} from '../../workbench/useCanvasActions';
import { THEME_SHORTCUT } from '../../workbench/standardActions';
import { traceCapabilities } from './capabilities';
import {
  EXPORT_TRACE_FILE_LABEL,
  TRACE_ACTION_IDS,
  TRACE_ACTION_SPECS,
  traceActions,
  traceHostState,
  useTraceCanvasActions,
  type TraceActionHandlers,
  type TraceActionId,
  type TraceActionsOptions,
} from './actions';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function handlers(): { [K in keyof TraceActionHandlers]: Mock<() => void> } {
  return {
    refreshArchive: vi.fn<() => void>(),
    dataInsight: vi.fn<() => void>(),
    postElog: vi.fn<() => void>(),
    save: vi.fn<() => void>(),
    print: vi.fn<() => void>(),
    import: vi.fn<() => void>(),
    exportCsv: vi.fn<() => void>(),
    exportPng: vi.fn<() => void>(),
  };
}

interface Setup {
  embedded: boolean;
  elog?: boolean;
  disabled?: TraceActionsOptions['disabled'];
  /** Under the host bar (`embedded=true&hostbar=1`): the workbench binds the shortcuts but renders no bar. */
  hostBar?: boolean;
  /** The plot area's view mode (registered as the host-bar `view-mode` toggle). */
  viewMode?: TraceActionsOptions['viewMode'];
}

/** The workbench's one shortcut listener, mounted whether or not the bar renders. */
function Shortcuts({ registry, hostBar }: { registry: ActionRegistry; hostBar: boolean }) {
  useActionShortcuts(registry, { hostBar });
  return null;
}

function setup({ embedded, elog = true, disabled, hostBar = false, viewMode }: Setup) {
  const h = handlers();
  const toggleTheme = vi.fn<() => void>();
  const options: TraceActionsOptions = {
    handlers: h,
    capabilities: traceCapabilities({ elog }),
    embedded,
    theme: embedded ? undefined : { colorMode: 'light', toggle: toggleTheme },
    bugUrl: 'https://example.test/bug',
    docsUrl: 'https://example.test/docs',
    disabled,
    hostBar,
    viewMode,
  };
  function Canvas() {
    useTraceCanvasActions(options);
    return <div>canvas</div>;
  }
  const registry = createActionRegistry();
  render(
    <StrictMode>
      <CanvasActionsProvider registry={registry}>
        <Shortcuts registry={registry} hostBar={hostBar} />
        {hostBar ? null : <ActionsBar registry={registry} />}
        <Canvas />
      </CanvasActionsProvider>
    </StrictMode>
  );
  return { h, toggleTheme, registry };
}

/** Trace's own ids in the standalone / embedded bar: everything but the host-bar toggle. */
const BAR_IDS = TRACE_ACTION_IDS.filter(
  (id): id is Exclude<TraceActionId, 'view-mode'> => id !== 'view-mode'
);

function barButtons(): HTMLElement[] {
  return Array.from(screen.getByTestId(TESTIDS.actionsBar).querySelectorAll('button'));
}

/** The accessible name the bar gives an action: label plus shortcut hint. */
function nameOf(id: TraceActionId): string {
  const spec = TRACE_ACTION_SPECS[id];
  const hint = formatShortcut(spec.shortcut);
  return hint ? `${spec.label} (${hint})` : spec.label;
}

function press(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  act(() => {
    window.dispatchEvent(event);
  });
  return event;
}

const HANDLER_OF: Record<(typeof BAR_IDS)[number], keyof TraceActionHandlers> = {
  'refresh-archive': 'refreshArchive',
  'data-insight': 'dataInsight',
  'post-elog': 'postElog',
  save: 'save',
  print: 'print',
  import: 'import',
  'export-csv': 'exportCsv',
  'export-png': 'exportPng',
};

describe.each([
  ['standalone', false],
  ['embedded', true],
])('every action renders %s', (_mode, embedded) => {
  it('shows all eight Trace actions in the retired toolbar order, then the standard ones', () => {
    setup({ embedded });
    const trace = BAR_IDS.map(nameOf);
    const standard = embedded
      ? ['Report a bug', 'Docs']
      : [`Switch to dark mode (${formatShortcut(THEME_SHORTCUT)})`, 'Report a bug', 'Docs'];
    const buttons = barButtons();
    expect(buttons).toHaveLength(trace.length + standard.length);
    // Order: the retired toolbar's, Trace's own first, standard actions last.
    [...trace, ...standard].forEach((name, i) => {
      expect(screen.getByRole('button', { name }), name).toBe(buttons[i]);
    });
  });

  it('clicking each action calls its handler once', () => {
    const { h } = setup({ embedded });
    for (const id of BAR_IDS) {
      fireEvent.click(screen.getByRole('button', { name: nameOf(id) }));
      expect(h[HANDLER_OF[id]], id).toHaveBeenCalledTimes(1);
    }
  });
});

describe('Post to e-log without a logbook', () => {
  it.each([false, true])('is hidden, not disabled (embedded=%s)', (embedded) => {
    setup({ embedded, elog: false });
    expect(screen.queryByRole('button', { name: /Post to E-Log/ })).toBeNull();
    // Every other Trace action is still there.
    for (const id of BAR_IDS) {
      if (id === 'post-elog') continue;
      expect(screen.getByRole('button', { name: nameOf(id) })).toBeTruthy();
    }
  });

  it('leaves Ctrl+E to the browser when hidden', () => {
    const { h } = setup({ embedded: false, elog: false });
    const event = press({ key: 'e', code: 'KeyE', ctrlKey: true });
    expect(event.defaultPrevented).toBe(false);
    expect(h.postElog).not.toHaveBeenCalled();
  });

  it('is absent from the pure list too', () => {
    const list = traceActions({
      handlers: handlers(),
      capabilities: traceCapabilities({ elog: false }),
      embedded: false,
      bugUrl: 'b',
      docsUrl: 'd',
    });
    expect(list.map((a) => a.id)).not.toContain('post-elog');
  });
});

describe('a temporarily unusable action', () => {
  it('stays visible, disabled with its reason, and ignores click and shortcut', () => {
    const { h } = setup({ embedded: false, disabled: { 'export-png': 'No plot to export' } });
    const button = screen.getByRole('button', {
      name: `${nameOf('export-png')} — No plot to export`,
    });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(button);
    const event = press({ key: 'i', code: 'KeyI', ctrlKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect(h.exportPng).not.toHaveBeenCalled();
  });
});

/** Each shortcut and what it must fire. */
const SHORTCUTS: [string, KeyboardEventInit, keyof TraceActionHandlers | 'theme'][] = [
  ['Ctrl+S', { key: 's', code: 'KeyS', ctrlKey: true }, 'save'],
  ['Ctrl+P', { key: 'p', code: 'KeyP', ctrlKey: true }, 'print'],
  ['Ctrl+E', { key: 'e', code: 'KeyE', ctrlKey: true }, 'postElog'],
  ['Ctrl+O', { key: 'o', code: 'KeyO', ctrlKey: true }, 'import'],
  ['Ctrl+I', { key: 'i', code: 'KeyI', ctrlKey: true }, 'exportPng'],
  ['Alt+D', { key: 'd', code: 'KeyD', altKey: true }, 'dataInsight'],
  ['Alt+T', { key: 't', code: 'KeyT', altKey: true }, 'theme'],
];

describe('each shortcut fires its action once', () => {
  it.each(SHORTCUTS)('%s', (_combo, init, target) => {
    const { h, toggleTheme } = setup({ embedded: false });
    const event = press(init);
    expect(event.defaultPrevented).toBe(true);
    const fired = target === 'theme' ? toggleTheme : h[target];
    expect(fired).toHaveBeenCalledTimes(1);
    // ...and nothing else.
    const others = [
      ...Object.entries(h)
        .filter(([k]) => k !== target)
        .map(([, fn]) => fn),
      ...(target === 'theme' ? [] : [toggleTheme]),
    ];
    for (const fn of others) expect(fn).not.toHaveBeenCalled();
  });
});

describe('embedded theme shortcut', () => {
  it('Alt+T does nothing embedded: the host owns the theme', () => {
    const { toggleTheme } = setup({ embedded: true });
    const event = press({ key: 't', code: 'KeyT', altKey: true });
    expect(event.defaultPrevented).toBe(false);
    expect(toggleTheme).not.toHaveBeenCalled();
  });
});

describe('under the host bar: no bar, shortcuts still resolve against the registry', () => {
  it('renders no actions bar', () => {
    setup({ embedded: true, hostBar: true });
    expect(screen.queryByTestId(TESTIDS.actionsBar)).toBeNull();
  });

  // Ctrl+S is the host's save-view key, covered with that branch.
  const HOST_BAR_SHORTCUTS: [string, KeyboardEventInit, keyof TraceActionHandlers][] = [
    ['Ctrl+P', { key: 'p', code: 'KeyP', ctrlKey: true }, 'print'],
    ['Ctrl+O', { key: 'o', code: 'KeyO', ctrlKey: true }, 'import'],
    ['Ctrl+I', { key: 'i', code: 'KeyI', ctrlKey: true }, 'exportPng'],
    ['Alt+D', { key: 'd', code: 'KeyD', altKey: true }, 'dataInsight'],
  ];
  it.each(HOST_BAR_SHORTCUTS)(
    '%s fires its action once with the bar absent',
    (_combo, init, target) => {
      const { h } = setup({ embedded: true, hostBar: true });
      const event = press(init);
      expect(event.defaultPrevented).toBe(true);
      expect(h[target]).toHaveBeenCalledTimes(1);
      for (const [k, fn] of Object.entries(h)) if (k !== target) expect(fn).not.toHaveBeenCalled();
    }
  );
});

// ------------------------------------------------------------- host bar --

function pureList(hostBar: boolean, extra: Partial<TraceActionsOptions> = {}) {
  return traceActions({
    handlers: handlers(),
    capabilities: traceCapabilities({ elog: true }),
    embedded: true,
    hostBar,
    viewMode: { grid: false, toggle: vi.fn<() => void>() },
    bugUrl: 'b',
    docsUrl: 'd',
    ...extra,
  });
}

describe('labels and shortcuts in both modes', () => {
  it.each([
    ['standalone', false, false],
    ['embedded without the host bar', true, false],
  ])('%s: Save keeps its label and Ctrl+S; no view-mode toggle', (_mode, embedded, hostBar) => {
    const list = traceActions({
      handlers: handlers(),
      capabilities: traceCapabilities({ elog: true }),
      embedded,
      hostBar,
      viewMode: { grid: true, toggle: vi.fn<() => void>() },
      bugUrl: 'b',
      docsUrl: 'd',
    });
    const save = list.find((a) => a.id === 'save');
    expect(save?.label).toBe('Save');
    expect(save?.shortcut).toBe('primary+S');
    expect(list.map((a) => a.id)).not.toContain('view-mode');
    // Every other label and shortcut is the spec table's.
    for (const id of BAR_IDS) {
      const a = list.find((x) => x.id === id);
      expect(a?.label, id).toBe(TRACE_ACTION_SPECS[id].label);
      expect(a?.shortcut, id).toBe(TRACE_ACTION_SPECS[id].shortcut);
    }
  });

  it('under the host bar: save is "Export trace file" with no shortcut; the rest keep theirs', () => {
    const list = pureList(true);
    const save = list.find((a) => a.id === 'save');
    expect(save?.label).toBe(EXPORT_TRACE_FILE_LABEL);
    expect(EXPORT_TRACE_FILE_LABEL).toBe('Export trace file');
    expect(save).not.toHaveProperty('shortcut');
    expect(list.find((a) => a.id === 'import')?.shortcut).toBe('primary+O');
    expect(list.find((a) => a.id === 'print')?.shortcut).toBe('primary+P');
    expect(list.find((a) => a.id === 'export-png')?.shortcut).toBe('primary+I');
    expect(list.find((a) => a.id === 'post-elog')?.shortcut).toBe('primary+E');
    expect(list.find((a) => a.id === 'data-insight')?.shortcut).toBe('alt+D');
  });

  it('under the host bar: the save action still runs the trace-file download handler', () => {
    const h = handlers();
    const list = pureList(true, { handlers: h });
    list.find((a) => a.id === 'save')?.onClick();
    expect(h.save).toHaveBeenCalledTimes(1);
  });

  it('under the host bar without a view mode to toggle: no view-mode action', () => {
    expect(pureList(true, { viewMode: undefined }).map((a) => a.id)).not.toContain('view-mode');
  });
});

describe('the host placements', () => {
  /** The bar entries by order, then the menu entries (no bar) by order, as the report lists them. */
  function placementsOf(list: ReturnType<typeof traceActions>) {
    const bar = list
      .filter((a) => a.bar !== undefined)
      .sort((a, b) => a.bar!.order - b.bar!.order)
      .map((a) => [a.id, 'bar', a.label]);
    const menu = list
      .filter((a) => a.bar === undefined && a.menu !== undefined)
      .sort((a, b) => a.menu!.order - b.menu!.order)
      .map((a) => [a.id, 'menu', a.menu!.label ?? a.label]);
    return [...bar, ...menu];
  }

  it('bar: Refresh · Data Insight · Export CSV · Export PNG · Post to E-Log · Plots as grid; menu: Import… · Export trace file · Print', () => {
    expect(placementsOf(pureList(true))).toEqual([
      ['refresh-archive', 'bar', 'Refresh archive data'],
      ['data-insight', 'bar', 'Data Insight'],
      ['export-csv', 'bar', 'Export CSV'],
      ['export-png', 'bar', 'Export PNG'],
      ['post-elog', 'bar', 'Post to E-Log'],
      ['view-mode', 'bar', 'Plots as grid'],
      ['import', 'menu', 'Import…'],
      ['save', 'menu', 'Export trace file'],
      ['print', 'menu', 'Print'],
    ]);
  });

  it('omits Post to E-Log without a logbook', () => {
    const list = pureList(true, {
      capabilities: traceCapabilities({ elog: false }),
    });
    expect(placementsOf(list).map(([id]) => id)).not.toContain('post-elog');
  });
});

describe('the host-bar view-mode toggle', () => {
  it.each([
    [false, false],
    [true, true],
  ])('grid=%s → a toggle with pressed=%s', (grid, pressed) => {
    const view = pureList(true, {
      viewMode: { grid, toggle: vi.fn<() => void>() },
    }).find((a) => a.id === 'view-mode');
    expect(view?.kind).toBe('toggle');
    expect(view?.label).toBe('Plots as grid');
    expect(view?.pressed).toBe(pressed);
  });

  it('invoking it toggles the plot area mode, and the registry republishes pressed', () => {
    function Stateful() {
      const [grid, setGrid] = useState(false);
      useTraceCanvasActions({
        handlers: handlers(),
        capabilities: traceCapabilities({ elog: true }),
        embedded: true,
        hostBar: true,
        viewMode: { grid, toggle: () => setGrid((g) => !g) },
        bugUrl: 'b',
        docsUrl: 'd',
      });
      return <div data-testid="mode">{grid ? 'grid' : 'tabs'}</div>;
    }
    const registry = createActionRegistry();
    render(
      <StrictMode>
        <CanvasActionsProvider registry={registry}>
          <Stateful />
        </CanvasActionsProvider>
      </StrictMode>
    );
    const view = () => registry.getSnapshot().find((a) => a.id === 'view-mode');
    expect(view()?.pressed).toBe(false);
    act(() => view()?.onClick());
    expect(screen.getByTestId('mode').textContent).toBe('grid');
    expect(view()?.pressed).toBe(true);
    act(() => view()?.onClick());
    expect(screen.getByTestId('mode').textContent).toBe('tabs');
    expect(view()?.pressed).toBe(false);
  });

  it('never reaches the standalone bar, even with a view mode supplied', () => {
    setup({ embedded: false, viewMode: { grid: true, toggle: vi.fn<() => void>() } });
    expect(screen.queryByRole('button', { name: /Plots as grid/ })).toBeNull();
  });
});

describe('under the host bar Ctrl+S posts Save view, never the download', () => {
  it('posts {type: "canopy:save-view"} to the parent and does not call save', () => {
    const postMessage = vi.fn<(message: unknown, origin: string) => void>();
    vi.spyOn(window, 'parent', 'get').mockReturnValue({ postMessage } as unknown as Window);
    const { h } = setup({ embedded: true, hostBar: true });
    const event = press({ key: 's', code: 'KeyS', ctrlKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect(postMessage).toHaveBeenCalledWith({ type: 'canopy:save-view' }, window.location.origin);
    expect(h.save).not.toHaveBeenCalled();
  });

  it('standalone Ctrl+S still downloads and posts nothing', () => {
    const postMessage = vi.fn<(message: unknown, origin: string) => void>();
    vi.spyOn(window, 'parent', 'get').mockReturnValue({ postMessage } as unknown as Window);
    const { h } = setup({ embedded: false });
    press({ key: 's', code: 'KeyS', ctrlKey: true });
    expect(h.save).toHaveBeenCalledTimes(1);
    expect(postMessage).not.toHaveBeenCalled();
  });
});

describe('traceHostState (the report state)', () => {
  it.each([
    [[], '0 curves · paused'],
    [[{ traces: [{ useLive: true }] }], '1 curve · live'],
    [[{ traces: [{ useLive: false }, { useLive: true }] }], '2 curves · live'],
    [[{ traces: [{ useLive: false }] }, { traces: [{}, { useLive: false }] }], '3 curves · paused'],
  ])('%j → %s', (plots, expected) => {
    expect(traceHostState(plots)).toBe(expected);
  });
});
