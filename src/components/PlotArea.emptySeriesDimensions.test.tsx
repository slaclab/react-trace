// @vitest-environment jsdom
//
// Regression for a blank-screen crash on import (issue #39): ECharts throws
// "dimensions must be given if data is TypedArray" in dev builds whenever a
// typed-array series lacks an explicit `dimensions` hint — which a freshly
// imported live PV hits immediately, since its data starts out empty (or at
// a single sample) before any live/archive batch arrives. Pin that both the
// main line series and the extension-line series always declare it.
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { SinglePlot } from './PlotArea';
import { axisEndMs } from '../hooks/useAutoScrollTimers';
import type { Plot } from '../types';
import type { LiveSeriesResult } from '../hooks/useLiveSeries';
import { chartStub } from '../test/chartStub';

vi.mock('@slaclab/canopy-charts', async (importOriginal) =>
  (await import('../test/chartStub')).mockCanopyCharts(importOriginal)
);

const captured: { series: { id: string; dimensions?: string[] }[] | null } = { series: null };
chartStub.onRender = (props) => {
  captured.series = (props.option as { series: typeof captured.series }).series;
};

const T0 = new Date('2026-10-15T12:00:00Z').getTime();

function makePlot(): Plot {
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
        lineType: 'direct',
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
  };
}

function liveBatch(points: { time: number; value: number }[]): Map<string, LiveSeriesResult> {
  return new Map([
    [
      't1',
      {
        status: 'connected',
        connected: true,
        severity: 'NO_ALARM',
        latest: null,
        error: null,
        points: points.map((p) => ({ ...p, severity: 'NO_ALARM' as const })),
      },
    ],
  ]);
}

function plotEl(plot: Plot, live: Map<string, LiveSeriesResult>) {
  return (
    <SinglePlot
      plot={plot}
      endMs={axisEndMs(plot, T0, true, live)}
      following={true}
      archiveResults={new Map()}
      liveResults={live}
      formulaResults={new Map()}
    />
  );
}

describe('SinglePlot typed-array series dimensions', () => {
  it('declares dimensions on the main line series with no data yet', () => {
    const { unmount } = render(plotEl(makePlot(), new Map()));
    const main = captured.series!.find((s) => s.id === 't1');
    expect(main?.dimensions).toEqual(['x', 'y']);
    unmount();
  });

  it('declares dimensions on the main line series with exactly one sample', () => {
    const { unmount } = render(plotEl(makePlot(), liveBatch([{ time: T0 - 1000, value: 1 }])));
    const main = captured.series!.find((s) => s.id === 't1');
    expect(main?.dimensions).toEqual(['x', 'y']);
    const extension = captured.series!.find((s) => s.id === 't1-extension');
    expect(extension?.dimensions).toEqual(['x', 'y']);
    unmount();
  });
});
