// @vitest-environment jsdom
//
// Annotation undo in TraceApp. Every drawing write through the workbench
// `update` (Properties-style or Layers-style) is one undo step; a single
// drawing's writes within 500 ms coalesce; a StrictMode double updater records
// one entry; `removeAxis` is not an undo step and the next primary+Z restores
// the previous edit onto existing axes. The key is one native listener per
// document: it fires with focus on a sidebar <select> or colour input, and
// undoes that document's plot -- a detached window its own plot, the main
// window the fullscreen plot over the active one. Add plot keeps the rings,
// opening a workspace clears them.
//
// PlotArea and the workbench layout are wrapped (not replaced) so the test
// reads the plots and calls `update` while the real tree renders.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode, createElement, type ComponentProps } from 'react';
import type { Axis, Plot } from '../types';
import type { Annotation } from '../annotations/model';
import { reassignUnknownAxes, withAnnotations } from '../tools/trace/drawing/plotDrawings';
import { removeAxis } from '../tools/trace/schema/axis';
import { serializeWorkspace } from '../io/serialize';
import { WithCanopy } from '../test/canopy';

type PlotAreaProps = ComponentProps<typeof import('./PlotArea').PlotArea>;
type State = { plots: Plot[]; activePlotId: string };
type LayoutProps = { update: (fn: (s: State) => State) => void };

const { captured, pickFileMock } = vi.hoisted(() => ({
  captured: { plotArea: [] as unknown[], layout: [] as unknown[] },
  pickFileMock: vi.fn<() => Promise<File | null>>(),
}));

// The SDK calls take the connection first; the mocks see the rest.
vi.mock('@slaclab/canopy-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@slaclab/canopy-client')>()),
  fetchData: vi.fn(() => new Promise<never>(() => {})),
  fetchMetadata: vi.fn(() => new Promise<never>(() => {})),
}));

vi.mock('../io/download', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../io/download')>()),
  pickFile: pickFileMock,
}));

vi.mock('./PlotArea', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./PlotArea')>();
  const React = await import('react');
  function PlotArea(props: PlotAreaProps) {
    captured.plotArea.push(props);
    return React.createElement(actual.PlotArea, props);
  }
  return { ...actual, PlotArea };
});

vi.mock('../workbench/WorkbenchLayout', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workbench/WorkbenchLayout')>();
  const React = await import('react');
  function WorkbenchLayout(props: ComponentProps<typeof actual.WorkbenchLayout>) {
    captured.layout.push(props);
    return React.createElement(actual.WorkbenchLayout, props);
  }
  return { ...actual, WorkbenchLayout };
});

vi.mock('echarts-for-react', async () => {
  const React = await import('react');
  const fakeInstance = {
    getWidth: () => 800,
    getHeight: () => 400,
    isDisposed: () => false,
    getZr: () => ({ setCursorStyle: () => {}, on: () => {}, off: () => {} }),
    getModel: () => null,
    convertToPixel: () => 0,
    convertFromPixel: () => 0,
    getDataURL: () => '',
    getDom: () => document.createElement('div'),
    resize: () => {},
    dispatchAction: () => {},
    on: () => {},
    off: () => {},
  };
  class MockECharts extends React.Component<{ option: unknown }> {
    getEchartsInstance() {
      return fakeInstance;
    }
    render() {
      return React.createElement('div');
    }
  }
  return { default: MockECharts };
});

const T0 = Date.UTC(2026, 9, 18, 12, 0, 0);

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

class InertWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send() {}
  close() {
    this.readyState = 3;
  }
  addEventListener() {}
  removeEventListener() {}
}

beforeAll(async () => {
  await import('./TraceApp');
}, 60_000);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  captured.plotArea.length = 0;
  captured.layout.length = 0;
  pickFileMock.mockReset();
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise<Response>(() => {}))
  );
  vi.stubGlobal('WebSocket', InertWebSocket);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

async function flush(): Promise<void> {
  await act(async () => {});
}

async function mount(strict = false): Promise<void> {
  window.history.replaceState(null, '', '/trace/?pv=TEST:UNDO:PV&range=-1h');
  const { TraceApp } = await import('./TraceApp');
  const app = createElement(TraceApp);
  render(strict ? createElement(StrictMode, null, app) : app, { wrapper: WithCanopy });
  await flush();
}

const lastPlotArea = (): PlotAreaProps => captured.plotArea.at(-1) as PlotAreaProps;
const lastLayout = (): LayoutProps => captured.layout.at(-1) as LayoutProps;
const plots = (): readonly Plot[] => lastPlotArea().plots;
const plotById = (id: string): Plot => plots().find((p) => p.id === id)!;
const firstId = (): string => plots()[0].id;

function ann(id: string, axisId: string, extra: Partial<Annotation> = {}): Annotation {
  return {
    id,
    kind: 'hline',
    points: [{ t: T0, v: 1 }],
    axisId,
    color: 'red',
    width: 1.5,
    text: '',
    ...extra,
  };
}

function mapPlot(s: State, id: string, fn: (p: Plot) => Plot): State {
  return { ...s, plots: s.plots.map((p) => (p.id === id ? fn(p) : p)) };
}

/** A workbench write, `ms` after the previous one (beyond coalescing by default). */
function update(fn: (s: State) => State, ms = 1000): void {
  vi.setSystemTime(Date.now() + ms);
  act(() => lastLayout().update(fn));
}

/** Properties-style: one drawing's field patched in place. */
function patchDrawing(plotId: string, id: string, patch: Partial<Annotation>, ms?: number): void {
  update(
    (s) =>
      mapPlot(s, plotId, (p) => ({
        ...p,
        annotations: (p.annotations ?? []).map((a) => (a.id === id ? { ...a, ...patch } : a)),
      })),
    ms
  );
}

/** Drawing-style: append a drawing. */
function addDrawing(plotId: string, a: Annotation, ms?: number): void {
  update(
    (s) => mapPlot(s, plotId, (p) => ({ ...p, annotations: [...(p.annotations ?? []), a] })),
    ms
  );
}

/** Layers-style: delete a drawing. */
function deleteDrawing(plotId: string, id: string): void {
  update((s) =>
    mapPlot(s, plotId, (p) =>
      withAnnotations(
        p,
        (p.annotations ?? []).filter((a) => a.id !== id)
      )
    )
  );
}

function undoKey(target: EventTarget = document.body): void {
  // Built in this realm and dispatched directly, so it also reaches a node of
  // a detached window's document.
  const e = new KeyboardEvent('keydown', {
    key: 'z',
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    target.dispatchEvent(e);
  });
}

function addPlot(): string {
  const before = new Set(plots().map((p) => p.id));
  act(() => lastPlotArea().onAddPlot());
  return plots().find((p) => !before.has(p.id))!.id;
}

function activate(id: string): void {
  update((s) => ({ ...s, activePlotId: id }), 0);
}

describe('TraceApp annotation undo', () => {
  it('a Properties-style write and a Layers-style write each make one undo step', async () => {
    await mount();
    const id = firstId();
    const axisId = plotById(id).axes[0].id;
    addDrawing(id, ann('d1', axisId));
    patchDrawing(id, 'd1', { color: 'blue' });
    deleteDrawing(id, 'd1');
    expect(plotById(id).annotations).toBeUndefined();

    undoKey();
    expect(plotById(id).annotations).toEqual([ann('d1', axisId, { color: 'blue' })]);
    undoKey();
    expect(plotById(id).annotations).toEqual([ann('d1', axisId)]);
    undoKey();
    expect(plotById(id).annotations).toBeUndefined();
    // Nothing left: a further undo changes nothing.
    const before = plots();
    undoKey();
    expect(plots()).toBe(before);
  });

  it('coalesces a single drawing’s writes within 500 ms into one step', async () => {
    await mount();
    const id = firstId();
    const axisId = plotById(id).axes[0].id;
    addDrawing(id, ann('d1', axisId));
    patchDrawing(id, 'd1', { points: [{ t: T0, v: 2 }] });
    patchDrawing(id, 'd1', { points: [{ t: T0, v: 3 }] }, 100);
    patchDrawing(id, 'd1', { points: [{ t: T0, v: 4 }] }, 100);
    undoKey();
    expect(plotById(id).annotations).toEqual([ann('d1', axisId)]);
  });

  it('records one entry for one transition under <StrictMode>', async () => {
    await mount(true);
    const id = firstId();
    const axisId = plotById(id).axes[0].id;
    addDrawing(id, ann('d1', axisId));
    addDrawing(id, ann('d2', axisId));
    undoKey();
    expect(plotById(id).annotations).toEqual([ann('d1', axisId)]);
    undoKey();
    expect(plotById(id).annotations).toBeUndefined();
  });

  it('removeAxis is not an undo step; the next undo restores the previous edit onto live axes', async () => {
    await mount();
    const id = firstId();
    const a1 = plotById(id).axes[0];
    const a2: Axis = { ...a1, id: 'axis-undo-2', name: 'Second', orientation: 'right' };
    update((s) => mapPlot(s, id, (p) => ({ ...p, axes: [...p.axes, a2] })));
    addDrawing(id, ann('d1', a2.id));
    addDrawing(id, ann('d2', a2.id));
    // Remove the second axis; the migration is applied whether or not
    // removeAxis itself moves the drawings.
    update((s) => {
      const r = removeAxis(s, a2.id);
      return mapPlot(r, id, (p) => ({
        ...p,
        annotations: reassignUnknownAxes(p.annotations ?? [], p.axes),
      }));
    });
    expect(plotById(id).axes.map((a) => a.id)).toEqual([a1.id]);
    expect(plotById(id).annotations!.map((a) => a.axisId)).toEqual([a1.id, a1.id]);

    undoKey();
    const restored = plotById(id);
    expect(restored.annotations!.map((a) => a.id)).toEqual(['d1']);
    const live = new Set(restored.axes.map((a) => a.id));
    expect(restored.annotations!.every((a) => live.has(a.axisId))).toBe(true);
  });

  it.each([
    [
      'a sidebar <select>',
      () => {
        const el = document.createElement('select');
        el.appendChild(document.createElement('option'));
        return el;
      },
    ],
    [
      'an <input type=color>',
      () => {
        const el = document.createElement('input');
        el.type = 'color';
        return el;
      },
    ],
  ])('undoes the last write with focus on %s', async (_label, make) => {
    await mount();
    const id = firstId();
    const axisId = plotById(id).axes[0].id;
    addDrawing(id, ann('d1', axisId));
    const el = make();
    document.body.appendChild(el);
    el.focus();
    undoKey(el);
    expect(plotById(id).annotations).toBeUndefined();
    el.remove();
  });

  it('leaves primary+Z in a text input to the browser', async () => {
    await mount();
    const id = firstId();
    addDrawing(id, ann('d1', plotById(id).axes[0].id));
    const el = document.createElement('input');
    document.body.appendChild(el);
    undoKey(el);
    expect(plotById(id).annotations).toHaveLength(1);
    el.remove();
  });

  it('a detached window undoes its own plot, not the active one', async () => {
    const popupDoc = document.implementation.createHTMLDocument('popup');
    const popup = {
      document: popupDoc,
      addEventListener: () => {},
      removeEventListener: () => {},
      close: () => {},
    };
    vi.stubGlobal(
      'open',
      vi.fn(() => popup)
    );
    await mount();
    const a = firstId();
    const b = addPlot();
    activate(a);
    addDrawing(a, ann('da', plotById(a).axes[0].id));
    addDrawing(b, ann('db', plotById(b).axes[0].id));
    act(() => lastPlotArea().onDetachPlot!(b));
    await flush();
    await flush();
    expect(popupDoc.body.querySelector('span[hidden]')).not.toBeNull();

    const aBefore = plotById(a).annotations;
    undoKey(popupDoc.body);
    expect(plotById(b).annotations).toBeUndefined();
    expect(plotById(a).annotations).toBe(aBefore);
  });

  it('the main window undoes the fullscreen plot over the active one', async () => {
    await mount();
    const a = firstId();
    const b = addPlot();
    activate(a);
    addDrawing(a, ann('da', plotById(a).axes[0].id));
    addDrawing(b, ann('db', plotById(b).axes[0].id));
    act(() => lastPlotArea().onPopOutPlot(b));
    const aBefore = plotById(a).annotations;
    undoKey();
    expect(plotById(b).annotations).toBeUndefined();
    expect(plotById(a).annotations).toBe(aBefore);
  });

  it('Add plot keeps an existing ring', async () => {
    await mount();
    const a = firstId();
    addDrawing(a, ann('da', plotById(a).axes[0].id));
    addPlot();
    activate(a);
    undoKey();
    expect(plotById(a).annotations).toBeUndefined();
  });

  it('opening a workspace clears the rings', async () => {
    await mount();
    const a = firstId();
    addDrawing(a, ann('da', plotById(a).axes[0].id));
    const json = serializeWorkspace({ theme: 'dark', plots: [...plots()] });
    pickFileMock.mockResolvedValue(new File([json], 'w.trc.json', { type: 'application/json' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Import/ }));
    });
    await flush();
    await flush();
    expect(pickFileMock).toHaveBeenCalled();
    // The file reopens the same plot id, so a ring that survived would undo it.
    expect(plots().map((p) => p.id)).toEqual([a]);
    expect(plotById(a).annotations?.map((x) => x.id)).toEqual(['da']);
    undoKey();
    expect(plotById(a).annotations?.map((x) => x.id)).toEqual(['da']);
  });
});
