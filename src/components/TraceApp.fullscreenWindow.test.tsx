// @vitest-environment jsdom
//
// The fullscreen mount is wired like the detached one: a gesture in fullscreen
// goes through the one window-write path, so it records the plot's view window
// (every mount draws it in the same render), freezes autoscroll, and drives the
// debounced archive fetch window. Without `onViewWindowChange` on that mount,
// fullscreen pan/zoom would be inert.
//
// PlotArea and PlotWithStatistics are wrapped (not replaced) so the test can
// read the props TraceApp hands each mount while the real tree renders.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { createElement, type ComponentProps } from 'react';
import type { TimeWindowNs } from '../api/time';
import { WithCanopy } from '../test/canopy';

type PlotAreaProps = ComponentProps<typeof import('./PlotArea').PlotArea>;
type MountProps = ComponentProps<typeof import('./PlotArea').PlotWithStatistics>;
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
    mounts: [] as unknown[],
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
  function PlotWithStatistics(props: MountProps) {
    captured.mounts.push(props);
    return React.createElement(actual.PlotWithStatistics, props);
  }
  return { ...actual, PlotArea, PlotWithStatistics };
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
  captured.mounts.length = 0;
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
  window.history.replaceState(null, '', '/trace/?pv=TEST:FULLSCREEN:WINDOW&range=-1h');
  vi.resetModules();
  const { TraceApp } = await import('./TraceApp');
  render(createElement(TraceApp), { wrapper: WithCanopy });
  await flush();
}

const lastPlotArea = (): PlotAreaProps => captured.plotArea.at(-1) as PlotAreaProps;
const fullscreenMount = (): MountProps | undefined =>
  (captured.mounts as MountProps[]).filter((p) => p.fullscreen === true).at(-1);
const lastOption = (): ChartOption => captured.options.at(-1) as ChartOption;
const plotId = (): string => lastPlotArea().plots[0].id;
const nsToMs = (ns: number) => Math.round(ns / 1_000_000);

// A window a day back (far outside the opening buffer, so each would refetch
// were it not debounced), shifted by `k` minutes.
function pastWindow(k: number): TimeWindowNs {
  const toNs = (T0 - 24 * HOUR_MS) * 1_000_000 + k * MIN_NS;
  return { fromNs: toNs - 10 * MIN_NS, toNs };
}

function openFullscreen(id: string): void {
  act(() => {
    lastPlotArea().onPopOutPlot(id);
  });
}

describe('TraceApp fullscreen view window', () => {
  it('a window change on the fullscreen mount records the view window and stops autoscroll', async () => {
    await mount();
    const id = plotId();
    expect(lastPlotArea().plots[0].autoScroll).not.toBe(false);

    openFullscreen(id);
    const fs = fullscreenMount();
    expect(fs).toBeDefined();
    expect(fs!.plot.id).toBe(id);
    expect(fs!.onViewWindowChange).toBeTypeOf('function');

    const w = pastWindow(0);
    act(() => {
      fullscreenMount()!.onViewWindowChange!(w);
    });

    // viewWindowByPlot holds it: every mount draws it in the same render.
    expect(lastPlotArea().displayWindowByPlotId.get(id)).toEqual(w);
    expect(fullscreenMount()!.viewWindowNs).toEqual(w);
    expect(lastOption().xAxis.min).toBe(nsToMs(w.fromNs));
    expect(lastOption().xAxis.max).toBe(nsToMs(w.toNs));
    // A manual gesture in fullscreen freezes autoscroll, like any other mount.
    expect(lastPlotArea().plots[0].autoScroll).toBe(false);
    expect(fullscreenMount()!.plot.autoScroll).toBe(false);
  });

  it('a fullscreen window change drives the debounced archive fetch window', async () => {
    await mount();
    const id = plotId();
    openFullscreen(id);
    fetchDataMock.mockClear();
    const opening = fullscreenMount()!.statsWindowNs!;
    const w = pastWindow(5);

    act(() => {
      fullscreenMount()!.onViewWindowChange!(w);
    });
    expect(fullscreenMount()!.statsWindowNs).toEqual(opening);
    expect(fetchDataMock).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(fullscreenMount()!.statsWindowNs).toEqual(w);
    expect(fetchDataMock).toHaveBeenCalledTimes(1);
    const params = fetchDataMock.mock.calls[0][1];
    expect(params.fromNs).toBeLessThanOrEqual(w.fromNs);
    expect(params.toNs).toBeGreaterThanOrEqual(w.toNs);
  });

  it('a follow write from fullscreen records the window and leaves autoscroll alone', async () => {
    await mount();
    const id = plotId();
    openFullscreen(id);
    const before = lastPlotArea().plots;
    const w = pastWindow(0);
    act(() => {
      fullscreenMount()!.onViewWindowChange!(w, { follow: true });
    });
    expect(lastPlotArea().displayWindowByPlotId.get(id)).toEqual(w);
    expect(lastPlotArea().plots).toBe(before);
  });
});
