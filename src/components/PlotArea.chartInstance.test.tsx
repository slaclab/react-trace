// @vitest-environment jsdom
//
// SinglePlot under canopy-charts' CanopyChart (issue 105). CanopyChart hands
// over the ECharts instance through onReady, again after any re-init, and never
// reports a disposal. SinglePlot must use the newest instance, treat a disposed
// one as no chart, read event data from the chart that fired the event, and
// ignore events from a chart without a model (not built yet, or disposed).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import type { ECharts } from 'echarts';
import { SinglePlot } from './PlotArea';
import { capturePlotPng } from '../capturePlot';
import { msToNs } from '../api/time';
import type { PngSource } from '../io/exportPlotImage';
import type { Plot } from '../types';
import { chartStub } from '../test/chartStub';

vi.mock('@slaclab/canopy-charts', async (importOriginal) =>
  (await import('../test/chartStub')).mockCanopyCharts(importOriginal)
);

// An 800x400 chart with one left y-axis spanning [lo, hi]; the grid insets
// (top 40, bottom 60, left 70) put x=30 inside the axis band.
function fakeChart(dataUrl: string, [lo, hi]: [number, number] = [0, 100]) {
  let disposed = false;
  const model = {
    getComponent: () => ({ axis: { scale: { getExtent: (): [number, number] => [lo, hi] } } }),
  };
  const chart = {
    isDisposed: () => disposed,
    getDataURL: vi.fn(() => dataUrl),
    getWidth: () => 800,
    getHeight: () => 400,
    getZr: () => ({ setCursorStyle: () => {} }),
    // Like ECharts, a disposed chart has dropped its model.
    getModel: () => (disposed ? null : model),
    convertToPixel: (_f: unknown, v: number) => 340 - ((v - lo) / (hi - lo)) * 300,
    convertFromPixel: (_f: unknown, px: number) => lo + ((340 - px) / 300) * (hi - lo),
  };
  return {
    chart,
    dispose: () => {
      disposed = true;
    },
  };
}

function makePlot(): Plot {
  return {
    id: 'p1',
    title: 'Plot 1',
    traces: [],
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
    xAxis: { timeRange: '1h' },
  };
}

function mountPlot({ following = false }: { following?: boolean } = {}) {
  let source: PngSource | null = null;
  const onUpdateAxis = vi.fn();
  const onAxisRangesChange = vi.fn();
  const onFollowStop = vi.fn();
  const onViewWindowChange = vi.fn();
  const { container, unmount } = render(
    <SinglePlot
      plot={makePlot()}
      endMs={0}
      following={following}
      onFollowStop={onFollowStop}
      onViewWindowChange={onViewWindowChange}
      archiveResults={new Map()}
      liveResults={new Map()}
      formulaResults={new Map()}
      onUpdateAxis={onUpdateAxis}
      onAxisRangesChange={onAxisRangesChange}
      onChartInstance={(s, active) => {
        source = active ? s : null;
      }}
    />
  );
  const wrap = container.querySelector('[data-plot-id="p1"]')!;
  return {
    wrap,
    onUpdateAxis,
    onAxisRangesChange,
    onFollowStop,
    onViewWindowChange,
    unmount,
    png: () => source!.getDataURL(),
  };
}

// jsdom reports a 0,0 bounding rect for the wrapper, so clientX/clientY are
// chart pixels; x=30 is over the left axis band.
const wheelOverAxis = (wrap: Element) =>
  fireEvent.wheel(wrap, { clientX: 30, clientY: 200, deltaY: 100 });

// Call SinglePlot's handler for a chart event straight from the latest
// render's props, with the chart that fired it. Unlike CanopyChart (and
// fireChartEvent), this delivers events from a disposed chart too.
const emit = (name: 'datazoom' | 'finished', chart: object) =>
  act(() => chartStub.props!.onEvents![name]!({}, chart as unknown as ECharts));

beforeEach(() => {
  cleanup();
  chartStub.instance = undefined;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('SinglePlot chart instance', () => {
  it('captures from the instance CanopyChart reported ready', () => {
    const a = fakeChart('data:image/png;base64,QQ==');
    chartStub.instance = a.chart;
    const { png } = mountPlot();
    expect(png()).toBe('data:image/png;base64,QQ==');
  });

  it('has nothing to capture before the chart is ready', () => {
    const { png } = mountPlot();
    expect(png()).toBe('');
  });

  it('switches to the new instance after the chart is re-created', () => {
    const a = fakeChart('data:image/png;base64,QQ==');
    const b = fakeChart('data:image/png;base64,Qg==');
    chartStub.instance = a.chart;
    const { png } = mountPlot();
    act(() => {
      a.dispose();
      chartStub.props!.onReady!(b.chart as unknown as ECharts);
    });
    expect(png()).toBe('data:image/png;base64,Qg==');
    expect(a.chart.getDataURL).not.toHaveBeenCalled();
  });

  it('prints from the instance CanopyChart reported ready', () => {
    const a = fakeChart('data:image/png;base64,QQ==');
    const b = fakeChart('data:image/png;base64,Qg==');
    chartStub.instance = a.chart;
    const { unmount } = mountPlot();
    expect(capturePlotPng(makePlot(), 'dark')).toBe('data:image/png;base64,QQ==');
    act(() => {
      a.dispose();
      chartStub.props!.onReady!(b.chart as unknown as ECharts);
    });
    expect(capturePlotPng(makePlot(), 'dark')).toBe('data:image/png;base64,Qg==');
    expect(a.chart.getDataURL).toHaveBeenCalledTimes(1);
    unmount();
    expect(capturePlotPng(makePlot(), 'dark')).toBeNull();
  });

  it('treats a disposed instance as no chart', () => {
    const a = fakeChart('data:image/png;base64,QQ==');
    chartStub.instance = a.chart;
    const { wrap, onUpdateAxis, png } = mountPlot();
    wheelOverAxis(wrap);
    expect(onUpdateAxis).toHaveBeenCalled();
    onUpdateAxis.mockClear();

    a.dispose();
    wheelOverAxis(wrap);
    fireEvent.mouseDown(wrap, { clientX: 30, clientY: 200, button: 0 });
    expect(onUpdateAxis).not.toHaveBeenCalled();
    expect(png()).toBe('');
    expect(a.chart.getDataURL).not.toHaveBeenCalled();
  });

  it('leaves the axes alone while the chart has no model', () => {
    chartStub.instance = { ...fakeChart('data:,').chart, getModel: () => undefined };
    const { wrap, onUpdateAxis } = mountPlot();
    // jsdom reports an exception in a DOM listener as a window error event
    // instead of throwing it out of fireEvent.
    const errors: unknown[] = [];
    const onError = (e: ErrorEvent) => {
      e.preventDefault();
      errors.push(e.error);
    };
    window.addEventListener('error', onError);
    wheelOverAxis(wrap);
    fireEvent.mouseDown(wrap, { clientX: 30, clientY: 200, button: 0 });
    window.removeEventListener('error', onError);
    expect(errors).toEqual([]);
    expect(onUpdateAxis).not.toHaveBeenCalled();
  });

  it('reads axis ranges from the chart that fired `finished`', () => {
    chartStub.instance = fakeChart('data:,').chart;
    const { onAxisRangesChange } = mountPlot();
    emit('finished', fakeChart('data:,', [5, 7]).chart);
    expect(onAxisRangesChange).toHaveBeenLastCalledWith(new Map([['ax1', [5, 7]]]));
  });

  it('reads the view window from the chart that fired `datazoom`', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    chartStub.instance = fakeChart('data:,').chart;
    const { onFollowStop, onViewWindowChange } = mountPlot({ following: true });
    emit('datazoom', fakeChart('data:,', [1000, 2000]).chart);
    expect(onFollowStop).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(400);
    expect(onViewWindowChange).toHaveBeenCalledWith({ fromNs: msToNs(1000), toNs: msToNs(2000) });
  });

  it('ignores events from a chart that has no model yet', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    chartStub.instance = fakeChart('data:,').chart;
    const { onAxisRangesChange, onFollowStop, onViewWindowChange } = mountPlot({
      following: true,
    });
    // echarts-for-react's throwaway measuring instance can fire before its
    // model exists.
    const measuring = { ...fakeChart('data:,').chart, getModel: () => undefined };
    emit('finished', measuring);
    emit('datazoom', measuring);
    vi.advanceTimersByTime(400);
    expect(onAxisRangesChange).not.toHaveBeenCalled();
    expect(onFollowStop).not.toHaveBeenCalled();
    expect(onViewWindowChange).not.toHaveBeenCalled();
  });

  it('ignores events from a disposed chart even if they get through', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const a = fakeChart('data:,');
    chartStub.instance = a.chart;
    const { onAxisRangesChange, onFollowStop, onViewWindowChange } = mountPlot({
      following: true,
    });
    a.dispose();
    // CanopyChart drops these before they reach SinglePlot; deliver them
    // anyway so SinglePlot doesn't depend on that filter.
    emit('finished', a.chart);
    emit('datazoom', a.chart);
    vi.advanceTimersByTime(400);
    expect(onAxisRangesChange).not.toHaveBeenCalled();
    expect(onFollowStop).not.toHaveBeenCalled();
    expect(onViewWindowChange).not.toHaveBeenCalled();
  });
});
