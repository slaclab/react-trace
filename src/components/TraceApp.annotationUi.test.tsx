// @vitest-environment jsdom
//
// TraceApp's drawing channel: the `TraceUi` record it hands the workbench as
// `ui`, each plot's tool prefs, and the selected drawing derived from its
// selection store, all passed as props to every plot mount.
//
// Scoped to the selection store and the props TraceApp hands its children:
// WorkbenchLayout, PlotArea and PlotWithStatistics are wrapped (not replaced)
// so the test reads their props while the real tree renders; nothing drives
// the workbench panes. PlotArea's tab and grid mounts call its module-local
// PlotWithStatistics, so their props are read as PlotArea computes them: its
// channel props sliced by `annotationMountProps`, the one helper every mount
// site uses.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { createElement, type ComponentProps } from 'react';
import type { Plot } from '../types';
import type { TraceUi } from '../tools/trace/tool';
import type { SelectionStore } from '../workbench/selection';
import { DEFAULT_TOOL_PREFS } from '../annotations/tools';
import { annotationMountProps } from './PlotArea';
import { WithCanopy } from '../test/canopy';

type PlotAreaProps = ComponentProps<typeof import('./PlotArea').PlotArea>;
type MountProps = ComponentProps<typeof import('./PlotArea').PlotWithStatistics>;
type LayoutProps = { ui: TraceUi; selection: SelectionStore; state: { plots: Plot[] } };

const { captured } = vi.hoisted(() => ({
  captured: {
    plotArea: [] as unknown[],
    mounts: [] as unknown[],
    layout: [] as unknown[],
  },
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

// The first import of TraceApp transforms its whole module graph; do it once
// outside every test's budget.
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

async function mount(): Promise<void> {
  window.history.replaceState(null, '', '/trace/?pv=TEST:ANNOTATION:UI&range=-1h');
  vi.resetModules();
  const { TraceApp } = await import('./TraceApp');
  render(createElement(TraceApp), { wrapper: WithCanopy });
  await act(async () => {});
}

const lastPlotArea = (): PlotAreaProps => captured.plotArea.at(-1) as PlotAreaProps;
const lastLayout = (): LayoutProps => captured.layout.at(-1) as LayoutProps;
const ui = (): TraceUi => lastLayout().ui;
/** The drawing props of `plotId`'s in-window (tab or grid) mount, as PlotArea builds them. */
const mountOf = (plotId: string): ReturnType<typeof annotationMountProps> | undefined =>
  lastPlotArea().plots.some((p) => p.id === plotId)
    ? annotationMountProps(plotId, lastPlotArea())
    : undefined;
const fullscreenMount = (): MountProps | undefined =>
  (captured.mounts as MountProps[]).filter((p) => p.fullscreen === true).at(-1);

/** Two plots in grid view, so both have an in-window mount. */
function twoPlotsInGrid(): [string, string] {
  act(() => {
    lastPlotArea().onAddPlot();
  });
  act(() => {
    lastPlotArea().onSetViewMode('grid');
  });
  const [a, b] = lastPlotArea().plots.map((p) => p.id);
  return [a, b];
}

describe('TraceApp drawing channel: ui', () => {
  it('hands the workbench a TraceUi record instead of an empty one', async () => {
    await mount();
    expect(ui().annotationsHidden).toBeInstanceOf(Set);
    expect(ui().annotationsHidden.size).toBe(0);
    expect(ui().setAnnotationsHidden).toBeTypeOf('function');
    const id = lastPlotArea().plots[0].id;
    expect(mountOf(id)?.annotationsHidden).toBe(false);
  });

  it('setAnnotationsHidden flips the mount prop and changes no Plot field', async () => {
    await mount();
    const id = lastPlotArea().plots[0].id;
    const plotsBefore = lastLayout().state.plots;
    const plotBefore = plotsBefore[0];

    act(() => {
      ui().setAnnotationsHidden(id, true);
    });
    expect(ui().annotationsHidden.has(id)).toBe(true);
    expect(mountOf(id)?.annotationsHidden).toBe(true);
    expect(lastPlotArea().annotationsHiddenPlotIds?.has(id)).toBe(true);
    // Session-only: the plot list and the plot are the very same objects.
    expect(lastLayout().state.plots).toBe(plotsBefore);
    expect(lastLayout().state.plots[0]).toBe(plotBefore);
    expect(lastPlotArea().plots[0]).toBe(plotBefore);

    act(() => {
      ui().setAnnotationsHidden(id, false);
    });
    expect(ui().annotationsHidden.has(id)).toBe(false);
    expect(mountOf(id)?.annotationsHidden).toBe(false);
    expect(lastLayout().state.plots[0]).toBe(plotBefore);
  });

  it('hides only the named plot, in grid view', async () => {
    await mount();
    const [a, b] = twoPlotsInGrid();
    act(() => {
      ui().setAnnotationsHidden(b, true);
    });
    expect(mountOf(a)?.annotationsHidden).toBe(false);
    expect(mountOf(b)?.annotationsHidden).toBe(true);
  });

  it('a re-render with unchanged hidden state passes the same ui identity', async () => {
    await mount();
    const id = lastPlotArea().plots[0].id;
    act(() => {
      ui().setAnnotationsHidden(id, true);
    });
    const before = ui();
    const layoutsBefore = captured.layout.length;

    // An unrelated TraceApp state change re-renders it.
    act(() => {
      lastPlotArea().onSetViewMode('grid');
    });
    expect(captured.layout.length).toBeGreaterThan(layoutsBefore);
    expect(ui()).toBe(before);

    // A no-op write (already hidden) keeps the record too.
    act(() => {
      ui().setAnnotationsHidden(id, true);
    });
    expect(ui()).toBe(before);
    // The setter itself is stable across a real change.
    act(() => {
      ui().setAnnotationsHidden(id, false);
    });
    expect(ui()).not.toBe(before);
    expect(ui().setAnnotationsHidden).toBe(before.setAnnotationsHidden);
  });

  it('the fullscreen mount carries the same hidden state', async () => {
    await mount();
    const id = lastPlotArea().plots[0].id;
    act(() => {
      lastPlotArea().onPopOutPlot(id);
    });
    expect(fullscreenMount()?.annotationsHidden).toBe(false);
    act(() => {
      ui().setAnnotationsHidden(id, true);
    });
    expect(fullscreenMount()?.annotationsHidden).toBe(true);
    expect(fullscreenMount()?.annotationPrefs).toEqual(DEFAULT_TOOL_PREFS);
    expect(fullscreenMount()?.onAnnotationPrefs).toBeTypeOf('function');
    expect(fullscreenMount()?.onSelectAnnotation).toBeTypeOf('function');
  });
});

describe('TraceApp drawing channel: annotationPrefs', () => {
  it('every mount starts with the default prefs', async () => {
    await mount();
    const [a, b] = twoPlotsInGrid();
    expect(mountOf(a)?.annotationPrefs).toEqual(DEFAULT_TOOL_PREFS);
    expect(mountOf(b)?.annotationPrefs).toEqual(DEFAULT_TOOL_PREFS);
  });

  it('a prefs patch touches only that plot', async () => {
    await mount();
    const [a, b] = twoPlotsInGrid();
    const plotsBefore = lastLayout().state.plots;

    act(() => {
      mountOf(a)!.onAnnotationPrefs!({ tool: 'hline' });
    });
    expect(mountOf(a)?.annotationPrefs).toEqual({ ...DEFAULT_TOOL_PREFS, tool: 'hline' });
    expect(mountOf(b)?.annotationPrefs).toEqual(DEFAULT_TOOL_PREFS);
    expect(lastPlotArea().annotationPrefsByPlot?.has(b)).toBe(false);

    // A second patch merges into the plot's prefs instead of replacing them.
    act(() => {
      mountOf(a)!.onAnnotationPrefs!({ stay: true });
    });
    expect(mountOf(a)?.annotationPrefs).toEqual({ tool: 'hline', stay: true, magnet: false });
    expect(mountOf(b)?.annotationPrefs).toEqual(DEFAULT_TOOL_PREFS);
    // Prefs are session-only: no Plot changes.
    expect(lastLayout().state.plots).toBe(plotsBefore);
  });

  it('the fullscreen mount writes the same plot prefs as the in-window one', async () => {
    await mount();
    const id = lastPlotArea().plots[0].id;
    act(() => {
      lastPlotArea().onPopOutPlot(id);
    });
    act(() => {
      fullscreenMount()!.onAnnotationPrefs!({ magnet: true });
    });
    expect(fullscreenMount()?.annotationPrefs).toEqual({ ...DEFAULT_TOOL_PREFS, magnet: true });
    expect(mountOf(id)?.annotationPrefs).toEqual({ ...DEFAULT_TOOL_PREFS, magnet: true });
  });
});

describe('TraceApp drawing channel: selection', () => {
  it('derives the selected drawing from the selection store', async () => {
    await mount();
    const id = lastPlotArea().plots[0].id;
    const store = lastLayout().selection;
    expect(mountOf(id)?.selectedAnnotationId).toBeNull();

    act(() => {
      store.select({ level: 'item', kind: 'annotation', id: 'annotation-1' }, 'user');
    });
    expect(mountOf(id)?.selectedAnnotationId).toBe('annotation-1');
    expect(lastPlotArea().selectedAnnotationId).toBe('annotation-1');

    // Another item kind is not a drawing.
    act(() => {
      store.select({ level: 'item', kind: 'curve', id: 'annotation-1' }, 'user');
    });
    expect(mountOf(id)?.selectedAnnotationId).toBeNull();

    // Nor is a section.
    act(() => {
      store.select({ level: 'section', kind: 'axis', id: 'annotation-1' }, 'user');
    });
    expect(mountOf(id)?.selectedAnnotationId).toBeNull();
  });

  it('onSelectAnnotation selects the drawing on the store as a user selection', async () => {
    await mount();
    const id = lastPlotArea().plots[0].id;
    const store = lastLayout().selection;
    const reveals = store.get().revealCount;

    act(() => {
      mountOf(id)!.onSelectAnnotation!('annotation-7');
    });
    expect(store.get().selection).toEqual({
      level: 'item',
      kind: 'annotation',
      id: 'annotation-7',
    });
    expect(store.get().origin).toBe('user');
    expect(store.get().revealCount).toBe(reveals + 1);
    expect(mountOf(id)?.selectedAnnotationId).toBe('annotation-7');

    act(() => {
      mountOf(id)!.onSelectAnnotation!(null);
    });
    expect(store.get().selection).toBeNull();
    expect(mountOf(id)?.selectedAnnotationId).toBeNull();
  });

  it('a selection change re-renders the mounts but not the ui record', async () => {
    await mount();
    const id = lastPlotArea().plots[0].id;
    const before = ui();
    act(() => {
      mountOf(id)!.onSelectAnnotation!('annotation-9');
    });
    expect(ui()).toBe(before);
  });
});
