// @vitest-environment jsdom
//
// RangeControls at every mount site: the tab bar (active plot), each grid cell
// (that cell's plot), the fullscreen header and a detached window's title bar.
// At each, Now writes a fresh xAxis for THAT plot through its onApplyXAxis,
// returning to the last relative span the plot showed this session.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { createElement, type ComponentProps } from 'react';
import type { Plot } from '../types';
import { WithCanopy } from '../test/canopy';

type PlotAreaProps = ComponentProps<typeof import('./PlotArea').PlotArea>;

const { captured } = vi.hoisted(() => ({
  captured: { plotArea: [] as unknown[] },
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
  return { ...actual, PlotArea };
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

const T0 = Date.UTC(2026, 9, 14, 12, 0, 0);

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
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  captured.plotArea.length = 0;
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

async function mount(): Promise<void> {
  window.history.replaceState(null, '', '/trace/?pv=TEST:RANGE:CONTROLS&range=-1h');
  vi.resetModules();
  const { TraceApp } = await import('./TraceApp');
  render(createElement(TraceApp), { wrapper: WithCanopy });
  await flush();
}

const lastPlotArea = (): PlotAreaProps => captured.plotArea.at(-1) as PlotAreaProps;
const plots = (): Plot[] => lastPlotArea().plots;
const plotById = (id: string): Plot => plots().find((p) => p.id === id)!;

function addPlot(): string {
  const before = new Set(plots().map((p) => p.id));
  act(() => lastPlotArea().onAddPlot());
  return plots().find((p) => !before.has(p.id))!.id;
}

const CUSTOM: Plot['xAxis'] = {
  timeRange: 'custom',
  timeFrom: '2026-10-10T08:00',
  timeTo: '2026-10-10T09:00',
};

// The plot shows -6h (remembered as its last relative span), then a go-to-like
// custom range; Now must return it to -6h with a fresh xAxis.
async function prime(id: string): Promise<Plot['xAxis']> {
  act(() => lastPlotArea().onApplyXAxis!(id, { timeRange: '-6h' }));
  await flush();
  act(() => lastPlotArea().onApplyXAxis!(id, { ...CUSTOM }));
  await flush();
  const before = plotById(id).xAxis;
  expect(before.timeRange).toBe('custom');
  return before;
}

function clickNow(root: ParentNode, site: string, index = 0): void {
  const sites = root.querySelectorAll(`[data-range-site="${site}"]`);
  const now = sites[index]?.querySelector('[data-range-chip="now"]') as HTMLButtonElement | null;
  expect(now).not.toBeNull();
  // A native click: the detached popup's document has no defaultView, which
  // fireEvent needs to build its event.
  act(() => {
    now!.click();
  });
}

function expectFreshNow(id: string, before: Plot['xAxis']): void {
  const after = plotById(id).xAxis;
  expect(after).not.toBe(before);
  expect(after.timeRange).toBe('-6h');
}

describe('RangeControls mount sites', () => {
  it('tab bar: Now produces a fresh xAxis for the active plot', async () => {
    await mount();
    const id = plots()[0].id;
    const before = await prime(id);
    clickNow(document, 'tab');
    expectFreshNow(id, before);
  });

  it("grid: a cell's Now produces a fresh xAxis for that cell's plot only", async () => {
    await mount();
    const a = plots()[0].id;
    const b = addPlot();
    act(() => lastPlotArea().onSetViewMode('grid'));
    await flush();
    const before = await prime(b);
    const aBefore = plotById(a).xAxis;
    const cells = Array.from(document.querySelectorAll('.plot-grid__cell'));
    expect(cells).toHaveLength(2);
    const bIndex = plots().findIndex((p) => p.id === b);
    clickNow(document, 'grid', bIndex);
    expectFreshNow(b, before);
    expect(plotById(a).xAxis).toBe(aBefore);
  });

  it('fullscreen header: Now produces a fresh xAxis for the fullscreen plot', async () => {
    await mount();
    const id = plots()[0].id;
    const before = await prime(id);
    act(() => lastPlotArea().onPopOutPlot(id));
    await flush();
    clickNow(document, 'fullscreen');
    expectFreshNow(id, before);
  });

  it('detached title bar: Now produces a fresh xAxis for the detached plot', async () => {
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
    const a = plots()[0].id;
    const b = addPlot();
    const before = await prime(b);
    const aBefore = plotById(a).xAxis;
    act(() => lastPlotArea().onDetachPlot(b));
    await flush();
    await flush();
    clickNow(popupDoc, 'detached');
    expectFreshNow(b, before);
    expect(plotById(a).xAxis).toBe(aBefore);
  });
});
