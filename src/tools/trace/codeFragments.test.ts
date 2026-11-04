// Trace's chart source comes from the same builder that feeds the
// chart: the plot's option without series, data elided.
import { describe, expect, it } from 'vitest';
import type { Axis, Plot, PVTrace } from '../../types';
import { drawingThemeFor } from '../../annotationTheme';
import { plotCodeFragment, selectPlotFragment, type TraceFragmentInput } from './codeFragments';

function makeTrace(overrides: Partial<PVTrace> = {}): PVTrace {
  return {
    id: 't1',
    pvName: 'TEST:CURRENT',
    displayName: '',
    color: '#0f62fe',
    visible: true,
    axisId: 'ax1',
    useLive: false,
    useArchive: false,
    lineWidth: 2,
    lineType: 'step',
    lineStyle: 'solid',
    showSymbol: false,
    symbolShape: 'circle',
    symbolSize: 4,
    data: [
      { time: 1_000, value: 1 },
      { time: 2_000, value: 2 },
      { time: 3_000, value: 3 },
    ],
    ...overrides,
  };
}

function makeAxis(overrides: Partial<Axis> = {}): Axis {
  return {
    id: 'ax1',
    name: 'Current',
    orientation: 'left',
    autoScale: true,
    logScale: false,
    visible: true,
    ...overrides,
  };
}

function makePlot(traces: PVTrace[], axes: Axis[] = [makeAxis()]): Plot {
  return {
    id: 'p1',
    title: 'Plot 1',
    traces,
    axes,
    backgroundColor: 'default',
    showLegend: true,
    showXGridlines: false,
    showYGridlines: true,
    showCrosshair: false,
    gridStyle: 'solid',
    gridOpacity: 1,
    tickFontSize: 11,
    xAxis: { timeRange: '1h' },
  };
}

function input(plot: Plot): TraceFragmentInput {
  return {
    plot,
    archiveResults: new Map(),
    liveResults: new Map(),
    formulaResults: new Map(),
    theme: drawingThemeFor('light'),
  };
}

describe('plot fragment', () => {
  it('is the top-level option without series', () => {
    const plot = makePlot([makeTrace()]);
    const fragment = selectPlotFragment(input(plot));
    expect(fragment).not.toHaveProperty('series');
    const text = plotCodeFragment(input(plot));
    expect(text).not.toContain('series');
    expect(text).toContain('xAxis: {');
    expect(text).toContain('yAxis: [');
    expect(text).toContain('legend: {');
    // Data never reaches the page; formatters are dropped.
    expect(text).toContain('data: /* 1 points */');
    expect(text).not.toContain('formatter');
  });
});
