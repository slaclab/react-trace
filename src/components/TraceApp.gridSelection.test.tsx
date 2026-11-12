// @vitest-environment jsdom
//
// A drawing clicked in a plot that is not the active one (a grid cell, the
// fullscreen or a detached mount of a non-active plot) becomes the workbench
// selection: `onSelectAnnotation(plotId, id)` activates that plot and queues
// the select, applied after activation's selection reset so the properties
// panel opens the drawing's card and a later reconcile keeps it.
//
// PlotArea, PlotWithStatistics and the workbench layout are wrapped (not
// replaced) so the test reads their props while the real tree renders. A grid
// cell's click is its capture-phase activation followed, in the same event, by
// the overlay's select; the test drives both through the props PlotArea and
// the detached mount receive.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { createElement, type ComponentProps } from 'react';
import type { Plot } from '../types';
import type { Annotation } from '../annotations/model';
import type { SelectionStore } from '../workbench/selection';
import { DRAWING_ITEM_KIND } from '../annotations/host/workbench';
import { annotationMountProps } from './PlotArea';
import { WithCanopy } from '../test/canopy';

type PlotAreaProps = ComponentProps<typeof import('./PlotArea').PlotArea>;
type MountProps = ComponentProps<typeof import('./PlotArea').PlotWithStatistics>;
type State = { plots: Plot[]; activePlotId: string };
type LayoutProps = {
  update: (fn: (s: State) => State) => void;
  selection: SelectionStore;
  state: State;
};

const { captured } = vi.hoisted(() => ({
  captured: { plotArea: [] as unknown[], mounts: [] as unknown[], layout: [] as unknown[] },
}));

// The SDK calls take the connection first; the mocks see the rest.
vi.mock('@slaclab/canopy-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@slaclab/canopy-client')>()),
  fetchData: vi.fn(() => new Promise<never>(() => {})),
  fetchMetadata: vi.fn(() => new Promise<never>(() => {})),
}));

vi.mock('./PlotArea', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./PlotArea')>();
  const React = await import('react');
  function PlotArea(props: PlotAreaProps) {
    captured.plotArea.push(props);
    return React.createElement(actual.PlotArea, props);
  }
  function PlotWithStatistics(props: MountProps) {
    captured.mounts.push(props);
    return React.createElement(actual.PlotWithStatistics, props);
  }
  return { ...actual, PlotArea, PlotWithStatistics };
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
  captured.plotArea.length = 0;
  captured.mounts.length = 0;
  captured.layout.length = 0;
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
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

async function flush(): Promise<void> {
  await act(async () => {});
}

async function mount(): Promise<void> {
  window.history.replaceState(null, '', '/trace/?pv=TEST:GRID:SEL&range=-1h');
  const { TraceApp } = await import('./TraceApp');
  render(createElement(TraceApp), { wrapper: WithCanopy });
  await flush();
}

const lastPlotArea = (): PlotAreaProps => captured.plotArea.at(-1) as PlotAreaProps;
const lastLayout = (): LayoutProps => captured.layout.at(-1) as LayoutProps;
const plots = (): readonly Plot[] => lastPlotArea().plots;
const plotById = (id: string): Plot => plots().find((p) => p.id === id)!;
const activeId = (): string => lastPlotArea().activePlotId;
const selected = () => lastLayout().selection.get().selection;

function ann(id: string, axisId: string): Annotation {
  return {
    id,
    kind: 'hline',
    points: [{ t: T0, v: 1 }],
    axisId,
    color: 'red',
    width: 1.5,
    text: '',
  };
}

function addDrawing(plotId: string, a: Annotation): void {
  act(() =>
    lastLayout().update((s) => ({
      ...s,
      plots: s.plots.map((p) =>
        p.id === plotId ? { ...p, annotations: [...(p.annotations ?? []), a] } : p
      ),
    }))
  );
}

/** Two plots in grid view, each with one drawing; the first plot is active. */
/** The id of the properties panel's open card, if any. */
function openCard(): string | null {
  return document.querySelector('.wb-card--open')?.getAttribute('data-card-id') ?? null;
}

async function twoCellGrid(): Promise<[string, string]> {
  await mount();
  act(() => lastPlotArea().onAddPlot());
  act(() => lastPlotArea().onSetViewMode('grid'));
  const [a, b] = plots().map((p) => p.id);
  act(() => lastPlotArea().onSetActivePlot(a));
  addDrawing(a, ann('da', plotById(a).axes[0].id));
  addDrawing(b, ann('db', plotById(b).axes[0].id));
  await flush();
  expect(activeId()).toBe(a);
  return [a, b];
}

describe('TraceApp: selecting a drawing of a non-active plot', () => {
  it('a drawing clicked in the inactive grid cell is the selection, its card open', async () => {
    const [, b] = await twoCellGrid();
    // The cell's capture-phase activation and the overlay's select, one event.
    act(() => {
      const props = annotationMountProps(b, lastPlotArea());
      lastPlotArea().onSetActivePlot(b);
      props.onSelectAnnotation!('db');
    });
    await flush();
    expect(activeId()).toBe(b);
    expect(selected()).toEqual({ level: 'item', kind: DRAWING_ITEM_KIND, id: 'db' });
    expect(openCard()).toBe('db');
    // The mount of the newly active plot shows the drawing as selected.
    expect(annotationMountProps(b, lastPlotArea()).selectedAnnotationId).toBe('db');
  });

  it('the select alone activates the plot (no capture-phase activation first)', async () => {
    const [, b] = await twoCellGrid();
    act(() => annotationMountProps(b, lastPlotArea()).onSelectAnnotation!('db'));
    await flush();
    expect(activeId()).toBe(b);
    expect(selected()).toEqual({ level: 'item', kind: DRAWING_ITEM_KIND, id: 'db' });
    expect(openCard()).toBe('db');
  });

  it('a drawing of the active plot is selected at once, the active plot unchanged', async () => {
    const [a] = await twoCellGrid();
    act(() => annotationMountProps(a, lastPlotArea()).onSelectAnnotation!('da'));
    expect(selected()).toEqual({ level: 'item', kind: DRAWING_ITEM_KIND, id: 'da' });
    await flush();
    expect(activeId()).toBe(a);
    expect(selected()).toEqual({ level: 'item', kind: DRAWING_ITEM_KIND, id: 'da' });
  });

  it('deselecting from a non-active plot does not queue a stale select', async () => {
    const [a, b] = await twoCellGrid();
    act(() => annotationMountProps(a, lastPlotArea()).onSelectAnnotation!('da'));
    act(() => annotationMountProps(b, lastPlotArea()).onSelectAnnotation!(null));
    await flush();
    const s = selected();
    expect(s?.level === 'item' && s.kind === DRAWING_ITEM_KIND).toBe(false);
  });

  it('a drawing clicked in the detached mount of a non-active plot stays selected after reconcile', async () => {
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
    const [a, b] = await twoCellGrid();
    act(() => lastPlotArea().onDetachPlot!(b));
    await flush();
    await flush();
    expect(activeId()).toBe(a);
    const detached = (captured.mounts as MountProps[]).filter((m) => m.plot?.id === b).at(-1);
    expect(detached?.onSelectAnnotation).toBeTypeOf('function');
    act(() => detached!.onSelectAnnotation!('db'));
    await flush();
    expect(activeId()).toBe(b);
    // A later outline change reconciles the selection; the drawing is in the
    // now-active plot's outline, so it survives.
    addDrawing(b, ann('db2', plotById(b).axes[0].id));
    await flush();
    expect(selected()).toEqual({ level: 'item', kind: DRAWING_ITEM_KIND, id: 'db' });
    expect(openCard()).toBe('db');
  });
});
