// @vitest-environment jsdom
import { act, render, renderHook, screen } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import {
  SelectionProvider,
  createSelectionStore,
  resolveSelection,
  useRevealRequest,
  useResetOnChange,
  useWorkbenchSelection,
  type SelectionStore,
} from './selection';
import type { OutlineViewModel, Target } from './types';

const row = (id: string, label = id) => ({ id, kind: 'trace', label, status: 'ok' as const });

const OUTLINE: OutlineViewModel = {
  sections: [
    { id: 'y1', kind: 'axis', title: 'Y1', count: 2, rows: [row('t1', 'TEST:CURRENT'), row('t2')] },
    { id: 'y2', kind: 'axis', title: 'Y2', count: 1, rows: [row('t3')] },
  ],
};

const Y1: Target = { level: 'section', kind: 'axis', id: 'y1' };
const Y2: Target = { level: 'section', kind: 'axis', id: 'y2' };
const T1: Target = { level: 'item', kind: 'trace', id: 't1' };

function wrapper(store: SelectionStore) {
  return ({ children }: { children?: ReactNode }) => (
    <SelectionProvider store={store}>{children}</SelectionProvider>
  );
}

describe('resolveSelection', () => {
  it('keeps a present selection and falls back for removed ones', () => {
    expect(resolveSelection(OUTLINE, T1)).toBe(T1);
    expect(resolveSelection(OUTLINE, { level: 'section', kind: 'axis', id: 'y9' })).toBeNull();
    expect(resolveSelection(OUTLINE, { level: 'item', kind: 'trace', id: 'x' }, 'y2')).toEqual(Y2);
    expect(resolveSelection(OUTLINE, { level: 'item', kind: 'trace', id: 'x' }, 'y9')).toBeNull();
  });
});

describe('selection store', () => {
  it('an initial selection fills the selection without a reveal', () => {
    const store = createSelectionStore({ initial: T1 });
    const reveal = vi.fn();
    store.onReveal(reveal);
    expect(store.get()).toEqual({ selection: T1, origin: 'initial', revealCount: 0 });

    store.select(Y1, 'initial');
    expect(store.get()).toEqual({ selection: Y1, origin: 'initial', revealCount: 0 });
    expect(reveal).not.toHaveBeenCalled();
  });

  it('a user selection raises a reveal request', () => {
    const store = createSelectionStore();
    const reveal = vi.fn();
    store.onReveal(reveal);
    store.select(T1);
    expect(store.get()).toEqual({ selection: T1, origin: 'user', revealCount: 1 });
    expect(reveal).toHaveBeenCalledWith(T1);
    store.select(Y1);
    expect(store.get().revealCount).toBe(2);
    expect(reveal).toHaveBeenCalledTimes(2);
  });

  it('reset returns to the tool level without a reveal', () => {
    const store = createSelectionStore();
    store.select(T1);
    const reveal = vi.fn();
    store.onReveal(reveal);
    store.reset();
    expect(store.get()).toEqual({ selection: null, origin: 'reset', revealCount: 1 });
    expect(reveal).not.toHaveBeenCalled();
  });

  it('a removed item falls back to its section, a removed section to the tool level', () => {
    const store = createSelectionStore();
    store.reconcile(OUTLINE);
    store.select(T1);
    const reveal = vi.fn();
    store.onReveal(reveal);

    const withoutT1: OutlineViewModel = {
      ...OUTLINE,
      sections: [{ ...OUTLINE.sections[0], rows: [row('t2')] }, OUTLINE.sections[1]],
    };
    store.reconcile(withoutT1);
    expect(store.get()).toEqual({ selection: Y1, origin: 'reconcile', revealCount: 1 });

    store.reconcile({ ...OUTLINE, sections: [OUTLINE.sections[1]] });
    expect(store.get().selection).toBeNull();
    expect(reveal).not.toHaveBeenCalled();
  });

  it('a moved item falls back to the section it last lived in', () => {
    const store = createSelectionStore();
    store.reconcile(OUTLINE);
    store.select(T1);
    const moved: OutlineViewModel = {
      ...OUTLINE,
      sections: [
        { ...OUTLINE.sections[0], rows: [row('t2')] },
        { ...OUTLINE.sections[1], rows: [row('t3'), row('t1')] },
      ],
    };
    store.reconcile(moved);
    expect(store.get().selection).toBe(T1);
    store.reconcile({
      ...moved,
      sections: [moved.sections[0], { ...moved.sections[1], rows: [] }],
    });
    expect(store.get().selection).toEqual(Y2);
  });

  it('a reconcile that changes nothing does not notify', () => {
    const store = createSelectionStore();
    store.reconcile(OUTLINE);
    store.select(T1);
    const listener = vi.fn();
    store.subscribe(listener);
    store.reconcile({ ...OUTLINE });
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('useWorkbenchSelection', () => {
  it('the canvas and the panel read the same selection; a select from either is seen by both', () => {
    const store = createSelectionStore();
    store.reconcile(OUTLINE);

    function Canvas() {
      const { selection } = useWorkbenchSelection();
      return <span data-testid="canvas">{selection?.id ?? 'tool'}</span>;
    }
    function Panel() {
      const { selection, select, reset } = useWorkbenchSelection();
      return (
        <>
          <span data-testid="panel">{selection?.id ?? 'tool'}</span>
          <button onClick={() => select(Y1)}>Y1</button>
          <button onClick={() => reset()}>Close</button>
        </>
      );
    }
    render(
      <SelectionProvider store={store}>
        <Canvas />
        <Panel />
      </SelectionProvider>
    );
    expect(screen.getByTestId('canvas').textContent).toBe('tool');

    act(() => store.select(T1));
    expect(screen.getByTestId('canvas').textContent).toBe('t1');
    expect(screen.getByTestId('panel').textContent).toBe('t1');

    act(() => screen.getByRole('button', { name: 'Y1' }).click());
    expect(screen.getByTestId('canvas').textContent).toBe('y1');
    expect(store.get().origin).toBe('user');

    act(() => screen.getByRole('button', { name: 'Close' }).click());
    expect(screen.getByTestId('canvas').textContent).toBe('tool');
    expect(store.get().origin).toBe('reset');
  });

  it('throws outside a provider', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => renderHook(() => useWorkbenchSelection())).toThrow(/SelectionProvider/);
    vi.restoreAllMocks();
  });
});

describe('useRevealRequest', () => {
  it('fires on user selections only', () => {
    const store = createSelectionStore({ initial: T1 });
    const handler = vi.fn();
    renderHook(() => useRevealRequest(handler), { wrapper: wrapper(store) });
    expect(handler).not.toHaveBeenCalled();

    act(() => store.select(Y1, 'initial'));
    act(() => store.reset());
    expect(handler).not.toHaveBeenCalled();

    act(() => store.select(Y2));
    expect(handler).toHaveBeenCalledExactlyOnceWith(Y2);
  });
});

describe('useResetOnChange', () => {
  it('resets when the key changes, not on mount', () => {
    const store = createSelectionStore({ initial: T1 });
    let setPlot!: (p: string) => void;
    function Tool() {
      const [plot, set] = useState('p1');
      setPlot = set;
      useResetOnChange(plot, store);
      return null;
    }
    render(
      <SelectionProvider store={store}>
        <Tool />
      </SelectionProvider>
    );
    expect(store.get().selection).toBe(T1);

    act(() => store.select(Y1));
    act(() => setPlot('p2'));
    expect(store.get()).toMatchObject({ selection: null, origin: 'reset' });
  });
});
