// @vitest-environment jsdom
//
// The statistics panel under a Trace plot: absent until the plot's Show
// statistics is on, then one readout row per visible curve over the view
// window, in tabs mode and in every grid cell.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { msToNs } from '../api/time';
import { newPlot, newTrace, unitAxis } from '../embed/plotConfig';
import type { LiveSeriesResult } from '../hooks/useLiveSeries';
import type { Plot } from '../types';

vi.mock('echarts-for-react', () => ({
  default: () => <div data-testid="echarts" />,
}));

const { PlotArea } = await import('./PlotArea');

afterEach(cleanup);

const T0 = Date.UTC(2026, 9, 15, 12, 0, 0);
const AXIS = unitAxis('p1-axis-1', 0, 'mA');

function plotWith(over: Partial<Plot>): Plot {
  const plot = newPlot('p1', 0);
  return {
    ...plot,
    axes: [AXIS],
    traces: [
      { ...newTrace('a', 'TEST:A', AXIS.id, '#123456', []), useArchive: false },
      { ...newTrace('b', 'TEST:B', AXIS.id, '#654321', []), useArchive: false },
    ],
    ...over,
  };
}

function live(points: [number, number][]): LiveSeriesResult {
  return {
    status: 'connected',
    connected: true,
    severity: null,
    latest: null,
    error: null,
    points: points.map(([time, value]) => ({ time, value, severity: 'NO_ALARM' })),
    breaks: [],
  };
}

const LIVE = new Map([
  [
    'a',
    live([
      [T0 - 3_000, 1],
      [T0 - 2_000, 2],
      [T0 - 1_000, 3],
    ]),
  ],
  ['b', live([[T0 - 1_500, 10]])],
]);

function mount(plot: Plot, viewMode: 'tabs' | 'grid' = 'tabs', more: Plot[] = []) {
  const noop = () => {};
  const plots = [plot, ...more];
  const window = { fromNs: msToNs(T0 - 10_000), toNs: msToNs(T0) };
  return render(
    <PlotArea
      plots={plots}
      activePlotId={plot.id}
      viewMode={viewMode}
      archiveResultsByPlot={new Map()}
      liveResultsByPlot={new Map(plots.map((p) => [p.id, LIVE]))}
      formulaResultsByPlot={new Map()}
      onSetActivePlot={noop}
      onAddPlot={noop}
      onRemovePlot={noop}
      onSetViewMode={noop}
      onPopOutPlot={noop}
      detachedPlotIds={[]}
      onDetachPlot={noop}
      onReattachPlot={noop}
      displayWindowByPlotId={new Map()}
      statsWindowByPlotId={new Map(plots.map((p) => [p.id, window]))}
    />
  );
}

describe('PlotArea statistics', () => {
  it('shows no panel by default', () => {
    mount(plotWith({}));
    expect(screen.getByTestId('echarts')).toBeTruthy();
    expect(screen.queryByTestId('stats-panel')).toBeNull();
  });

  it('docks the readout under the plot when Show statistics is on', () => {
    mount(plotWith({ showStats: true }));
    const panel = screen.getByTestId('stats-panel');
    expect(panel).toBeTruthy();
    const heads = [...panel.querySelectorAll('thead th')].map((th) => th.textContent);
    expect(heads).toEqual(['Curve', 'n', 'mean', 'std', 'min', 'max']);
    const a = [...screen.getByTestId('readout-a').querySelectorAll('td')].map(
      (td) => td.textContent
    );
    expect(a).toEqual(['3', '2.000 mA', '1.000 mA', '1.000 mA', '3.000 mA']);
    const b = [...screen.getByTestId('readout-b').querySelectorAll('td')].map(
      (td) => td.textContent
    );
    expect(b[0]).toBe('1');
    expect(b[2]).toBe('–');
  });

  it('shows the distribution block only with Show distribution on', () => {
    mount(plotWith({ showStats: true }));
    expect(screen.queryByTestId('stats-distribution')).toBeNull();
    cleanup();
    mount(plotWith({ showStats: true, showDist: true }));
    const block = screen.getByTestId('stats-distribution');
    expect(block.querySelectorAll('[data-testid="echarts"]').length).toBeGreaterThan(0);
    cleanup();
    // Off its own, the distribution needs the panel: nothing without Show statistics.
    mount(plotWith({ showDist: true }));
    expect(screen.queryByTestId('stats-panel')).toBeNull();
  });

  it('every grid cell carries its own panel, following its own plot', () => {
    const other = { ...plotWith({}), id: 'p2', title: 'Plot 2' };
    mount(plotWith({ showStats: true }), 'grid', [other]);
    const cells = screen.getAllByTestId('plot-with-statistics');
    expect(cells).toHaveLength(2);
    expect(cells[0].querySelector('[data-testid="stats-panel"]')).not.toBeNull();
    expect(cells[1].querySelector('[data-testid="stats-panel"]')).toBeNull();
  });

  it('resolves its own window when the caller passes none', () => {
    const plot = plotWith({ showStats: true, xAxis: { timeRange: '-1h' } });
    const nowLive = new Map([
      [
        'a',
        live([
          [Date.now() - 2_000, 1],
          [Date.now() - 1_000, 3],
        ]),
      ],
    ]);
    const noop = () => {};
    render(
      <PlotArea
        plots={[plot]}
        activePlotId={plot.id}
        viewMode="tabs"
        archiveResultsByPlot={new Map()}
        liveResultsByPlot={new Map([[plot.id, nowLive]])}
        formulaResultsByPlot={new Map()}
        onSetActivePlot={noop}
        onAddPlot={noop}
        onRemovePlot={noop}
        onSetViewMode={noop}
        onPopOutPlot={noop}
        detachedPlotIds={[]}
        onDetachPlot={noop}
        onReattachPlot={noop}
        displayWindowByPlotId={new Map()}
      />
    );
    const a = [...screen.getByTestId('readout-a').querySelectorAll('td')].map(
      (td) => td.textContent
    );
    expect(a[0]).toBe('2');
  });
});
