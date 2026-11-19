// @vitest-environment jsdom
//
// SinglePlot under canopy-charts' CanopyChart (issue 105). CanopyChart hands
// over the ECharts instance through onReady, again after any re-init, and never
// reports a disposal. SinglePlot must use the newest instance, treat a disposed
// one as no chart, read event data from the chart that fired the event, and
// ignore events from a chart without a model (not built yet, or disposed).
//
// The chart reports no view window here: the inside dataZoom is retired and
// only the gesture layer writes windows, so SinglePlot binds no `datazoom`
// handler. Stopping a following plot is a window or x-axis write, so the
// event cases check that neither is made.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import type { ECharts } from 'echarts';
import { SinglePlot } from './PlotArea';
import { capturePlotPng } from '../capturePlot';
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

// Drawings are hidden, so the overlay renders no svg and a capture is the
// chart's own image: composing one needs a decoding Image, which jsdom lacks
// (compose is covered in src/plot/capture.test.ts).
function mountPlot({ following = false }: { following?: boolean } = {}) {
  let source: PngSource | null = null;
  const onUpdateAxis = vi.fn();
  const onAxisRangesChange = vi.fn();
  const onApplyXAxis = vi.fn();
  const onViewWindowChange = vi.fn();
  const { container, unmount } = render(
    <SinglePlot
      plot={makePlot()}
      endMs={0}
      following={following}
      onApplyXAxis={onApplyXAxis}
      onViewWindowChange={onViewWindowChange}
      archiveResults={new Map()}
      liveResults={new Map()}
      formulaResults={new Map()}
      onUpdateAxis={onUpdateAxis}
      onAxisRangesChange={onAxisRangesChange}
      annotationsHidden
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
    onApplyXAxis,
    onViewWindowChange,
    unmount,
    png: () => source!.getDataURL(),
  };
}

// Print and PNG export, with drawings hidden (see mountPlot).
const print = () => capturePlotPng(makePlot(), 'dark', false, true);

// jsdom reports a 0,0 bounding rect for the wrapper, so clientX/clientY are
// chart pixels; x=30 is over the left axis band.
const wheelOverAxis = (wrap: Element) =>
  fireEvent.wheel(wrap, { clientX: 30, clientY: 200, deltaY: 100 });

// Animation frames, flushed by hand: an axis drag writes once per frame.
let frames = new Map<number, FrameRequestCallback>();
let nextFrame = 1;
function flushFrames() {
  act(() => {
    for (let round = 0; round < 5 && frames.size > 0; round++) {
      const due = [...frames.values()];
      frames = new Map();
      due.forEach((cb) => cb(performance.now()));
    }
  });
}

// A press on the left axis band, dragged 100 px up and released. A press
// alone writes nothing: the stretch starts once the pointer moves.
function dragAxis(wrap: Element) {
  fireEvent.mouseDown(wrap, { clientX: 30, clientY: 200, button: 0 });
  fireEvent.mouseMove(window, { clientX: 30, clientY: 100, buttons: 1 });
  flushFrames();
  fireEvent.mouseUp(window);
  flushFrames();
}

// Call SinglePlot's handler for a chart event straight from the latest
// render's props, with the chart that fired it. Unlike CanopyChart (and
// fireChartEvent), this delivers events from a disposed chart too.
const emit = (name: 'finished', chart: object) =>
  act(() => chartStub.props!.onEvents![name]!({}, chart as unknown as ECharts));

// The chart's view window is never read from a `datazoom` event.
const boundEvents = () => Object.keys(chartStub.props!.onEvents ?? {});

beforeEach(() => {
  cleanup();
  chartStub.instance = undefined;
  frames = new Map();
  nextFrame = 1;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    const id = nextFrame++;
    frames.set(id, cb);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frames.delete(id);
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('SinglePlot chart instance', () => {
  it('captures from the instance CanopyChart reported ready', async () => {
    const a = fakeChart('data:image/png;base64,QQ==');
    chartStub.instance = a.chart;
    const { png } = mountPlot();
    expect(await png()).toBe('data:image/png;base64,QQ==');
  });

  it('has nothing to capture before the chart is ready', async () => {
    const { png } = mountPlot();
    expect(await png()).toBe('');
    expect(await print()).toBeNull();
  });

  it('switches to the new instance after the chart is re-created', async () => {
    const a = fakeChart('data:image/png;base64,QQ==');
    const b = fakeChart('data:image/png;base64,Qg==');
    chartStub.instance = a.chart;
    const { png } = mountPlot();
    act(() => {
      a.dispose();
      chartStub.props!.onReady!(b.chart as unknown as ECharts);
    });
    expect(await png()).toBe('data:image/png;base64,Qg==');
    expect(a.chart.getDataURL).not.toHaveBeenCalled();
  });

  it('prints from the instance CanopyChart reported ready', async () => {
    const a = fakeChart('data:image/png;base64,QQ==');
    const b = fakeChart('data:image/png;base64,Qg==');
    chartStub.instance = a.chart;
    const { unmount } = mountPlot();
    expect(await print()).toBe('data:image/png;base64,QQ==');
    act(() => {
      a.dispose();
      chartStub.props!.onReady!(b.chart as unknown as ECharts);
    });
    expect(await print()).toBe('data:image/png;base64,Qg==');
    expect(a.chart.getDataURL).toHaveBeenCalledTimes(1);
    unmount();
    expect(await print()).toBeNull();
  });

  it('treats a disposed instance as no chart', async () => {
    const a = fakeChart('data:image/png;base64,QQ==');
    chartStub.instance = a.chart;
    const { wrap, onUpdateAxis, png } = mountPlot();
    wheelOverAxis(wrap);
    expect(onUpdateAxis).toHaveBeenCalled();
    onUpdateAxis.mockClear();
    dragAxis(wrap);
    expect(onUpdateAxis).toHaveBeenCalled();
    onUpdateAxis.mockClear();

    a.dispose();
    wheelOverAxis(wrap);
    dragAxis(wrap);
    expect(onUpdateAxis).not.toHaveBeenCalled();
    expect(await png()).toBe('');
    expect(await print()).toBeNull();
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
    dragAxis(wrap);
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

  it('takes no view window from the chart', () => {
    chartStub.instance = fakeChart('data:,').chart;
    mountPlot({ following: true });
    expect(boundEvents()).toContain('finished');
    expect(boundEvents()).not.toContain('datazoom');
  });

  it('ignores events from a chart that has no model yet', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    chartStub.instance = fakeChart('data:,').chart;
    const { onAxisRangesChange, onApplyXAxis, onViewWindowChange } = mountPlot({
      following: true,
    });
    // echarts-for-react's throwaway measuring instance can fire before its
    // model exists.
    const measuring = { ...fakeChart('data:,').chart, getModel: () => undefined };
    emit('finished', measuring);
    vi.advanceTimersByTime(400);
    expect(onAxisRangesChange).not.toHaveBeenCalled();
    expect(onApplyXAxis).not.toHaveBeenCalled();
    expect(onViewWindowChange).not.toHaveBeenCalled();
  });

  it('ignores events from a disposed chart even if they get through', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const a = fakeChart('data:,');
    chartStub.instance = a.chart;
    const { onAxisRangesChange, onApplyXAxis, onViewWindowChange } = mountPlot({
      following: true,
    });
    a.dispose();
    // CanopyChart drops these before they reach SinglePlot; deliver them
    // anyway so SinglePlot doesn't depend on that filter.
    emit('finished', a.chart);
    vi.advanceTimersByTime(400);
    expect(onAxisRangesChange).not.toHaveBeenCalled();
    expect(onApplyXAxis).not.toHaveBeenCalled();
    expect(onViewWindowChange).not.toHaveBeenCalled();
  });
});
