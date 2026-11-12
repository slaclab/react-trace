// @vitest-environment jsdom
//
// WorkbenchLayout against the stub tool:
// the sidebar (the properties panel: the top block, then the plot-wide
// sections), the canvas child slot and the actions bar render together; a
// user selection from a card head opens the card; the rate rule —
// unchanged data ticks of the stub tool commit neither half of the
// panel (React Profiler) while the tool rebuilds its binding and capabilities
// every render, a change one half shows renders that half, and the binding is
// read through a latest-ref; the selection follows the outline; root Escape
// closes the open card and steps aside
// for inner consumers, card drags, dialogs and the actions bar; and the PV
// field's own Escape inside the panel.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useSyncExternalStore, type ReactNode } from 'react';
import { Add } from '@carbon/icons-react';

import {
  createStubTool,
  item,
  stubSchema,
  type StubModel,
  type StubState,
  type StubTool,
  type StubUi,
} from './__fixtures__/stubTool';
import {
  DEFAULT_ARRANGEMENT,
  type Arrangement,
  type ArrangementPatch,
  type ArrangementStore,
} from './arrangementStore';
import { createSelectionStore, type SelectionStore } from './selection';
import { TESTIDS } from './testids';
import type { Action, FieldDef, ToolBinding, ToolSchema } from './types';
import { useCanvasActions } from './useCanvasActions';
import { QUICK_OPEN, WorkbenchLayout, isQuickOpenKey } from './WorkbenchLayout';

// Wrap the real top block and plot-wide sections in Profilers: a commit
// anywhere inside either half of the panel counts.
const commits = vi.hoisted(() => ({ outline: 0, plot: 0 }));

vi.mock('./Outline', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./Outline')>();
  const { Profiler, createElement } = await import('react');
  return {
    ...actual,
    Outline: (props: Parameters<typeof actual.Outline>[0]) =>
      createElement(
        Profiler,
        { id: 'outline', onRender: () => void (commits.outline += 1) },
        createElement(actual.Outline, props)
      ),
  };
});

vi.mock('./PlotSettings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./PlotSettings')>();
  const { Profiler, createElement } = await import('react');
  return {
    ...actual,
    PlotSettings: (props: Parameters<typeof actual.PlotSettings>[0]) =>
      createElement(
        Profiler,
        { id: 'plot', onRender: () => void (commits.plot += 1) },
        createElement(actual.PlotSettings, props)
      ),
  };
});

// ---------------------------------------------------------------- harness --

type StubSchema = ToolSchema<StubState, StubModel, StubUi>;
type StubField = FieldDef<StubState, StubModel, StubUi>;

function fakeStore(initial: Partial<Arrangement> = {}): ArrangementStore & {
  writes: ArrangementPatch[];
} {
  const writes: ArrangementPatch[] = [];
  return {
    key: 'test',
    initial: { ...DEFAULT_ARRANGEMENT, ...initial },
    writes,
    write: (patch) => writes.push(patch),
    flush: () => {},
    connect: () => () => {},
  };
}

const PLOT_ACTION: Action = {
  id: 'plot-add',
  label: 'Add plot',
  icon: Add,
  kind: 'button',
  onClick: () => {},
};

function Canvas({ tick }: { tick: number }) {
  useCanvasActions([PLOT_ACTION]);
  return (
    <div data-testid="canvas">
      plot at tick {tick}
      <button type="button" data-testid="plot-button">
        plot
      </button>
    </div>
  );
}

interface HarnessOptions {
  /** Footer clicks record the render that built the binding. */
  footerRuns?: number[];
  canvas?: ReactNode;
  schema?: StubSchema;
}

/**
 * A tool page as a real mount writes it: re-render on every store change, a
 * new binding and capabilities object every render.
 */
function Harness({
  tool,
  selection,
  arrangement,
  options,
}: {
  tool: StubTool;
  selection: SelectionStore;
  arrangement: ArrangementStore;
  options: HarnessOptions;
}) {
  const state = useSyncExternalStore(tool.subscribe, tool.getState);
  const model = useSyncExternalStore(tool.subscribe, tool.getModel);
  const renderId = model.tick;
  const base = tool.definition.binding;
  const binding: ToolBinding<StubState, typeof model> = {
    ...base,
    ops: { ...base.ops },
    footer: base.footer?.map((action) => ({
      ...action,
      onClick: () => {
        options.footerRuns?.push(renderId);
        action.onClick();
      },
    })),
  };
  return (
    <WorkbenchLayout
      definition={{ schema: options.schema ?? tool.definition.schema, binding }}
      state={state}
      model={model}
      ui={tool.getUi()}
      update={tool.update}
      capabilities={{ ...tool.capabilities }}
      selection={selection}
      arrangement={arrangement}
      catalog={[]}
    >
      {options.canvas ?? <Canvas tick={model.tick} />}
    </WorkbenchLayout>
  );
}

function mount(
  options: HarnessOptions & {
    arrangement?: Partial<Arrangement>;
    reference?: string;
    selection?: SelectionStore;
  } = {}
) {
  const tool = createStubTool(
    options.reference === undefined ? {} : { state: { reference: options.reference } }
  );
  const selection = options.selection ?? createSelectionStore();
  const arrangement = fakeStore(options.arrangement);
  const utils = render(
    <Harness tool={tool} selection={selection} arrangement={arrangement} options={options} />
  );
  const properties = () => utils.container.querySelector<HTMLElement>('.wb-workbench__properties')!;
  return { ...utils, tool, selection, arrangement, properties };
}

function resetCommits() {
  commits.outline = 0;
  commits.plot = 0;
}

const rowEl = (id: string) => document.querySelector<HTMLElement>(`[data-row-id="${id}"]`)!;
const bodyOf = (id: string) =>
  document.querySelector(`[data-card-id="${id}"] .wb-card__body`) as HTMLElement | null;
const plotHead = (id: string) =>
  document.querySelector<HTMLButtonElement>(
    `.wb-plot-section[data-section="${id}"] .wb-plot-section__head`
  )!;

beforeEach(() => {
  resetCommits();
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise<Response>(() => {}))
  );
});

afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  // @dnd-kit keeps a capturing document `click` swallower for 50 ms after a drag.
  await new Promise((resolve) => setTimeout(resolve, 60));
});

// ------------------------------------------------------------ composition --

describe('composition', () => {
  it('renders the sidebar, the canvas slot and the actions bar together', () => {
    const { container } = mount();
    const root = container.querySelector('.wb-workbench')!;
    expect(root).not.toBeNull();
    const sidebar = root.querySelector('.wb-sidebar')!;
    expect(sidebar).not.toBeNull();
    // The one pane holds the panel: the top block, then the plot-wide sections.
    const panel = sidebar.querySelector<HTMLElement>(
      '.wb-sidebar__pane[data-pane="properties"] .wb-panel'
    )!;
    expect(panel).not.toBeNull();
    expect(panel.getAttribute('aria-label')).toBe('Plot properties');
    expect([...panel.children].map((c) => c.className)).toEqual(['wb-outline', 'wb-plot']);
    // The canvas is the child slot, beside the sidebar and not inside it.
    const canvas = screen.getByTestId('canvas');
    expect(canvas.closest('.wb-workbench__canvas')).not.toBeNull();
    expect(sidebar.contains(canvas)).toBe(false);
    // The canvas registered its action in the one actions bar.
    const bar = screen.getByTestId(TESTIDS.actionsBar);
    expect(root.contains(bar)).toBe(true);
    expect(within(bar).getByRole('button', { name: 'Add plot' })).toBeTruthy();
  });

  it('a user selection from a card head opens the card', () => {
    const { selection, arrangement } = mount();
    fireEvent.click(within(rowEl('b')).getByText('STUB:B'));
    expect(selection.get().selection).toEqual(item('b'));
    expect(selection.get().origin).toBe('user');
    expect(bodyOf('b')).not.toBeNull();
    expect(bodyOf('b')!.getAttribute('data-level')).toBe('item');
    expect(arrangement.writes).toEqual([]);
  });

  it('a user selection expands the rail onto the open card, without writing', () => {
    const { container, selection, arrangement } = mount({
      arrangement: { collapsed: true },
    });
    expect(container.querySelector('.wb-sidebar__rail')).not.toBeNull();
    act(() => selection.select(item('a')));
    expect(container.querySelector('.wb-sidebar__rail')).toBeNull();
    expect(bodyOf('a')).not.toBeNull();
    expect(arrangement.writes).toEqual([]);
  });

  it("reopening a card keeps its blocks' More disclosure as the panel left it", () => {
    const { selection } = mount();
    act(() => selection.select(item('a')));
    fireEvent.click(within(bodyOf('a')!).getByRole('button', { name: 'More' }));
    expect(document.getElementById('stub-gain')).not.toBeNull();
    act(() => selection.reset());
    act(() => selection.select(item('b')));
    // Remembered per item kind and block, for the panel's life.
    expect(
      within(bodyOf('b')!).getByRole('button', { name: 'More' }).getAttribute('aria-expanded')
    ).toBe('true');
    expect(document.getElementById('stub-gain')).not.toBeNull();
  });

  it('a plot-wide section keeps its open state across a selection change', () => {
    const { selection } = mount();
    fireEvent.click(plotHead('general'));
    expect(plotHead('general').getAttribute('aria-expanded')).toBe('true');
    act(() => selection.select(item('a')));
    act(() => selection.reset());
    expect(plotHead('general').getAttribute('aria-expanded')).toBe('true');
  });
});

// -------------------------------------------------------------- rate rule --

/** A card field and a tool-level field that read the model outside the outline. */
const NOTE = (id: string) => `note:${id}`;
const cardNote: StubField = {
  id: 'stub-note',
  label: 'Note',
  kind: 'readonly',
  tab: 'general',
  level: 'L2',
  get: (ctx) => ctx.model.status[NOTE(ctx.target.id)] ?? 'none',
};
const toolNote: StubField = { ...cardNote, id: 'stub-tool-note', label: 'Tool note' } as StubField;
const NOTED: StubSchema = {
  ...stubSchema,
  tool: {
    tabs: stubSchema.tool.tabs.map((tab) =>
      tab.id === 'general' ? { ...tab, fields: [...tab.fields, toolNote] } : tab
    ),
  },
  items: {
    signal: {
      tabs: stubSchema.items.signal.tabs.map((tab) =>
        tab.id === 'general' ? { ...tab, fields: [...tab.fields, cardNote] } : tab
      ),
    },
  },
};

describe('rate rule', () => {
  it('50 unchanged data ticks commit neither half (tool level)', () => {
    const { tool } = mount();
    resetCommits();
    for (let i = 0; i < 50; i++) act(() => tool.tick());
    expect(tool.getModel().tick).toBe(50);
    // The canvas child slot still renders every tick.
    expect(screen.getByTestId('canvas').textContent).toContain('plot at tick 50');
    expect(commits.outline).toBe(0);
    expect(commits.plot).toBe(0);
  });

  it('50 unchanged data ticks commit neither half with a card open', () => {
    const { tool, selection } = mount();
    act(() => selection.select(item('a')));
    resetCommits();
    for (let i = 0; i < 50; i++) act(() => tool.tick());
    expect(commits.outline).toBe(0);
    expect(commits.plot).toBe(0);
  });

  it("a change to an open card's field renders the top block, not the plot half", () => {
    const { tool, selection } = mount({ schema: NOTED });
    act(() => selection.select(item('a')));
    resetCommits();
    act(() => tool.setStatus(NOTE('a'), 'stale'));
    expect(commits.outline).toBeGreaterThan(0);
    expect(commits.plot).toBe(0);
    expect(document.getElementById('stub-note')!.textContent).toBe('stale');
  });

  it("a change to a closed card's body field renders neither half", () => {
    const { tool, selection } = mount({ schema: NOTED });
    act(() => selection.select(item('a')));
    resetCommits();
    act(() => tool.setStatus(NOTE('b'), 'stale'));
    expect(commits.outline).toBe(0);
    expect(commits.plot).toBe(0);
  });

  it('a change to a tool-level field renders the plot half, not the top block', () => {
    const { tool } = mount({ schema: NOTED });
    fireEvent.click(plotHead('general'));
    resetCommits();
    act(() => tool.setStatus(NOTE('tool'), 'stale'));
    expect(commits.plot).toBeGreaterThan(0);
    expect(commits.outline).toBe(0);
    expect(document.getElementById('stub-tool-note')!.textContent).toBe('stale');
  });

  it('a row status the top block shows still renders it', () => {
    const { tool, selection } = mount();
    act(() => selection.select(item('a')));
    resetCommits();
    act(() => tool.setStatus('a', 'stale'));
    expect(commits.outline).toBeGreaterThan(0);
    expect(document.getElementById('stub-status')!.textContent).toBe('stale');
    expect(rowEl('a').querySelector('.wb-outline-row__status--stale')).not.toBeNull();
  });

  it('a state write renders both halves', () => {
    const { tool } = mount();
    fireEvent.click(plotHead('general'));
    resetCommits();
    act(() => tool.update((s) => ({ ...s, title: 'Renamed' })));
    expect(commits.outline).toBeGreaterThan(0);
    expect(commits.plot).toBeGreaterThan(0);
    expect((document.getElementById('stub-title') as HTMLInputElement).value).toBe('Renamed');
  });

  it('a new selection renders both halves', () => {
    const { selection } = mount();
    resetCommits();
    act(() => selection.select(item('a')));
    expect(commits.outline).toBeGreaterThan(0);
    expect(commits.plot).toBeGreaterThan(0);
  });

  it('reads the binding through a latest-ref: a footer click runs the newest action', () => {
    const footerRuns: number[] = [];
    const { tool } = mount({ footerRuns });
    for (let i = 0; i < 3; i++) act(() => tool.tick());
    fireEvent.click(screen.getByRole('button', { name: /Clear all/ }));
    expect(footerRuns).toEqual([3]);
    expect(tool.calls.footer).toBe(1);
  });

  it('the selection follows the outline: a removed item falls back to its section', () => {
    const { tool, selection } = mount();
    act(() => selection.select(item('a')));
    act(() => tool.update((s) => ({ ...s, items: s.items.filter((i) => i.id !== 'a') })));
    expect(selection.get().selection).toEqual({ level: 'section', kind: 'signals', id: 'signals' });
    expect(document.querySelector('.wb-card__body')).toBeNull();
  });
});

// -------------------------------------------------------------- card drag --

function box(x: number, y: number, w: number, h: number): DOMRect {
  return {
    x,
    y,
    left: x,
    top: y,
    width: w,
    height: h,
    right: x + w,
    bottom: y + h,
    toJSON() {},
  } as DOMRect;
}

// Signals y 0..100, Locked y 100..200; card heads 30 px tall inside their section.
function rectOf(el: Element): DOMRect | null {
  if (el.matches?.('[data-section-id="signals"]')) return box(0, 0, 300, 100);
  if (el.matches?.('[data-section-id="locked"]')) return box(0, 100, 300, 100);
  if (el.matches?.('[data-row-id]')) {
    const card = el.closest('[data-card-id]')!;
    const section = card.closest('[data-section-id]')?.getAttribute('data-section-id');
    const index = Array.from(card.parentElement?.children ?? []).indexOf(card);
    return box(0, (section === 'locked' ? 100 : 0) + 30 + index * 30, 300, 30);
  }
  return null;
}

const pointer = (x: number, y: number) => ({
  clientX: x,
  clientY: y,
  isPrimary: true,
  button: 0,
  pointerId: 1,
});

/** Press on `el` and move past the 6 px activation distance. */
function press(el: Element, x: number, y: number) {
  fireEvent.pointerDown(el, pointer(x, y));
  act(() => {
    fireEvent.pointerMove(document, pointer(x, y + 3));
  });
  act(() => {
    fireEvent.pointerMove(document, pointer(x, y + 10));
  });
}
function moveTo(x: number, y: number) {
  act(() => {
    fireEvent.pointerMove(document, pointer(x, y));
  });
}
function release(x: number, y: number) {
  act(() => {
    fireEvent.pointerUp(document, pointer(x, y));
  });
}

const cardDragging = (c: HTMLElement) => c.querySelector('.wb-outline-row--dragging') !== null;

function withGeometry() {
  const original = Element.prototype.getBoundingClientRect;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return rectOf(this) ?? original.call(this);
  });
}

describe('card drag inside the layout', () => {
  beforeEach(withGeometry);

  it('moves the item and writes no arrangement', () => {
    const { container, tool, arrangement } = mount();
    press(rowEl('c'), 100, 145);
    expect(cardDragging(container)).toBe(true);
    moveTo(150, 50);
    release(150, 50);
    expect(tool.calls.move).toEqual([{ itemId: 'c', sectionId: 'signals' }]);
    expect(cardDragging(container)).toBe(false);
    expect(arrangement.writes).toEqual([]);
  });
});

// ------------------------------------------------------------ root Escape --

function escape(target: Element) {
  act(() => {
    fireEvent.keyDown(target, { key: 'Escape', code: 'Escape' });
  });
}

function focus(el: HTMLElement) {
  act(() => el.focus());
  expect(document.activeElement).toBe(el);
}

describe('root Escape closes the open card', () => {
  it('from the plot surface, focusing the panel', () => {
    const { selection, properties } = mount();
    act(() => selection.select(item('a')));
    expect(bodyOf('a')).not.toBeNull();
    const plot = screen.getByTestId('plot-button');
    focus(plot);
    escape(plot);
    expect(selection.get().selection).toBeNull();
    // A reset, not a user selection: nothing is revealed by it.
    expect(selection.get().origin).toBe('reset');
    expect(bodyOf('a')).toBeNull();
    expect(document.activeElement).toBe(properties());
  });

  it('from inside the panel (the open card head)', () => {
    const { selection, properties } = mount();
    act(() => selection.select(item('a')));
    const name = within(rowEl('a')).getByRole('button', { name: 'STUB:A' });
    focus(name);
    escape(name);
    expect(selection.get().selection).toBeNull();
    expect(bodyOf('a')).toBeNull();
    expect(document.activeElement).toBe(properties());
  });

  it('keeps the focus where it is when the sidebar is a rail', () => {
    const { selection } = mount({
      arrangement: { collapsed: true },
    });
    // An initial selection opens the card without revealing the panel.
    act(() => selection.select(item('a'), 'initial'));
    const plot = screen.getByTestId('plot-button');
    focus(plot);
    escape(plot);
    expect(selection.get().selection).toBeNull();
    expect(document.activeElement).toBe(plot);
  });
});

describe('root Escape steps aside', () => {
  it('while a card drag runs', () => {
    withGeometry();
    const { selection, container } = mount();
    act(() => selection.select(item('a'), 'initial'));
    press(rowEl('b'), 100, 75);
    expect(cardDragging(container)).toBe(true);
    escape(rowEl('b'));
    expect(selection.get().selection).toEqual(item('a'));
    // @dnd-kit's own Escape cancelled the drag.
    expect(cardDragging(container)).toBe(false);
  });

  it('inside a dialog on the plot surface', () => {
    const { selection } = mount({
      canvas: (
        <div role="dialog" aria-label="Export">
          <button type="button" data-testid="dialog-button">
            ok
          </button>
        </div>
      ),
    });
    act(() => selection.select(item('a'), 'initial'));
    const button = screen.getByTestId('dialog-button');
    focus(button);
    escape(button);
    expect(selection.get().selection).toEqual(item('a'));
    expect(document.activeElement).toBe(button);
  });

  it('on the actions bar (outside the sidebar and plot surface)', () => {
    const { selection } = mount();
    act(() => selection.select(item('a'), 'initial'));
    escape(screen.getByTestId(TESTIDS.actionsBar));
    expect(selection.get().selection).toEqual(item('a'));
  });

  it('when an inner consumer claimed the key', () => {
    const { selection } = mount({
      canvas: (
        <button type="button" data-testid="claims" onKeyDown={(e) => e.preventDefault()}>
          claims
        </button>
      ),
    });
    act(() => selection.select(item('a'), 'initial'));
    const button = screen.getByTestId('claims');
    focus(button);
    escape(button);
    expect(selection.get().selection).toEqual(item('a'));
  });

  it('a key other than Escape does nothing', () => {
    const { selection } = mount();
    act(() => selection.select(item('a'), 'initial'));
    act(() => {
      fireEvent.keyDown(screen.getByTestId('plot-button'), { key: 'Enter' });
    });
    expect(selection.get().selection).toEqual(item('a'));
  });
});

// --------------------------------------------------------- PV field Escape --

describe('PV field Escape inside the panel', () => {
  const search = vi.fn(async () => [] as string[]);

  /** An item-level PV field (the stub has one at tool level only). */
  const itemPvField: StubField = {
    id: 'stub-item-pv',
    label: 'PV name',
    kind: 'pv',
    tab: 'general',
    level: 'L1',
    search,
    get: (ctx) => ctx.state.items.find((i) => i.id === ctx.target.id)?.pv ?? '',
    set: (ctx, value) =>
      ctx.update((state) => ({
        ...state,
        items: state.items.map((i) => (i.id === ctx.target.id ? { ...i, pv: value } : i)),
      })),
  };

  /** The stub schema with a searchable reference field and an item PV field first. */
  const schema: StubSchema = {
    ...stubSchema,
    tool: {
      tabs: stubSchema.tool.tabs.map((tab) => ({
        ...tab,
        fields: tab.fields.map((f) => (f.kind === 'pv' ? { ...f, search } : f)),
      })),
    },
    items: {
      signal: {
        tabs: stubSchema.items.signal.tabs.map((tab, i) =>
          i === 0 ? { ...tab, fields: [itemPvField, ...tab.fields] } : tab
        ),
      },
    },
  };

  const itemPvInput = () => document.querySelector<HTMLInputElement>('#stub-item-pv')!;
  const referenceInput = () => document.querySelector<HTMLInputElement>('#stub-reference')!;

  async function settle(ms = 300) {
    await act(async () => {
      vi.advanceTimersByTime(ms);
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('a draft is reverted and the card stays open', async () => {
    const { selection, tool } = mount({ schema });
    act(() => selection.select(item('a')));
    const input = itemPvInput();
    expect(input.value).toBe('STUB:A');
    act(() => input.focus());
    fireEvent.change(input, { target: { value: 'STUB:HALF' } });
    await settle();
    expect(itemPvInput().value).toBe('STUB:HALF');
    escape(itemPvInput());
    await settle(0);
    expect(itemPvInput().value).toBe('STUB:A');
    expect(tool.getState().items[0].pv).toBe('STUB:A');
    expect(selection.get().selection).toEqual(item('a'));
    expect(document.activeElement).toBe(itemPvInput());
  });

  it('a second Escape after the revert closes the card', async () => {
    const { selection, tool, properties } = mount({ schema });
    act(() => selection.select(item('a')));
    act(() => itemPvInput().focus());
    fireEvent.change(itemPvInput(), { target: { value: 'STUB:HALF' } });
    await settle();
    escape(itemPvInput());
    await settle(0);
    expect(selection.get().selection).toEqual(item('a'));
    escape(itemPvInput());
    expect(selection.get().selection).toBeNull();
    expect(tool.getState().items[0].pv).toBe('STUB:A');
    expect(document.activeElement).toBe(properties());
  });

  it('a clean field keeps its PV and the key goes on up to close the card', async () => {
    const { selection, tool, properties } = mount({ schema });
    act(() => selection.select(item('a')));
    act(() => itemPvInput().focus());
    escape(itemPvInput());
    await settle(0);
    expect(tool.getState().items[0].pv).toBe('STUB:A');
    expect(selection.get().selection).toBeNull();
    expect(document.activeElement).toBe(properties());
  });

  it('a clean tool-level PV field is not cleared by Escape', async () => {
    const { selection, tool, properties } = mount({ schema, reference: 'TEST:REF:PV' });
    fireEvent.click(plotHead('general'));
    expect(referenceInput().value).toBe('TEST:REF:PV');
    act(() => referenceInput().focus());
    escape(referenceInput());
    await settle(0);
    expect(referenceInput().value).toBe('TEST:REF:PV');
    expect(tool.getState().reference).toBe('TEST:REF:PV');
    expect(selection.get().selection).toBeNull();
    expect(document.activeElement).toBe(properties());
  });
});

// ------------------------------------------------------------ quick open --
//
// Primary+K (Cmd on macOS, Ctrl elsewhere) asks the embedding workspace to
// open its quick-open palette: one `canopy:quick-open` message to the parent,
// same-origin, no payload. Never from an editable field, never when an inner
// consumer claimed the key, never standalone.

describe('quick open message (primary+K)', () => {
  let post: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    post = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {});
    window.history.replaceState(null, '', '/x/trace/trace.html?embedded=true');
  });

  afterEach(() => {
    window.history.replaceState(null, '', '/');
  });

  // jsdom's navigator.platform is not a Mac, so primary is Ctrl here.
  it('posts {type: "canopy:quick-open"} once to the parent, same-origin, and claims the key', () => {
    mount();
    const event = new window.KeyboardEvent('keydown', {
      key: 'k',
      code: 'KeyK',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      document.body.dispatchEvent(event);
    });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith({ type: 'canopy:quick-open' }, window.location.origin);
    expect(QUICK_OPEN).toBe('canopy:quick-open');
    expect(event.defaultPrevented).toBe(true);
  });

  it('fires from inside the workbench (the canvas) and with an upper-case key', () => {
    mount();
    fireEvent.keyDown(screen.getByTestId('canvas'), { key: 'K', ctrlKey: true });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('a key press renders neither half of the panel (rate rule)', () => {
    mount();
    resetCommits();
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    expect(post).toHaveBeenCalledTimes(1);
    expect(commits.outline).toBe(0);
    expect(commits.plot).toBe(0);
  });

  it('posts nothing when focus is in an input, a textarea, a select or a contenteditable', () => {
    mount();
    const input = document.createElement('input');
    const textarea = document.createElement('textarea');
    const select = document.createElement('select');
    const editable = document.createElement('div');
    editable.contentEditable = 'true';
    // jsdom does not implement isContentEditable.
    Object.defineProperty(editable, 'isContentEditable', { value: true });
    for (const el of [input, textarea, select, editable]) {
      document.body.appendChild(el);
      fireEvent.keyDown(el, { key: 'k', ctrlKey: true });
      el.remove();
    }
    expect(post).not.toHaveBeenCalled();
  });

  it('posts nothing when an inner consumer already claimed the key', () => {
    mount();
    const claim = (e: Event) => e.preventDefault();
    const canvas = screen.getByTestId('canvas');
    canvas.addEventListener('keydown', claim);
    fireEvent.keyDown(canvas, { key: 'k', ctrlKey: true });
    canvas.removeEventListener('keydown', claim);
    expect(post).not.toHaveBeenCalled();
  });

  it('posts nothing for other combinations: bare K, Shift, Alt, another letter, Meta off-Mac', () => {
    mount();
    fireEvent.keyDown(document.body, { key: 'k' });
    fireEvent.keyDown(document.body, { key: 'K', ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true, altKey: true });
    fireEvent.keyDown(document.body, { key: 'j', ctrlKey: true });
    fireEvent.keyDown(document.body, { key: 'k', metaKey: true });
    expect(post).not.toHaveBeenCalled();
  });

  it('posts nothing standalone', () => {
    window.history.replaceState(null, '', '/x/trace/trace.html');
    mount();
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    expect(post).not.toHaveBeenCalled();
  });

  it('removes the binding on unmount', () => {
    const { unmount } = mount();
    unmount();
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    expect(post).not.toHaveBeenCalled();
  });
});

describe('isQuickOpenKey', () => {
  const base = { key: 'k', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };

  it('is Cmd+K on macOS and Ctrl+K elsewhere', () => {
    expect(isQuickOpenKey({ ...base, metaKey: true }, true)).toBe(true);
    expect(isQuickOpenKey({ ...base, ctrlKey: true }, true)).toBe(false);
    expect(isQuickOpenKey({ ...base, ctrlKey: true }, false)).toBe(true);
    expect(isQuickOpenKey({ ...base, metaKey: true }, false)).toBe(false);
  });

  it('prefers the physical key code (Option layouts) and ignores Shift/Alt combos', () => {
    expect(isQuickOpenKey({ ...base, key: '˚', code: 'KeyK', metaKey: true }, true)).toBe(true);
    expect(isQuickOpenKey({ ...base, metaKey: true, shiftKey: true }, true)).toBe(false);
    expect(isQuickOpenKey({ ...base, metaKey: true, altKey: true }, true)).toBe(false);
    expect(isQuickOpenKey({ ...base, key: 'l', metaKey: true }, true)).toBe(false);
  });
});

// Under the host bar, `embedded=true&hostbar=1` hides the actions bar (the
// host draws the tool's actions) while the one shortcut listener still binds
// every registered shortcut. `embedded=true` alone keeps the bar, and so does
// an unknown flag.

describe('actions bar and shortcuts by embedding', () => {
  const fired = vi.fn<() => void>();
  const PRINT: Action = {
    id: 'print',
    label: 'Print',
    icon: Add,
    kind: 'button',
    shortcut: 'primary+P',
    onClick: () => fired(),
  };
  function ShortcutCanvas() {
    useCanvasActions([PRINT]);
    return <div data-testid="canvas">plot</div>;
  }
  function pressPrint(): KeyboardEvent {
    // jsdom's navigator.platform is not a Mac, so primary is Ctrl here.
    const event = new window.KeyboardEvent('keydown', {
      key: 'p',
      code: 'KeyP',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      window.dispatchEvent(event);
    });
    return event;
  }

  beforeEach(() => fired.mockClear());
  afterEach(() => window.history.replaceState(null, '', '/'));

  it.each([
    ['standalone', '/'],
    ['embedded=true alone', '/x/trace/trace.html?embedded=true'],
    ['an unknown flag', '/x/trace/trace.html?embedded=true&other=1'],
  ])('%s: renders the bar and binds the shortcut once', (_mode, url) => {
    window.history.replaceState(null, '', url);
    const { container } = mount({ canvas: <ShortcutCanvas /> });
    expect(screen.getByTestId(TESTIDS.actionsBar)).toBeTruthy();
    expect(container.querySelector('.wb-workbench__actions')).not.toBeNull();
    expect(pressPrint().defaultPrevented).toBe(true);
    expect(fired).toHaveBeenCalledTimes(1);
  });

  it('under the host bar: no bar, the shortcut still resolves against the registry', () => {
    window.history.replaceState(null, '', '/x/trace/trace.html?embedded=true&hostbar=1');
    const { container } = mount({ canvas: <ShortcutCanvas /> });
    expect(screen.queryByTestId(TESTIDS.actionsBar)).toBeNull();
    expect(container.querySelector('.wb-workbench__actions')).toBeNull();
    expect(pressPrint().defaultPrevented).toBe(true);
    expect(fired).toHaveBeenCalledTimes(1);
  });
});
