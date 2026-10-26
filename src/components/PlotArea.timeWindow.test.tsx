// @vitest-environment jsdom
//
// Pins where SinglePlot's time axis comes from (issue 95). The extent must
// derive from the plot's clock (passed in as `endMs`, see axisEndMs), never the
// wall clock read during render: before the fix every live batch re-render
// moved the axis to the current time, even with Autoscroll off.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { SinglePlot } from './PlotArea';
import { axisEndMs } from '../hooks/useAutoScrollTimers';
import type { Plot } from '../types';
import type { LiveSeriesResult } from '../hooks/useLiveSeries';

const { captured, fakeInstance } = vi.hoisted(() => {
  const captured: {
    option: {
      xAxis: { min: number; max: number };
      series: { id: string; data: [number, number][] }[];
    } | null;
    onEvents: Record<string, () => void>;
  } = { option: null, onEvents: {} };
  const fakeInstance = {
    getDom: () => ({}),
    isDisposed: () => false,
    dispatchAction: vi.fn(),
    getModel: () => ({
      getComponent: () => ({ axis: { scale: { getExtent: (): [number, number] => [0, 1] } } }),
    }),
  };
  return { captured, fakeInstance };
});

vi.mock('echarts-for-react', async () => {
  const React = await import('react');
  class MockECharts extends React.Component<{
    option: unknown;
    onEvents: Record<string, () => void>;
  }> {
    getEchartsInstance() {
      return fakeInstance;
    }
    render() {
      captured.option = this.props.option as typeof captured.option;
      captured.onEvents = this.props.onEvents;
      return React.createElement('div');
    }
  }
  return { default: MockECharts };
});

const T0 = new Date('2026-10-15T12:00:00Z').getTime();
const HOUR = 60 * 60 * 1000;

function makePlot(overrides: Partial<Plot> = {}): Plot {
  return {
    id: 'p1',
    title: 'Plot 1',
    traces: [
      {
        id: 't1',
        pvName: 'PV:1',
        displayName: '',
        color: '#fff',
        visible: true,
        axisId: 'ax1',
        useLive: true,
        updateRate: 'monitor',
        useArchive: false,
        lineWidth: 1,
        lineType: 'step',
        lineStyle: 'solid',
        showSymbol: false,
        symbolShape: 'circle',
        symbolSize: 4,
        data: [],
      },
    ],
    axes: [
      {
        id: 'ax1',
        name: 'Y',
        orientation: 'left',
        autoScale: true,
        logScale: false,
        visible: true,
      },
    ],
    backgroundColor: 'default',
    showLegend: false,
    showXGridlines: false,
    showYGridlines: false,
    showCrosshair: false,
    gridStyle: 'solid',
    gridOpacity: 1,
    tickFontSize: 11,
    xAxis: { timeRange: '-1h' },
    ...overrides,
  };
}

// A live batch: a fresh results map whose newest sample is at `latestMs`.
function liveBatch(latestMs: number): Map<string, LiveSeriesResult> {
  return new Map([
    [
      't1',
      {
        status: 'connected',
        connected: true,
        severity: 'NO_ALARM',
        latest: null,
        error: null,
        points: [
          { time: latestMs - 1000, value: 1, severity: 'NO_ALARM' },
          { time: latestMs, value: 2, severity: 'NO_ALARM' },
        ],
      },
    ],
  ]);
}

// Mounts the plot the way TraceApp does: the axis end is worked out from the
// clock and live data by axisEndMs and passed in.
function plotEl(
  plot: Plot,
  nowMs: number,
  live: Map<string, LiveSeriesResult>,
  following = plot.autoScroll !== false,
  onFollowStop?: () => void
) {
  return (
    <SinglePlot
      plot={plot}
      endMs={axisEndMs(plot, nowMs, following, live)}
      following={following}
      onFollowStop={onFollowStop}
      archiveResults={new Map()}
      liveResults={live}
      formulaResults={new Map()}
    />
  );
}

function xAxis() {
  return captured.option!.xAxis;
}

describe('SinglePlot time axis', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    fakeInstance.dispatchAction.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  // The issue 95 regression: a live batch arriving 60 s later must not move the
  // axis. With the plot's clock unchanged the extent is exactly the same.
  for (const autoScroll of [false, true]) {
    it(`holds the axis across a live batch 60 s later (autoScroll ${autoScroll})`, () => {
      const plot = makePlot({ autoScroll });
      const { rerender, unmount } = render(plotEl(plot, T0, liveBatch(T0 - 2000)));
      expect(xAxis().max).toBe(T0);
      expect(xAxis().min).toBe(T0 - HOUR);

      vi.setSystemTime(T0 + 60_000);
      rerender(plotEl(plot, T0, liveBatch(T0 - 1000)));
      expect(xAxis().max).toBe(T0);
      expect(xAxis().min).toBe(T0 - HOUR);
      unmount();
    });
  }

  it('ends a following plot at the newest live sample past its clock', () => {
    const plot = makePlot({ refreshIntervalS: 5 });
    const { rerender, unmount } = render(plotEl(plot, T0, liveBatch(T0 + 3000)));
    expect(xAxis().max).toBe(T0 + 3000);
    expect(xAxis().min).toBe(T0 + 3000 - HOUR);
    // An older sample never pulls the axis back behind the clock.
    rerender(plotEl(plot, T0, liveBatch(T0 - 1000)));
    expect(xAxis().max).toBe(T0);
    unmount();
  });

  it('caps the live-edge lead at one refresh interval past the clock', () => {
    // A skewed or bogus IOC timestamp far in the future.
    const plot = makePlot({ refreshIntervalS: 5 });
    const { unmount } = render(plotEl(plot, T0, liveBatch(T0 + 10 * 60_000)));
    expect(xAxis().max).toBe(T0 + 5000);
    unmount();
  });

  it('ignores live samples on a frozen plot', () => {
    const plot = makePlot({ autoScroll: false });
    const { unmount } = render(plotEl(plot, T0, liveBatch(T0 + 3000)));
    expect(xAxis().max).toBe(T0);
    unmount();
  });

  it('ignores live samples from hidden or non-live traces', () => {
    const base = makePlot();
    const hidden = { ...base, traces: [{ ...base.traces[0], visible: false }] };
    const r1 = render(plotEl(hidden, T0, liveBatch(T0 + 3000)));
    expect(xAxis().max).toBe(T0);
    r1.unmount();
    const notLive = { ...base, traces: [{ ...base.traces[0], useLive: false }] };
    const r2 = render(plotEl(notLive, T0, liveBatch(T0 + 3000)));
    expect(xAxis().max).toBe(T0);
    r2.unmount();
  });

  it('moves the axis only when the clock prop moves', () => {
    const plot = makePlot();
    const { rerender, unmount } = render(plotEl(plot, T0, new Map()));
    rerender(plotEl(plot, T0 + 5000, new Map()));
    expect(xAxis().max).toBe(T0 + 5000);
    expect(xAxis().min).toBe(T0 + 5000 - HOUR);
    unmount();
  });

  it('ends a custom range with a blank To at the clock prop', () => {
    const plot = makePlot({
      xAxis: { timeRange: 'custom', timeFrom: '2026-10-15T00:00', timeTo: '' },
    });
    const { rerender, unmount } = render(plotEl(plot, T0, liveBatch(T0 - 2000)));
    expect(xAxis().max).toBe(T0);
    vi.setSystemTime(T0 + 60_000);
    rerender(plotEl(plot, T0, liveBatch(T0 - 1000)));
    expect(xAxis().max).toBe(T0);
    unmount();
  });
});

describe('SinglePlot zoom reset', () => {
  beforeEach(() => fakeInstance.dispatchAction.mockClear());

  const RESET = { type: 'dataZoom', start: 0, end: 100 };

  it('does not reset on mount', () => {
    const { unmount } = render(plotEl(makePlot(), T0, new Map(), true));
    expect(fakeInstance.dispatchAction).not.toHaveBeenCalled();
    unmount();
  });

  it('resets when the plot resumes following, not when it stops', () => {
    const plot = makePlot();
    const { rerender, unmount } = render(plotEl(plot, T0, new Map(), true));
    // Stops following (pan or Autoscroll off): the user's zoom must survive.
    rerender(plotEl({ ...plot, autoScroll: false }, T0, new Map(), false));
    expect(fakeInstance.dispatchAction).not.toHaveBeenCalled();
    // Autoscroll back on: back to the full range.
    rerender(plotEl(plot, T0 + 1000, new Map(), true));
    expect(fakeInstance.dispatchAction).toHaveBeenCalledTimes(1);
    expect(fakeInstance.dispatchAction).toHaveBeenCalledWith(RESET);
    unmount();
  });

  it('resets when a new time range is picked', () => {
    const plot = makePlot();
    const { rerender, unmount } = render(plotEl(plot, T0, new Map(), true));
    rerender(plotEl({ ...plot, xAxis: { timeRange: '-4h' } }, T0, new Map(), true));
    expect(fakeInstance.dispatchAction).toHaveBeenCalledTimes(1);
    expect(fakeInstance.dispatchAction).toHaveBeenCalledWith(RESET);
    unmount();
  });
});

describe('SinglePlot pan while following', () => {
  beforeEach(() => fakeInstance.dispatchAction.mockClear());

  it('stops following on the first genuine pan', () => {
    const onFollowStop = vi.fn();
    const plot = makePlot({ refreshIntervalS: 5 });
    const { unmount } = render(plotEl(plot, T0, liveBatch(T0 + 2000), true, onFollowStop));
    captured.onEvents.datazoom();
    // The app freezes the plot at the end it passed in.
    expect(onFollowStop).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('ignores the programmatic zoom reset', () => {
    const onFollowStop = vi.fn();
    const plot = makePlot({ autoScroll: false });
    const { rerender, unmount } = render(plotEl(plot, T0, new Map(), false, onFollowStop));
    // Resume: SinglePlot dispatches its own reset, whose datazoom event must
    // not count as a user pan.
    rerender(plotEl({ ...plot, autoScroll: true }, T0, new Map(), true, onFollowStop));
    expect(fakeInstance.dispatchAction).toHaveBeenCalledTimes(1);
    captured.onEvents.datazoom();
    expect(onFollowStop).not.toHaveBeenCalled();
    unmount();
  });

  it('does nothing for a plot that is not following', () => {
    const onFollowStop = vi.fn();
    const plot = makePlot({ autoScroll: false });
    const { unmount } = render(plotEl(plot, T0, new Map(), false, onFollowStop));
    captured.onEvents.datazoom();
    expect(onFollowStop).not.toHaveBeenCalled();
    unmount();
  });
});

describe('SinglePlot smooth scrolling', () => {
  // SinglePlot drives its display clock from the chart's own window
  // (ownerDocument.defaultView), which in jsdom isn't the global that fake
  // timers patch, so queue that window's animation frames by hand.
  let frames: FrameRequestCallback[] = [];
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    frames = [];
    const win = document.defaultView!;
    vi.spyOn(win, 'requestAnimationFrame').mockImplementation((cb) => frames.push(cb));
    vi.spyOn(win, 'cancelAnimationFrame').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // Run the pending animation frame(s) at wall time `atMs`.
  function frameAt(atMs: number) {
    vi.setSystemTime(atMs);
    const pending = frames;
    frames = [];
    act(() => {
      for (const cb of pending) cb(atMs);
    });
  }

  it('scrolls a following plot on animation frames between clock ticks', () => {
    const plot = makePlot({ xAxis: { timeRange: '-30s' } });
    const { unmount } = render(plotEl(plot, T0, new Map(), true));
    expect(xAxis().max).toBe(T0);
    frameAt(T0 + 1000);
    expect(xAxis().max).toBe(T0 + 1000);
    expect(xAxis().min).toBe(T0 + 1000 - 30_000);
    frameAt(T0 + 1500);
    expect(xAxis().max).toBe(T0 + 1500);
    unmount();
  });

  it('keeps a frozen plot on its clock and schedules no frames', () => {
    const plot = makePlot({ xAxis: { timeRange: '-30s' }, autoScroll: false });
    const { unmount } = render(plotEl(plot, T0, new Map(), false));
    expect(frames).toHaveLength(0);
    vi.setSystemTime(T0 + 2000);
    expect(xAxis().max).toBe(T0);
    unmount();
  });

  const seriesData = (id: string) => captured.option!.series.find((s) => s.id === id)?.data;

  it("reuses the samples' series data across frames, and rebuilds it for new samples", () => {
    const plot = makePlot({ xAxis: { timeRange: '-30s' } });
    const live = liveBatch(T0 - 1000);
    const { rerender, unmount } = render(plotEl(plot, T0, live, true));
    frameAt(T0 + 1000);
    const line = seriesData('t1');
    const ext = seriesData('t1-extension');
    expect(line).toEqual([
      [T0 - 2000, 1],
      [T0 - 1000, 2],
    ]);
    frameAt(T0 + 1500);
    expect(xAxis().max).toBe(T0 + 1500);
    // The axis moved; the line and the extension's anchors didn't.
    expect(seriesData('t1')).toBe(line);
    expect(seriesData('t1-extension')).toBe(ext);

    rerender(plotEl(plot, T0, liveBatch(T0 + 1000), true));
    expect(seriesData('t1')).not.toBe(line);
    expect(seriesData('t1-extension')).not.toBe(ext);
    unmount();
  });

  it('runs the extension line from the last sample past the right edge as it scrolls', () => {
    const plot = makePlot({ xAxis: { timeRange: '-30s' } });
    const { unmount } = render(plotEl(plot, T0, liveBatch(T0 - 1000), true));
    for (const atMs of [T0 + 1000, T0 + 29_000, T0 + 45_000]) {
      frameAt(atMs);
      const ext = seriesData('t1-extension')!;
      // From the last sample (T0 - 1 s), or from no later than the left edge
      // once that has scrolled past it, to at least the right edge.
      expect(ext[0][0]).toBeGreaterThanOrEqual(T0 - 1000);
      expect(ext[0][0]).toBeLessThanOrEqual(Math.max(T0 - 1000, xAxis().min));
      expect(ext[0][1]).toBe(2);
      expect(ext.at(-1)![0]).toBeGreaterThanOrEqual(xAxis().max);
      // Dense enough inside the window that a zoom keeps some of it.
      expect(ext[1][0] - ext[0][0]).toBeLessThanOrEqual(30_000 / 2047);
    }
    unmount();
  });

  it('stops following on a pan after scrolling past the last clock tick', () => {
    const onFollowStop = vi.fn();
    const plot = makePlot({ xAxis: { timeRange: '-30s' } });
    const { unmount } = render(plotEl(plot, T0, new Map(), true, onFollowStop));
    frameAt(T0 + 1200);
    expect(xAxis().max).toBe(T0 + 1200);
    // TraceApp freezes the plot at the current time or later (see
    // freezeAtDisplayedEnd), so the axis doesn't jump back to the tick.
    captured.onEvents.datazoom();
    expect(onFollowStop).toHaveBeenCalledTimes(1);
    unmount();
  });
});
