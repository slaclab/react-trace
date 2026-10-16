// @vitest-environment jsdom
//
// Pins where SinglePlot's time axis comes from (issue 95). The extent must
// derive from the `nowMs` clock prop, never the wall clock read during render:
// before the fix every live batch re-render moved the axis to the current time,
// even with Autoscroll off.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { SinglePlot } from './PlotArea';
import type { Plot } from '../types';
import type { LiveSeriesResult } from '../hooks/useLiveSeries';

const { captured, fakeInstance } = vi.hoisted(() => {
  const captured: { option: { xAxis: { min: number; max: number } } | null } = { option: null };
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
  class MockECharts extends React.Component<{ option: unknown }> {
    getEchartsInstance() {
      return fakeInstance;
    }
    render() {
      captured.option = this.props.option as typeof captured.option;
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

function plotEl(
  plot: Plot,
  nowMs: number,
  live: Map<string, LiveSeriesResult>,
  following = plot.autoScroll !== false
) {
  return (
    <SinglePlot
      plot={plot}
      nowMs={nowMs}
      following={following}
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
