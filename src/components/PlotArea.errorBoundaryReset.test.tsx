// @vitest-environment jsdom
//
// A chart that crashed recovers once the plot's settings change, without
// "Try again": undoing the change that broke it (switching a hidden axis back
// on, say) renders the chart again, in tab view and in grid view.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { PlotArea } from './PlotArea';
import type { Plot, PVTrace } from '../types';
import { chartStub } from '../test/chartStub';

// CanopyChart replaced by a stand-in that throws for any chart showing a trace
// named BOOM, and otherwise renders a marker.
vi.mock('@slaclab/canopy-charts', async (importOriginal) =>
  (await import('../test/chartStub')).mockCanopyCharts(importOriginal)
);
chartStub.onRender = ({ option }) => {
  const series = (option as { series?: { name?: string }[] }).series ?? [];
  if (series.some((s) => s.name === 'BOOM')) throw new Error('chart exploded');
};

function trace(displayName: string): PVTrace {
  return {
    id: 't1',
    pvName: 'TEST:SINE',
    displayName,
    color: '#33b1ff',
    visible: true,
    axisId: 'ax1',
    useLive: false,
    useArchive: false,
    lineWidth: 1,
    lineType: 'direct',
    lineStyle: 'solid',
    showSymbol: false,
    symbolShape: 'none',
    symbolSize: 4,
    data: [{ time: Date.now(), value: 1 }],
  };
}

// The same plot (same id) in two states: one that crashes the chart, one that doesn't.
function plot(traceName: string): Plot {
  return {
    id: 'p1',
    title: 'Plot 1',
    traces: [trace(traceName)],
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
    backgroundColor: '#161616',
    showLegend: false,
    showXGridlines: false,
    showYGridlines: false,
    showCrosshair: false,
    gridStyle: 'solid',
    gridOpacity: 1,
    tickFontSize: 11,
    xAxis: { timeRange: '-1h' },
  };
}

function area(plots: Plot[], viewMode: 'tabs' | 'grid') {
  return (
    <PlotArea
      plots={plots}
      activePlotId="p1"
      viewMode={viewMode}
      archiveResultsByPlot={new Map()}
      liveResultsByPlot={new Map()}
      formulaResultsByPlot={new Map()}
      onSetActivePlot={vi.fn()}
      onAddPlot={vi.fn()}
      onRemovePlot={vi.fn()}
      onSetViewMode={vi.fn()}
      onPopOutPlot={vi.fn()}
      detachedPlotIds={[]}
      onDetachPlot={vi.fn()}
      onReattachPlot={vi.fn()}
      displayWindowByPlotId={new Map()}
      axisEndFor={() => Date.now()}
    />
  );
}

beforeEach(() => {
  // React reports the caught render error on the console.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('a crashed chart recovers when its plot changes', () => {
  it.each(['tabs', 'grid'] as const)('%s view', (viewMode) => {
    const view = render(area([plot('BOOM')], viewMode));
    expect(screen.getByText('Something went wrong')).toBeTruthy();

    view.rerender(area([plot('fine')], viewMode));
    expect(screen.queryByText('Something went wrong')).toBeNull();
    expect(screen.getByTestId('chart')).toBeTruthy();
  });

  it('stays on the error while the plot is unchanged', () => {
    const broken = [plot('BOOM')];
    const view = render(area(broken, 'tabs'));
    view.rerender(area(broken, 'tabs'));
    expect(screen.getByText('Something went wrong')).toBeTruthy();
  });
});
