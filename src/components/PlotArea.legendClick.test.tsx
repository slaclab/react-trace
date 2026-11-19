// @vitest-environment jsdom
//
// A left-click on a legend entry toggles nothing, as on main (where the legend
// was not selectable). The legend is selectable only so a right-click opens the
// curve's menu (`LegendMenu`), so SinglePlot swallows a click in the capture
// phase while the pointer is over an entry: the chart never sees it, and the
// curve stays drawn in step with its card. Off an entry, clicks go through.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { SinglePlot } from './PlotArea';
import type { Plot } from '../types';
import { chartStub, fireChartEvent } from '../test/chartStub';
import { newTrace } from '../embed/plotConfig';

vi.mock('@slaclab/canopy-charts', async (importOriginal) =>
  (await import('../test/chartStub')).mockCanopyCharts(importOriginal)
);

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  chartStub.instance = undefined;
  chartStub.props = null;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function makePlot(): Plot {
  return {
    id: 'p1',
    title: 'Plot 1',
    traces: [newTrace('t1', 'TEST:SINE', 'ax1', '#0f62fe', [])],
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
    showLegend: true,
    showXGridlines: false,
    showYGridlines: false,
    showCrosshair: false,
    gridStyle: 'solid',
    gridOpacity: 1,
    tickFontSize: 11,
    xAxis: { timeRange: '1h' },
  };
}

const legendParams = (name: string) => ({ componentType: 'legend', value: name });

function mount() {
  const { getByTestId } = render(
    <SinglePlot
      plot={makePlot()}
      archiveResults={new Map()}
      liveResults={new Map()}
      formulaResults={new Map()}
      annotationsHidden
    />
  );
  // The chart's own click listener: what ECharts would toggle the legend from.
  const chartEl = getByTestId('chart');
  const chartClick = vi.fn();
  chartEl.addEventListener('click', chartClick);
  return { chartEl, chartClick };
}

describe('legend left-click', () => {
  it('a click over a legend entry never reaches the chart', () => {
    const { chartEl, chartClick } = mount();
    act(() => fireChartEvent('mouseover', legendParams('TEST:SINE')));
    fireEvent.click(chartEl);
    expect(chartClick).not.toHaveBeenCalled();
  });

  it('a click off the legend still reaches the chart', () => {
    const { chartEl, chartClick } = mount();
    fireEvent.click(chartEl);
    expect(chartClick).toHaveBeenCalledTimes(1);
    act(() => fireChartEvent('mouseover', legendParams('TEST:SINE')));
    act(() => fireChartEvent('mouseout', legendParams('TEST:SINE')));
    fireEvent.click(chartEl);
    expect(chartClick).toHaveBeenCalledTimes(2);
  });
});
