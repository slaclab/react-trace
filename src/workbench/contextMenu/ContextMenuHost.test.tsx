// @vitest-environment jsdom
// The menu host inside a real WorkbenchLayout over the stub tool: a row's
// right-click opens the signal menu headed by the PV, the schema's Hide and
// Remove act on the item, ⌘C copies the name and the toast confirms it,
// picked rows open one menu for all of them, and a row the tool does not
// name as a signal keeps the native menu.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useSyncExternalStore } from 'react';
import { createStubTool, type StubTool } from '../__fixtures__/stubTool';
import { DEFAULT_ARRANGEMENT, type ArrangementStore } from '../arrangementStore';
import { createSelectionStore } from '../selection';
import { WorkbenchLayout } from '../WorkbenchLayout';
import { useContextMenuWriters } from './context';
import type { ContextMenuWriters } from './registry';
import { TOAST_MS } from './ContextMenuHost';

const arrangement: ArrangementStore = {
  key: 'test',
  initial: DEFAULT_ARRANGEMENT,
  write: () => {},
  flush: () => {},
  connect: () => () => {},
};

function Writers({ writers }: { writers: ContextMenuWriters }) {
  useContextMenuWriters(writers);
  return null;
}

function Harness({ tool, writers }: { tool: StubTool; writers: ContextMenuWriters }) {
  const state = useSyncExternalStore(tool.subscribe, tool.getState);
  const model = useSyncExternalStore(tool.subscribe, tool.getModel);
  return (
    <WorkbenchLayout
      definition={tool.definition}
      state={state}
      model={model}
      ui={tool.getUi()}
      update={tool.update}
      capabilities={tool.capabilities}
      selection={createSelectionStore()}
      arrangement={arrangement}
      catalog={[]}
    >
      <Writers writers={writers} />
    </WorkbenchLayout>
  );
}

function mount(writers?: ContextMenuWriters) {
  const tool = createStubTool();
  const signalOf = (id: string) => {
    const it = tool.getState().items.find((i) => i.id === id);
    return it ? { id, pv: it.pv } : null;
  };
  render(<Harness tool={tool} writers={writers ?? { signalOf }} />);
  return tool;
}

const row = (id: string) => document.querySelector<HTMLElement>(`[data-row-id="${id}"]`)!;
const menu = () => document.querySelector('[data-plot-menu="context"]');
const header = () => document.querySelector('.wb-context-menu__header')?.textContent;
const item = (name: string | RegExp) => screen.getByRole('menuitem', { name });

let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise(() => {}))
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'clipboard');
});

describe('the signal menu on a Properties row', () => {
  it('opens headed by the full PV name, with the schema’s Hide and Remove', () => {
    mount();
    const event = fireEvent.contextMenu(row('a'), { clientX: 40, clientY: 50 });
    expect(event).toBe(false); // the native menu is suppressed
    expect(menu()).not.toBeNull();
    expect(header()).toBe('STUB:A');
    expect(item(/^Copy PV name/)).toBeTruthy();
    expect(item('Hide')).toBeTruthy();
    expect(item('Remove')).toBeTruthy();
  });

  it('Hide writes the item’s eye; Remove goes through the binding', () => {
    const tool = mount();
    fireEvent.contextMenu(row('a'));
    fireEvent.click(item('Hide'));
    expect(tool.getState().items.find((i) => i.id === 'a')?.visible).toBe(false);
    fireEvent.contextMenu(row('a'));
    expect(item('Show')).toBeTruthy();
    fireEvent.click(item('Remove'));
    expect(tool.calls.remove).toEqual(['a']);
  });

  it('⌘C / Ctrl+C copies the name, closes the menu and shows the toast for two seconds', async () => {
    vi.useFakeTimers();
    mount();
    fireEvent.contextMenu(row('b'));
    fireEvent.keyDown(menu()!, { key: 'c', code: 'KeyC', metaKey: true });
    expect(writeText).toHaveBeenCalledWith('STUB:B');
    expect(menu()).toBeNull();
    await act(async () => {
      await Promise.resolve();
    });
    const toast = () => document.querySelector('.wb-context-toast');
    expect(toast()?.textContent).toBe('✓Copied STUB:B');
    act(() => {
      vi.advanceTimersByTime(TOAST_MS);
    });
    expect(toast()).toBeNull();
  });

  it('picked rows open one menu for all of them', () => {
    mount();
    fireEvent.click(row('a'), { metaKey: true });
    fireEvent.click(row('b'), { ctrlKey: true });
    expect(row('a').closest('.wb-card')?.classList.contains('wb-card--picked')).toBe(true);
    fireEvent.contextMenu(row('b'));
    expect(header()).toBe('2 signals');
    fireEvent.click(item(/^Copy PV names/));
    expect(writeText).toHaveBeenCalledWith('STUB:A\nSTUB:B');
  });

  it('a plain click drops the picks; a right-click off the picks names that row alone', () => {
    mount();
    fireEvent.click(row('a'), { metaKey: true });
    fireEvent.click(row('b'), { metaKey: true });
    fireEvent.contextMenu(row('c'));
    expect(header()).toBe('STUB:C');
    fireEvent.keyDown(menu()!, { key: 'Escape' });
    fireEvent.click(row('a'));
    expect(row('a').closest('.wb-card')?.classList.contains('wb-card--picked')).toBe(false);
  });

  it('a row that is no signal keeps the native menu', () => {
    mount({ signalOf: () => null });
    const event = fireEvent.contextMenu(row('a'));
    expect(event).toBe(true);
    expect(menu()).toBeNull();
  });
});
