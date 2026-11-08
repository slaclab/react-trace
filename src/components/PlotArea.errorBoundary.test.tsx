// @vitest-environment jsdom
//
// A chart that throws while rendering shows the error fallback in its own
// place only: the plot tabs, the view toggle and the grid cells' buttons stay
// usable, so the user can switch to a healthy plot, or remove or detach the
// broken one.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { PlotArea } from './PlotArea';
import type { Plot, PVTrace } from '../types';

// echarts-for-react replaced by a stand-in that throws for any chart showing a
// trace named BOOM, and otherwise renders a marker.
vi.mock('echarts-for-react', async () => {
  const React = await import('react');
  class MockECharts extends React.Component<{ option: { series?: { name?: string }[] } }> {
    getEchartsInstance() {
      return undefined;
    }
    render() {
      if ((this.props.option.series ?? []).some((s) => s.name === 'BOOM')) {
        throw new Error('chart exploded');
      }
      return React.createElement('div', { 'data-testid': 'chart' });
    }
  }
  return { default: MockECharts };
});

function trace(displayName: string): PVTrace {
  return {
    id: `t-${displayName}`,
    pvName: 'TEST:PV',
    displayName,
    color: '#33b1ff',
    visible: true,
    axisId: 'ax1',
    useLive: false,
    updateRate: '1s',
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

function makePlot(id: string, traceName: string): Plot {
  return {
    id,
    title: `Plot ${id}`,
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

const plots = [makePlot('bad', 'BOOM'), makePlot('good', 'fine')];

function renderArea(activePlotId: string, viewMode: 'tabs' | 'grid') {
  return render(
    <PlotArea
      plots={plots}
      activePlotId={activePlotId}
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
      viewWindowByPlot={new Map()}
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

describe('PlotArea chart error boundaries', () => {
  it('keeps the plot tabs and view controls when the active chart crashes', () => {
    const view = renderArea('bad', 'tabs');

    expect(screen.getByText('Something went wrong')).toBeTruthy();
    expect(screen.getByText('chart exploded')).toBeTruthy();
    expect(screen.getByText('Plot good')).toBeTruthy();
    expect(screen.getByTitle('Grid view')).toBeTruthy();
    expect(screen.getByTitle('Add plot')).toBeTruthy();

    // Switching to the healthy plot renders its chart.
    view.rerender(
      <PlotArea
        plots={plots}
        activePlotId="good"
        viewMode="tabs"
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
        viewWindowByPlot={new Map()}
        axisEndFor={() => Date.now()}
      />
    );
    expect(screen.queryByText('Something went wrong')).toBeNull();
    expect(screen.getByTestId('chart')).toBeTruthy();
  });

  it('confines a crash to its grid cell', () => {
    renderArea('good', 'grid');

    expect(screen.getAllByText('Something went wrong')).toHaveLength(1);
    expect(screen.getAllByTestId('chart')).toHaveLength(1);
    // Both cells keep their buttons, so the broken plot can be removed or detached.
    expect(screen.getAllByTitle('Remove plot')).toHaveLength(2);
    expect(screen.getAllByTitle('Detach to window')).toHaveLength(2);
  });
});
