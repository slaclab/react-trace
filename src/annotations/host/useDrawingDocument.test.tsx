// @vitest-environment jsdom
//
// The drawing document adapter and the generic undo key. A small test
// app holds one record `{state, drawingHistory}` and writes it only through
// `writeApp`, as Correlation and Waveform do: the public
// `update(fn: S => S)` applies the history transform, `undo()` pops the ring
// with the `undo` tag. The hook owns no drawing list, selection or hide flag;
// it reads and writes the app's.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { StrictMode, createElement, useCallback, useLayoutEffect, useMemo, useState } from 'react';
import type { Annotation } from '../model';
import {
  popDrawingHistory,
  withDrawingHistory,
  type DrawingHistoryState,
  type HistoryTag,
} from '../history';
import { createSelectionStore, type SelectionStore } from '../../workbench/selection';
import { DEFAULT_TOOL_PREFS } from '../tools';
import { DRAWING_ITEM_KIND } from './workbench';
import { useDrawingDocument, type DrawingDocument, type DrawingUi } from './useDrawingDocument';
import { UndoKeyListener } from './UndoKeyListener';

// ── The test app ────────────────────────────────────────────────────────────

interface TestState {
  drawings: readonly Annotation[];
  title: string;
}

interface TestApp {
  state: TestState;
  drawingHistory: DrawingHistoryState;
}

const DOC = 'plot';

/** The history core sees the drawings beside the ring. */
type Tracked = DrawingHistoryState & { drawings: readonly Annotation[] };

const tracked = (app: TestApp): Tracked => ({
  ...app.drawingHistory,
  drawings: app.state.drawings,
});
const lists = (t: Tracked) => new Map([[DOC, t.drawings]]);

function line(id: string, v = 1): Annotation {
  return {
    id,
    kind: 'hline',
    points: [{ t: 0, v }],
    axisId: 'y',
    color: '#000000',
    width: 1.5,
    text: '',
  };
}

let doc: DrawingDocument;
let app: TestApp;
let update: (fn: (s: TestState) => TestState) => void;
let selection: SelectionStore;
let renders = 0;

function TestPlot({ initial }: { initial: TestState }) {
  const [record, setRecord] = useState<TestApp>(() => ({
    state: initial,
    drawingHistory: { history: new Map() },
  }));
  // The only setState call. `nowMs` is read outside the updater.
  const writeApp = useCallback((fn: (a: TestApp) => TestApp, tag?: HistoryTag) => {
    const nowMs = Date.now();
    setRecord((prev) => {
      const next = fn(prev);
      if (next === prev) return prev;
      const before = tracked(prev);
      const after = tracked(next);
      const out = withDrawingHistory(before, after, tag, nowMs, lists);
      if (out === after) return next;
      return {
        ...next,
        drawingHistory: { history: out.history, annotationMark: out.annotationMark },
      };
    });
  }, []);
  const up = useCallback(
    (fn: (s: TestState) => TestState) => writeApp((a) => ({ ...a, state: fn(a.state) })),
    [writeApp]
  );
  const undo = useCallback(
    () =>
      writeApp((a) => {
        const t = tracked(a);
        const popped = popDrawingHistory(t, DOC, (s, list) => ({ ...s, drawings: list }));
        if (popped === t) return a;
        return {
          state: { ...a.state, drawings: popped.drawings },
          drawingHistory: { history: popped.history, annotationMark: popped.annotationMark },
        };
      }, 'undo'),
    [writeApp]
  );
  const [sel] = useState(() => createSelectionStore());
  const [ui, setUi] = useState<DrawingUi & { other: number }>(() => ({ other: 7 }));
  const document = useDrawingDocument({
    list: record.state.drawings,
    update: up,
    undo,
    selection: sel,
    ui,
    setUi,
  });
  useLayoutEffect(() => {
    doc = document;
    app = record;
    update = up;
    selection = sel;
    renders++;
  });
  const uiOther = useMemo(() => ui.other, [ui]);
  return (
    <div data-other={uiOther}>
      <input data-testid="text" type="text" />
      <select data-testid="select">
        <option>a</option>
      </select>
      <UndoKeyListener onUndo={undo} />
    </div>
  );
}

function mount(initial: TestState = { drawings: [], title: 't' }, strict = false) {
  const el = createElement(TestPlot, { initial });
  return render(strict ? createElement(StrictMode, null, el) : el);
}

/** Ctrl+Z (jsdom's navigator is not a Mac) on `target`. */
function undoKey(target: Element | Document = document.body) {
  act(() => {
    fireEvent.keyDown(target, { key: 'z', ctrlKey: true });
  });
}

const ring = () => app.drawingHistory.history.get(DOC) ?? [];

let now = 1_000_000;
function at(ms: number) {
  now = ms;
  vi.setSystemTime(ms);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  at(1_000_000);
  renders = 0;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// ── commit / undo ───────────────────────────────────────────────────────────

describe('useDrawingDocument: commit and undo', () => {
  it('exposes the app list itself, never a copy', () => {
    const initial = { drawings: [line('a')], title: 't' };
    mount(initial);
    expect(doc.annotations).toBe(initial.drawings);
  });

  it('commit writes the new list through update; undo restores the previous one', () => {
    mount();
    act(() => doc.commit((list) => [...list, line('a')], 'Add line'));
    expect(doc.annotations.map((a) => a.id)).toEqual(['a']);
    expect(app.state.drawings).toBe(doc.annotations);
    expect(ring()).toHaveLength(1);

    at(now + 2000);
    act(() => doc.commit((list) => [...list, line('b')], 'Add line'));
    expect(doc.annotations.map((a) => a.id)).toEqual(['a', 'b']);

    act(() => doc.undo());
    expect(doc.annotations.map((a) => a.id)).toEqual(['a']);
    act(() => doc.undo());
    expect(doc.annotations).toEqual([]);
    expect(ring()).toHaveLength(0);
    // Nothing left: undo is a no-op, and there is no redo.
    act(() => doc.undo());
    expect(doc.annotations).toEqual([]);
    expect(doc).not.toHaveProperty('redo');
    expect(doc).not.toHaveProperty('canUndo');
  });

  it('commit hands fn the current list, so two commits in one event both land', () => {
    mount();
    act(() => {
      doc.commit((list) => [...list, line('a')], 'Add');
      doc.commit((list) => [...list, line('b')], 'Add');
    });
    expect(doc.annotations.map((a) => a.id)).toEqual(['a', 'b']);
  });

  it('the undo itself is not an undo step', () => {
    mount();
    act(() => doc.commit((list) => [...list, line('a')], 'Add'));
    act(() => doc.undo());
    expect(ring()).toHaveLength(0);
    expect(app.drawingHistory.annotationMark ?? null).toBeNull();
  });

  it('an edit made directly through update (as the Inspector does) is undoable', () => {
    mount({ drawings: [line('a', 1)], title: 't' });
    act(() =>
      update((s) => ({ ...s, drawings: s.drawings.map((a) => ({ ...a, text: 'label' })) }))
    );
    expect(doc.annotations[0].text).toBe('label');
    expect(ring()).toHaveLength(1);
    act(() => doc.undo());
    expect(doc.annotations[0].text).toBe('');
  });

  it('a settings-only update records nothing and leaves the list reference alone', () => {
    mount({ drawings: [line('a')], title: 't' });
    const before = doc.annotations;
    act(() => update((s) => ({ ...s, title: 'renamed' })));
    expect(app.state.title).toBe('renamed');
    expect(ring()).toHaveLength(0);
    expect(doc.annotations).toBe(before);
    act(() => doc.undo());
    expect(app.state.title).toBe('renamed');
    expect(doc.annotations).toBe(before);
  });

  it('coalesces writes to one drawing within 500 ms into one step', () => {
    mount({ drawings: [line('a', 1)], title: 't' });
    const edit = (v: number) =>
      act(() =>
        doc.commit(
          (list) => list.map((a) => (a.id === 'a' ? { ...a, points: [{ t: 0, v }] } : a)),
          'Move'
        )
      );
    edit(2);
    at(now + 200);
    edit(3);
    at(now + 400);
    edit(4);
    expect(ring()).toHaveLength(1);
    at(now + 600);
    edit(5);
    expect(ring()).toHaveLength(2);
    act(() => doc.undo());
    expect(doc.annotations[0].points[0].v).toBe(4);
    act(() => doc.undo());
    expect(doc.annotations[0].points[0].v).toBe(1);
  });

  it('a StrictMode double-invoked updater records one step', () => {
    mount({ drawings: [], title: 't' }, true);
    act(() => doc.commit((list) => [...list, line('a')], 'Add'));
    expect(ring()).toHaveLength(1);
    at(now + 2000);
    act(() => update((s) => ({ ...s, drawings: [...s.drawings, line('b')] })));
    expect(ring()).toHaveLength(2);
    act(() => doc.undo());
    expect(doc.annotations.map((a) => a.id)).toEqual(['a']);
    expect(ring()).toHaveLength(1);
  });
});

// ── selection ───────────────────────────────────────────────────────────────

describe('useDrawingDocument: selection', () => {
  it('reads the selected drawing from the SelectionStore', () => {
    mount({ drawings: [line('a')], title: 't' });
    expect(doc.selectedId).toBeNull();
    act(() => selection.select({ level: 'item', kind: DRAWING_ITEM_KIND, id: 'a' }));
    expect(doc.selectedId).toBe('a');
  });

  it('ignores a selection that is not an annotation item', () => {
    mount({ drawings: [line('a')], title: 't' });
    act(() => selection.select({ level: 'item', kind: 'curve', id: 'a' }));
    expect(doc.selectedId).toBeNull();
    act(() => selection.select({ level: 'section', kind: DRAWING_ITEM_KIND, id: 'a' }));
    expect(doc.selectedId).toBeNull();
  });

  it('select writes an annotation item to the store; null goes back to the tool level', () => {
    mount({ drawings: [line('a')], title: 't' });
    act(() => doc.select('a'));
    expect(selection.get().selection).toEqual({ level: 'item', kind: DRAWING_ITEM_KIND, id: 'a' });
    expect(doc.selectedId).toBe('a');
    act(() => doc.select(null));
    expect(selection.get().selection).toBeNull();
    expect(doc.selectedId).toBeNull();
  });
});

// ── hide all ────────────────────────────────────────────────────────────────

describe('useDrawingDocument: hidden', () => {
  it('reads and writes the ui record, keeping its other fields', () => {
    const { container } = mount();
    expect(doc.hidden).toBe(false);
    act(() => doc.setHidden?.(true));
    expect(doc.hidden).toBe(true);
    expect(container.firstElementChild?.getAttribute('data-other')).toBe('7');
    act(() => doc.setHidden?.(false));
    expect(doc.hidden).toBe(false);
  });

  it('setting the same value does not re-render', () => {
    mount();
    act(() => doc.setHidden?.(true));
    const count = renders;
    act(() => doc.setHidden?.(true));
    expect(renders).toBe(count);
  });
});

// ── prefs ───────────────────────────────────────────────────────────────────

describe('useDrawingDocument: prefs', () => {
  it('starts at the defaults and merges a patch', () => {
    mount();
    expect(doc.prefs).toEqual(DEFAULT_TOOL_PREFS);
    act(() => doc.setPrefs({ tool: 'hline', stay: true }));
    expect(doc.prefs).toEqual({ ...DEFAULT_TOOL_PREFS, tool: 'hline', stay: true });
    act(() => doc.setPrefs({ magnet: true }));
    expect(doc.prefs).toEqual({ tool: 'hline', stay: true, magnet: true });
  });
});

// ── document identity ───────────────────────────────────────────────────────

describe('useDrawingDocument: identity', () => {
  it('keeps the document object while nothing it exposes changed', () => {
    mount({ drawings: [line('a')], title: 't' });
    const first = doc;
    act(() => update((s) => ({ ...s, title: 'x' })));
    expect(doc).toBe(first);
    act(() => doc.commit((list) => [...list, line('b')], 'Add'));
    expect(doc).not.toBe(first);
  });
});

// ── the undo key ────────────────────────────────────────────────────────────

describe('UndoKeyListener', () => {
  it('primary+Z on the document undoes the newest drawing edit', () => {
    mount();
    act(() => doc.commit((list) => [...list, line('a')], 'Add'));
    undoKey();
    expect(doc.annotations).toEqual([]);
  });

  it('fires with focus on a select (not text entry)', () => {
    const { getByTestId } = mount();
    act(() => doc.commit((list) => [...list, line('a')], 'Add'));
    undoKey(getByTestId('select'));
    expect(doc.annotations).toEqual([]);
  });

  it('primary+Z in a text input is ignored, so the browser undoes the typing', () => {
    const { getByTestId } = mount();
    act(() => doc.commit((list) => [...list, line('a')], 'Add'));
    const input = getByTestId('text');
    let prevented = false;
    act(() => {
      prevented = !fireEvent.keyDown(input, { key: 'z', ctrlKey: true });
    });
    expect(prevented).toBe(false);
    expect(doc.annotations.map((a) => a.id)).toEqual(['a']);
  });

  it('⌘Z in a text input is ignored on a Mac', () => {
    const onUndo = vi.fn();
    const { getByTestId } = render(
      <div>
        <input data-testid="mac-text" type="text" />
        <button data-testid="mac-button" />
        <UndoKeyListener onUndo={onUndo} mac />
      </div>
    );
    act(() => {
      fireEvent.keyDown(getByTestId('mac-text'), { key: 'z', metaKey: true });
    });
    expect(onUndo).not.toHaveBeenCalled();
    act(() => {
      fireEvent.keyDown(getByTestId('mac-button'), { key: 'z', metaKey: true });
    });
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  it('prevents the default of a consumed key and skips a claimed or shifted one', () => {
    const onUndo = vi.fn();
    render(<UndoKeyListener onUndo={onUndo} />);
    let prevented = false;
    act(() => {
      prevented = !fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
    });
    expect(prevented).toBe(true);
    expect(onUndo).toHaveBeenCalledTimes(1);
    act(() => {
      fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true, shiftKey: true });
    });
    expect(onUndo).toHaveBeenCalledTimes(1);
    const claim = (e: KeyboardEvent) => e.preventDefault();
    document.addEventListener('keydown', claim, { capture: true });
    try {
      act(() => {
        fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
      });
    } finally {
      document.removeEventListener('keydown', claim, { capture: true });
    }
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  it('removes its listener on unmount and calls the latest onUndo', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender, unmount } = render(<UndoKeyListener onUndo={first} />);
    rerender(<UndoKeyListener onUndo={second} />);
    undoKey();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    unmount();
    undoKey();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('a StrictMode mount binds one listener', () => {
    const onUndo = vi.fn();
    render(createElement(StrictMode, null, createElement(UndoKeyListener, { onUndo })));
    undoKey();
    expect(onUndo).toHaveBeenCalledTimes(1);
  });
});
