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
import { chartStub, fireChartEvent } from '../test/chartStub';

const captured: {
  option: {
    xAxis: { min: number; max: number };
    series: { id: string; data: Float64Array }[];
  } | null;
} = { option: null };
const fakeInstance = {
  isDisposed: () => false,
  dispatchAction: vi.fn(),
  getModel: () => ({
    getComponent: () => ({ axis: { scale: { getExtent: (): [number, number] => [0, 1] } } }),
  }),
};

vi.mock('@slaclab/canopy-charts', async (importOriginal) =>
  (await import('../test/chartStub')).mockCanopyCharts(importOriginal)
);
chartStub.instance = fakeInstance;
chartStub.onRender = (props) => {
  captured.option = props.option as typeof captured.option;
};

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
  afterEach(() => vi.useRealTimers());

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

  // Issue 109: a pan's view window is debounced. Resuming before it lands must
  // drop it, or it re-freezes the plot at the pan right after the reset.
  it('drops a pan still waiting to be recorded when it resets', () => {
    vi.useFakeTimers();
    const onViewWindowChange = vi.fn();
    const el = (p: Plot, following: boolean) => (
      <SinglePlot
        plot={p}
        nowMs={T0}
        following={following}
        onFollowStop={() => {}}
        onViewWindowChange={onViewWindowChange}
        archiveResults={new Map()}
        liveResults={new Map()}
        formulaResults={new Map()}
      />
    );
    const plot = makePlot();
    const { rerender, unmount } = render(el(plot, true));
    captured.onEvents.datazoom();
    rerender(el({ ...plot, autoScroll: false }, false));
    // Autoscroll back on (or the span re-committed) within the debounce.
    rerender(el(plot, true));
    expect(fakeInstance.dispatchAction).toHaveBeenCalledWith(RESET);
    vi.advanceTimersByTime(1000);
    expect(onViewWindowChange).not.toHaveBeenCalled();
    unmount();
  });
});

describe('SinglePlot pan while following', () => {
  beforeEach(() => fakeInstance.dispatchAction.mockClear());

  it('stops following on the first genuine pan', () => {
    const onFollowStop = vi.fn();
    const plot = makePlot({ refreshIntervalS: 5 });
    const { unmount } = render(plotEl(plot, T0, liveBatch(T0 + 2000), true, onFollowStop));
    fireChartEvent('datazoom');
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
    fireChartEvent('datazoom');
    expect(onFollowStop).not.toHaveBeenCalled();
    unmount();
  });

  it('does nothing for a plot that is not following', () => {
    const onFollowStop = vi.fn();
    const plot = makePlot({ autoScroll: false });
    const { unmount } = render(plotEl(plot, T0, new Map(), false, onFollowStop));
    fireChartEvent('datazoom');
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
  // A series' flat [t0, v0, t1, v1, ...] data as [t, v] pairs.
  const points = (id: string) => {
    const flat = Array.from(seriesData(id)!);
    return Array.from({ length: flat.length / 2 }, (_, i) => [flat[2 * i], flat[2 * i + 1]]);
  };

  it("reuses the samples' series data across frames, and rebuilds it for new samples", () => {
    const plot = makePlot({ xAxis: { timeRange: '-30s' } });
    const live = liveBatch(T0 - 1000);
    const { rerender, unmount } = render(plotEl(plot, T0, live, true));
    frameAt(T0 + 1000);
    const line = seriesData('t1');
    // Typed, so ECharts doesn't deep-clone and walk every point on each update.
    expect(line).toBeInstanceOf(Float64Array);
    expect(points('t1')).toEqual([
      [T0 - 2000, 1],
      [T0 - 1000, 2],
    ]);
    frameAt(T0 + 1500);
    expect(xAxis().max).toBe(T0 + 1500);
    // The axis moved; the line didn't.
    expect(seriesData('t1')).toBe(line);

    rerender(plotEl(plot, T0, liveBatch(T0 + 1000), true));
    expect(seriesData('t1')).not.toBe(line);
    unmount();
  });

  it('runs a two-point extension from the last sample to the right edge as it scrolls', () => {
    const plot = makePlot({ xAxis: { timeRange: '-30s' } });
    const { unmount } = render(plotEl(plot, T0, liveBatch(T0 - 1000), true));
    for (const atMs of [T0 + 1000, T0 + 29_000, T0 + 45_000]) {
      frameAt(atMs);
      // From the last sample (T0 - 1 s), or from the left edge once that has
      // scrolled past it, to exactly the right edge: a point past it would be
      // filtered out.
      expect(points('t1-extension')).toEqual([
        [Math.max(T0 - 1000, xAxis().min), 2],
        [xAxis().max, 2],
      ]);
    }
    unmount();
  });

  it("gives a frozen plot's extension anchors dense enough to survive a zoom", () => {
    const plot = makePlot({ xAxis: { timeRange: '-30s' }, autoScroll: false });
    const { unmount } = render(plotEl(plot, T0, liveBatch(T0 - 1000), false));
    const ext = points('t1-extension');
    expect(ext).toHaveLength(2048);
    expect(ext[0]).toEqual([T0 - 1000, 2]);
    expect(ext.at(-1)).toEqual([T0, 2]);
    expect(ext[1][0] - ext[0][0]).toBeCloseTo(1000 / 2047, 3);
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
    fireChartEvent('datazoom');
    expect(onFollowStop).toHaveBeenCalledTimes(1);
    unmount();
  });
});
