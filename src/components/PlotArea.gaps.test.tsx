// @vitest-environment jsdom
//
// Gap markers end to end through SinglePlot: an archive outage, a stale
// archive tail and a recorded Hare disconnect each render as a null in the
// line data (ECharts draws a gap there), the min/max band breaks at the same
// t, the dashed now-extension follows the rules in src/components/traceGaps.ts, and the
// tooltip never reports a null marker as a sample.
//
// echarts-for-react is mocked to capture each rendered option. The archive
// store is replaced by a fixed snapshot so useArchiveSeries' coverToNs
// passthrough is exercised; the live path runs the real liveStore over a mock
// WebSocket.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { Axis, Plot, PVTrace } from '../types';
import type { ArchiveEntry } from '../state/archiveStore';
import type { PVValueDTO } from '@slaclab/canopy-client';

type Series = { id?: string; data: [number, number | null][] };
type ChartOption = {
  series: Series[];
  tooltip: { formatter: (params: { axisValue: number }[]) => string };
};

const { rendered, archive } = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const archive = {
    snapshot: new Map<string, unknown>(),
    listeners,
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getSnapshot: () => archive.snapshot,
    request: () => {},
    release: () => {},
  };
  return { rendered: [] as ChartOption[], archive };
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
    resize: () => {},
    dispatchAction: () => {},
    on: () => {},
    off: () => {},
  };
  class MockECharts extends React.Component<{ option: ChartOption }> {
    getEchartsInstance() {
      return fakeInstance;
    }
    render() {
      rendered.push(this.props.option);
      return React.createElement('div');
    }
  }
  return { default: MockECharts };
});

vi.mock('../state/archiveStore', () => ({
  DEFAULT_OPTIMIZED_BINS: 1000,
  archiveStore: archive,
}));

import { SinglePlot } from './PlotArea';
import { useArchiveSeries } from '../hooks/useArchiveSeries';
import { useLiveSeries } from '../hooks/useLiveSeries';
import { nsToMs } from '../api/time';
import { seriesPoints } from '../test/seriesPoints';
import type { TimeWindowNs } from '../api/time';

const S = 1_000;
const MS_NS = 1_000_000;
// A millisecond m with nsToMs(m * MS_NS) === m - 1: m * 1e6 exceeds 2^53 and
// rounds to the double just below it.
const SENT_MS = 1_791_788_412_178;

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];
  readyState = 0;
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }
  send() {}
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.();
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  emit(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  rendered.length = 0;
  archive.snapshot = new Map();
  MockWebSocket.instances = [];
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  vi.stubGlobal('WebSocket', MockWebSocket);
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.unstubAllGlobals();
});

function makeTrace(overrides: Partial<PVTrace> = {}): PVTrace {
  return {
    id: 't1',
    pvName: 'GAP:PV',
    displayName: '',
    color: '#0f62fe',
    visible: true,
    axisId: 'ax1',
    useLive: false,
    useArchive: false,
    lineWidth: 2,
    lineType: 'step',
    lineStyle: 'solid',
    showSymbol: false,
    symbolShape: 'circle',
    symbolSize: 10,
    data: [],
    ...overrides,
  };
}

function makePlot(traces: PVTrace[]): Plot {
  const axis: Axis = {
    id: 'ax1',
    name: 'Y',
    orientation: 'left',
    autoScale: true,
    logScale: false,
    visible: true,
  };
  return {
    id: 'p1',
    title: 'Plot 1',
    traces,
    axes: [axis],
    backgroundColor: 'default',
    showLegend: false,
    showXGridlines: false,
    showYGridlines: false,
    showCrosshair: false,
    gridStyle: 'solid',
    gridOpacity: 1,
    tickFontSize: 11,
    xAxis: { timeRange: '1h' },
  };
}

function archiveEntry(
  times: number[],
  coverToMs: number,
  mode: 'raw' | 'binned' = 'raw'
): ArchiveEntry {
  return {
    status: 'ready',
    mean: times.map((t) => ({ time: t, value: 2, severity: 'NO_ALARM' as const })),
    band:
      mode === 'binned'
        ? times.map((t) => ({ time: t, min: 1, max: 3, severity: 'NO_ALARM' as const }))
        : [],
    coverFromNs: times[0] * MS_NS,
    coverToNs: coverToMs * MS_NS,
    mode,
    archiver: 'mongo',
    decimated: false,
  };
}

function ArchivePlot({ plot }: { plot: Plot }) {
  const windows = new Map<string, TimeWindowNs>(
    // Any window: the mocked store ignores requests and serves its snapshot.
    plot.traces.map((t) => [t.id, { fromNs: 0, toNs: MS_NS }])
  );
  const archiveResults = useArchiveSeries(
    plot.traces,
    new Map(plot.traces.map((t) => [t.id, undefined])),
    windows
  );
  return (
    <SinglePlot
      plot={plot}
      archiveResults={archiveResults}
      liveResults={new Map()}
      formulaResults={new Map()}
    />
  );
}

function LivePlot({ plot }: { plot: Plot }) {
  const liveResults = useLiveSeries(plot.traces);
  return (
    <SinglePlot
      plot={plot}
      archiveResults={new Map()}
      liveResults={liveResults}
      formulaResults={new Map()}
    />
  );
}

function lastOption(): ChartOption {
  expect(rendered.length).toBeGreaterThan(0);
  return rendered[rendered.length - 1];
}

function seriesById(option: ChartOption, id: string): Series | undefined {
  return option.series.find((s) => s.id === id);
}

function nullTimes(series: Series | undefined): number[] {
  return (seriesPoints(series?.data ?? []) as Series['data'])
    .filter((p) => p[1] === null)
    .map((p) => p[0]);
}

function grid(start: number, step: number, count: number): number[] {
  return Array.from({ length: count }, (_, k) => start + k * step);
}

describe('SinglePlot gap markers', () => {
  it('breaks the mean and both band series at the same t over an archive hole', () => {
    const now = Date.now();
    const before = grid(now - 50 * 60 * S, 10 * S, 60);
    const holeStart = before.at(-1)!;
    const times = [...before, ...grid(holeStart + 300 * S, 10 * S, 60)];
    const trace = makeTrace({ useArchive: true });
    archive.snapshot = new Map([['t1', archiveEntry(times, times.at(-1)! + 5 * S, 'binned')]]);
    render(<ArchivePlot plot={makePlot([trace])} />);
    const option = lastOption();
    expect(nullTimes(seriesById(option, 't1'))).toEqual([holeStart + 1]);
    expect(nullTimes(seriesById(option, 't1-band-min'))).toEqual([holeStart + 1]);
    expect(nullTimes(seriesById(option, 't1-band-max'))).toEqual([holeStart + 1]);
  });

  it('now − last = 40 s with coverToNs − last = 8 s: no null and extension kept', () => {
    const now = Date.now();
    const times = grid(now - 40 * S - 600 * S, 10 * S, 61);
    const last = times.at(-1)!;
    const trace = makeTrace({ useArchive: true });
    archive.snapshot = new Map([['t1', archiveEntry(times, last + 8 * S)]]);
    render(<ArchivePlot plot={makePlot([trace])} />);
    const option = lastOption();
    expect(nullTimes(seriesById(option, 't1'))).toEqual([]);
    const ext = seriesById(option, 't1-extension');
    expect(ext).toBeDefined();
    expect(seriesPoints(ext!.data)[0]).toEqual([last, 2]);
  });

  it('archive-only stale tail draws no extension', () => {
    const now = Date.now();
    const times = grid(now - 20 * 60 * S, 10 * S, 60);
    const trace = makeTrace({ useArchive: true });
    archive.snapshot = new Map([['t1', archiveEntry(times, now)]]);
    render(<ArchivePlot plot={makePlot([trace])} />);
    expect(seriesById(lastOption(), 't1-extension')).toBeUndefined();
  });

  it('a recorded Hare break flows liveStore → useLiveSeries → one null, then resumes', async () => {
    // Only Date is faked: the re-stamped sample lands at "now", so the clock
    // has to move before the extension has any length to draw. The clock is
    // pinned to an instant whose sample timestamp, written in nanoseconds, is
    // not an exact double: the store then records the point 1 ms earlier than
    // the millisecond it was built from (true of one wall-clock ms in eight).
    vi.useFakeTimers({ toFake: ['Date'], now: SENT_MS + 120 * S });
    const trace = makeTrace({ id: 'live1', pvName: 'GAP:LIVE', useLive: true });
    const { rerender } = render(<LivePlot plot={makePlot([trace])} />);
    const ws = MockWebSocket.instances.at(-1)!;
    // Hare stamps in nanoseconds and the store plots nsToMs(tsNs), so the
    // expected times are derived from the frame's tsNs, never from the
    // millisecond it was multiplied up from.
    const tsNs = (Date.now() - 120 * S) * MS_NS;
    const t0 = nsToMs(tsNs);
    expect(t0).toBe(SENT_MS - 1);
    const value = (connected: boolean): PVValueDTO => ({
      pv: 'GAP:LIVE',
      value: 4,
      valueKind: 'scalar',
      severity: 'NO_ALARM',
      tsNs,
      connected,
      error: null,
    });
    const flush = async (fn: () => void) =>
      act(async () => {
        fn();
        // liveStore notifies in a microtask; a macrotask turn drains it and
        // React's re-render (timers are real; only Date is faked).
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

    await flush(() => {
      ws.open();
      ws.emit({ type: 'initial', data: { 'GAP:LIVE': value(true) }, meta: {}, count: 1 });
    });
    expect(nullTimes(seriesById(lastOption(), 'live1'))).toEqual([]);
    expect(seriesById(lastOption(), 'live1-extension')).toBeDefined();

    // Two disconnected frames: one break, an open one, so no extension.
    await flush(() => {
      ws.emit({ type: 'diff', data: { 'GAP:LIVE': value(false) }, count: 1 });
      ws.emit({ type: 'diff', data: { 'GAP:LIVE': value(false) }, count: 1 });
    });
    expect(nullTimes(seriesById(lastOption(), 'live1'))).toEqual([t0 + 1]);
    expect(seriesById(lastOption(), 'live1-extension')).toBeUndefined();

    // Reconnect with the unchanged value and its old timestamp: the sample is
    // re-stamped past the break, the line resumes and the extension returns.
    await flush(() => {
      ws.emit({ type: 'diff', data: { 'GAP:LIVE': value(true) }, count: 1 });
    });
    const data = seriesById(lastOption(), 'live1')!.data;
    expect(nullTimes({ data })).toEqual([t0 + 1]);
    expect(data.at(-1)![1]).toBe(4);
    expect(data.at(-1)![0]).toBeGreaterThan(t0 + 1);
    vi.setSystemTime(Date.now() + 5 * S);
    rerender(<LivePlot plot={makePlot([trace])} />);
    expect(seriesById(lastOption(), 'live1-extension')).toBeDefined();
    vi.useRealTimers();
  });

  it('the tooltip skips null markers', () => {
    const now = Date.now();
    const before = grid(now - 50 * 60 * S, 10 * S, 60);
    const holeStart = before.at(-1)!;
    const times = [...before, ...grid(holeStart + 300 * S, 10 * S, 60)];
    const trace = makeTrace({ useArchive: true });
    archive.snapshot = new Map([['t1', archiveEntry(times, times.at(-1)! + 5 * S)]]);
    render(<ArchivePlot plot={makePlot([trace])} />);
    const html = lastOption().tooltip.formatter([{ axisValue: holeStart + 1 }]);
    expect(html).not.toContain('null');
    expect(html).not.toContain('no data');
    expect(html).toContain('2');
  });
});
