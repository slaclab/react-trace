// @vitest-environment jsdom
//
// Issue 115: the "Grid View (N plots)" label in the tab bar was hard-coded to
// #c6c6c6, Carbon g100's secondary text colour, which is nearly invisible on
// the light theme's tab bar. It must follow the theme token instead.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { PlotArea } from './PlotArea';
import type { Plot } from '../types';

function makePlot(id: string): Plot {
  return {
    id,
    title: id,
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
    xAxis: { timeRange: '-1h' },
  };
}

describe('grid view label', () => {
  afterEach(cleanup);

  it('uses the theme secondary text colour', () => {
    const plots = [makePlot('p1'), makePlot('p2')];
    render(
      <PlotArea
        plots={plots}
        activePlotId="p1"
        viewMode="grid"
        archiveResultsByPlot={new Map()}
        liveResultsByPlot={new Map()}
        formulaResultsByPlot={new Map()}
        onSetActivePlot={vi.fn()}
        onAddPlot={vi.fn()}
        onRemovePlot={vi.fn()}
        onSetViewMode={vi.fn()}
        onPopOutPlot={vi.fn()}
        // Detached cells render a placeholder instead of a chart, so the test
        // needs no ECharts mock.
        detachedPlotIds={plots.map((p) => p.id)}
        onDetachPlot={vi.fn()}
        onReattachPlot={vi.fn()}
        viewWindowByPlot={new Map()}
      />
    );
    const label = screen.getByText('Grid View (2 plots)');
    expect(label.style.color).toBe('var(--cds-text-secondary)');
  });
});
