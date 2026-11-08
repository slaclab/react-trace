// @vitest-environment jsdom
//
// SinglePlot under canopy-charts' CanopyChart (issue 105). CanopyChart hands
// over the ECharts instance through onReady, again after any re-init, and never
// reports a disposal. SinglePlot must use the newest instance, treat a disposed
// one as no chart, and read event data from the chart that fired the event.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import type { ECharts } from 'echarts';
import { SinglePlot } from './PlotArea';
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
  const chart = {
    isDisposed: () => disposed,
    getDataURL: vi.fn(() => dataUrl),
    getWidth: () => 800,
    getHeight: () => 400,
    getZr: () => ({ setCursorStyle: () => {} }),
    getModel: () => ({
      getComponent: () => ({ axis: { scale: { getExtent: (): [number, number] => [lo, hi] } } }),
    }),
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

function mountPlot() {
  let source: PngSource | null = null;
  const onUpdateAxis = vi.fn();
  const onAxisRangesChange = vi.fn();
  const { container } = render(
    <SinglePlot
      plot={makePlot()}
      endMs={0}
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
  return { wrap, onUpdateAxis, onAxisRangesChange, png: () => source!.getDataURL() };
}

// jsdom reports a 0,0 bounding rect for the wrapper, so clientX/clientY are
// chart pixels; x=30 is over the left axis band.
const wheelOverAxis = (wrap: Element) =>
  fireEvent.wheel(wrap, { clientX: 30, clientY: 200, deltaY: 100 });

beforeEach(() => {
  cleanup();
  chartStub.instance = undefined;
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

  it('reads axis ranges from the chart that fired `finished`', () => {
    chartStub.instance = fakeChart('data:,').chart;
    const { onAxisRangesChange } = mountPlot();
    const fired = fakeChart('data:,', [5, 7]).chart;
    act(() => chartStub.props!.onEvents!.finished!({}, fired as unknown as ECharts));
    expect(onAxisRangesChange).toHaveBeenLastCalledWith(new Map([['ax1', [5, 7]]]));
  });
});
