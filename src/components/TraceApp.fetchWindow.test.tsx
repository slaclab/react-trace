// @vitest-environment jsdom
//
// The view window owns the visible range. A gesture's window write reaches
// every mount's `viewWindowNs` in the same render, while the archive requests,
// `statsWindowNs` and the Data Insight Tool follow `fetchWindowByPlot`, a
// purely trailing 400 ms debounce of it. A burst of writes is one `plots`
// identity change (autoscroll is written only when it changes) and one archive
// request; a new time range drops both windows and the pending timer.
//
// PlotArea and the workbench layout are wrapped (not replaced) so the test can
// call the window-write path and the workbench `update` that `onApplyXAxis`
// writes through, while the real tree renders underneath.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { createElement, type ComponentProps } from 'react';
import type { Plot } from '../types';
import type { TimeWindowNs } from '../api/time';
import { WithCanopy } from '../test/canopy';

type PlotAreaProps = ComponentProps<typeof import('./PlotArea').PlotArea>;
type LayoutProps = { update: (fn: (s: { plots: Plot[] }) => { plots: Plot[] }) => void };
type ChartOption = { xAxis: { min: number; max: number } };

const { fetchDataMock, fetchMetadataMock, captured } = vi.hoisted(() => ({
  // Never settles: every request stays in flight, so the store's dedup and
  // coverage tolerance alone decide whether a moved window refetches.
  fetchDataMock: vi.fn<(pv: string, params: { fromNs: number; toNs: number }) => Promise<never>>(
    () => new Promise<never>(() => {})
  ),
  fetchMetadataMock: vi.fn(() => new Promise<never>(() => {})),
  captured: {
    plotArea: [] as unknown[],
    layout: [] as unknown[],
    options: [] as unknown[],
  },
}));

// The SDK calls take the connection first; the mocks see the rest.
vi.mock('@slaclab/canopy-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@slaclab/canopy-client')>()),
  fetchData: (_conn: unknown, ...args: unknown[]) =>
    fetchDataMock(...(args as Parameters<typeof fetchDataMock>)),
  fetchMetadata: (_conn: unknown, ...args: unknown[]) =>
    fetchMetadataMock(...(args as Parameters<typeof fetchMetadataMock>)),
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
      captured.options.push(this.props.option);
      return React.createElement('div');
    }
  }
  return { default: MockECharts };
});

const T0 = Date.UTC(2026, 9, 14, 12, 0, 0);
const MIN_NS = 60_000 * 1_000_000;
const HOUR_MS = 3_600_000;

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
// outside every test's budget. Each test still gets fresh module instances.
beforeAll(async () => {
  await import('./TraceApp');
}, 60_000);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  fetchDataMock.mockClear();
  fetchMetadataMock.mockClear();
  captured.plotArea.length = 0;
  captured.layout.length = 0;
  captured.options.length = 0;
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

// One archive PV over the last hour. The archive store keeps module state, so
// each test imports a fresh TraceApp.
async function mount(): Promise<void> {
  window.history.replaceState(null, '', '/trace/?pv=TEST:FETCH:WINDOW&range=-1h');
  vi.resetModules();
  const { TraceApp } = await import('./TraceApp');
  render(createElement(TraceApp), { wrapper: WithCanopy });
  await flush();
}

const lastPlotArea = (): PlotAreaProps => captured.plotArea.at(-1) as PlotAreaProps;
const lastLayout = (): LayoutProps => captured.layout.at(-1) as LayoutProps;
const lastOption = (): ChartOption => captured.options.at(-1) as ChartOption;
const plotId = (): string => lastPlotArea().plots[0].id;
const nsToMs = (ns: number) => Math.round(ns / 1_000_000);

// A window a day back (far outside the opening buffer, so each would refetch
// were it not debounced), shifted by `k` minutes.
function pastWindow(k: number): TimeWindowNs {
  const toNs = (T0 - 24 * HOUR_MS) * 1_000_000 + k * MIN_NS;
  return { fromNs: toNs - 10 * MIN_NS, toNs };
}

function write(window: TimeWindowNs, opts?: { follow?: boolean }): void {
  act(() => {
    lastPlotArea().onViewWindowChange!(plotId(), window, opts);
  });
}

describe('TraceApp fetch window', () => {
  it('turns ten window commits inside 100 ms into one archive request and one plots change', async () => {
    await mount();
    expect(fetchDataMock).toHaveBeenCalled();
    fetchDataMock.mockClear();
    const before = lastPlotArea().plots;
    expect(before[0].autoScroll).not.toBe(false);
    const start = captured.plotArea.length;

    for (let k = 0; k < 10; k += 1) {
      write(pastWindow(k));
      act(() => {
        vi.advanceTimersByTime(10);
      });
    }

    const seen = new Set(
      (captured.plotArea.slice(start) as PlotAreaProps[])
        .map((p) => p.plots)
        .filter((p) => p !== before)
    );
    expect(seen.size).toBe(1);
    expect([...seen][0][0].autoScroll).toBe(false);
    expect(fetchDataMock).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(fetchDataMock).toHaveBeenCalledTimes(1);
    // The one request is for the last window written, not any earlier one.
    const params = fetchDataMock.mock.calls[0][1];
    expect(params.toNs).toBeGreaterThanOrEqual(pastWindow(9).toNs);
    expect(params.fromNs).toBeLessThanOrEqual(pastWindow(9).fromNs);
    expect(params.fromNs).toBeGreaterThan(pastWindow(0).fromNs - 24 * HOUR_MS * 1_000_000);
  });

  it('shows a written window in the same render; the stats window follows after 400 ms', async () => {
    await mount();
    const id = plotId();
    const opening = lastPlotArea().statsWindowByPlotId!.get(id)!;
    const w = pastWindow(0);

    write(w);
    // The chart already draws it: the mount's viewWindowNs is the new window.
    expect(lastPlotArea().displayWindowByPlotId.get(id)).toEqual(w);
    expect(lastOption().xAxis.min).toBe(nsToMs(w.fromNs));
    expect(lastOption().xAxis.max).toBe(nsToMs(w.toNs));
    // The stats window is still the opening range.
    expect(lastPlotArea().statsWindowByPlotId!.get(id)).toEqual(opening);

    act(() => {
      vi.advanceTimersByTime(399);
    });
    expect(lastPlotArea().statsWindowByPlotId!.get(id)).toEqual(opening);
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(lastPlotArea().statsWindowByPlotId!.get(id)).toEqual(w);
  });

  it('a new range after a pan makes the fetch window the new range in the next render', async () => {
    await mount();
    const id = plotId();
    write(pastWindow(0));
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(lastPlotArea().statsWindowByPlotId!.get(id)).toEqual(pastWindow(0));
    fetchDataMock.mockClear();

    // What onApplyXAxis does: a fresh xAxis written through the workbench update.
    act(() => {
      lastLayout().update((s) => ({
        ...s,
        plots: s.plots.map((p) => ({ ...p, xAxis: { ...p.xAxis, timeRange: '-4h' } })),
      }));
    });
    await flush();

    const now = Date.now();
    const stats = lastPlotArea().statsWindowByPlotId!.get(id)!;
    const display = lastPlotArea().displayWindowByPlotId.get(id)!;
    expect(nsToMs(stats.fromNs)).toBe(now - 4 * HOUR_MS);
    expect(display).toEqual(stats);
    expect(lastPlotArea().plots[0].autoScroll).toBe(true);
    // The archive request goes out for the new range, not the panned window.
    expect(fetchDataMock).toHaveBeenCalledTimes(1);
    const params = fetchDataMock.mock.calls[0][1];
    expect(nsToMs(params.fromNs)).toBeGreaterThan(now - 5 * HOUR_MS);
    expect(nsToMs(params.fromNs)).toBeLessThanOrEqual(now - 4 * HOUR_MS);
  });

  it('a new range cancels a pending debounce, so the panned window never fetches', async () => {
    await mount();
    const id = plotId();
    write(pastWindow(0));
    fetchDataMock.mockClear();
    act(() => {
      lastLayout().update((s) => ({
        ...s,
        plots: s.plots.map((p) => ({ ...p, xAxis: { ...p.xAxis, timeRange: '-4h' } })),
      }));
    });
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    const stats = lastPlotArea().statsWindowByPlotId!.get(id)!;
    expect(stats).not.toEqual(pastWindow(0));
    for (const [, params] of fetchDataMock.mock.calls) {
      expect(params.fromNs).not.toBe(pastWindow(0).fromNs);
      expect(nsToMs(params.fromNs)).toBeGreaterThan(Date.now() - 5 * HOUR_MS);
    }
  });

  it('a follow write records the display window and leaves autoscroll alone', async () => {
    await mount();
    const id = plotId();
    const before = lastPlotArea().plots;
    const w = pastWindow(0);
    write(w, { follow: true });
    expect(lastPlotArea().displayWindowByPlotId.get(id)).toEqual(w);
    expect(lastPlotArea().plots).toBe(before);
  });
});
