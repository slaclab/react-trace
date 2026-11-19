// @vitest-environment jsdom
//
// Hiding the plot's only Y axis (the eye beside "Signals" when a plot has one
// axis) left the option with a time axis and `yAxis: []`. PlotArea updates the
// chart with `replaceMerge: ['series', 'yAxis']`, so the old Y axis went and
// the time axis was left without a partner: ECharts 6 builds no cartesian for
// it and throws "Cannot read properties of undefined (reading 'group')" while
// drawing the axis. The plot's error boundary then showed "Something went
// wrong". The option is handed to a server-side ECharts instance, updated the
// way PlotArea updates it.
import { describe, expect, it } from 'vitest';
import * as echarts from 'echarts';
import { drawingThemeFor } from '../annotationTheme';
import type { Plot } from '../types';
import { buildPlotOption } from './plotOption';

const T = Date.parse('2026-06-05T12:00:00Z');

function plot(axisVisible: boolean): Plot {
  return {
    id: 'p1',
    title: 'Plot',
    xAxis: { timeRange: '-1h' },
    axes: [
      {
        id: 'a1',
        name: 'Y',
        orientation: 'left',
        autoScale: true,
        logScale: false,
        visible: axisVisible,
      },
    ],
    traces: [
      {
        id: 't1',
        pvName: 'TEST:SINE',
        displayName: '',
        color: '#0f62fe',
        visible: true,
        axisId: 'a1',
        useLive: false,
        useArchive: false,
        lineWidth: 2,
        lineType: 'linear',
        lineStyle: 'solid',
        showSymbol: false,
        symbolShape: 'circle',
        symbolSize: 10,
        data: [
          { time: T - 60_000, value: 1, severity: 'NO_ALARM' },
          { time: T, value: 2, severity: 'NO_ALARM' },
        ],
      },
    ],
  } as unknown as Plot;
}

function option(axisVisible: boolean) {
  return buildPlotOption({
    plot: plot(axisVisible),
    archiveResults: new Map(),
    liveResults: new Map(),
    formulaResults: new Map(),
    theme: drawingThemeFor('dark'),
    endMs: T + 60_000,
  }) as unknown as echarts.EChartsOption;
}

// PlotArea's update mode (CanopyChart `replaceMerge`).
const UPDATE = { replaceMerge: ['series', 'yAxis'] };

describe('a plot whose every Y axis is hidden', () => {
  it('keeps one hidden Y axis, so the time axis still has a grid pair', () => {
    const yAxis = option(false).yAxis as Array<{ show?: boolean }>;
    expect(yAxis).toHaveLength(1);
    expect(yAxis[0].show).toBe(false);
  });

  it('draws no series on the hidden axis', () => {
    expect(option(false).series).toEqual([]);
  });

  it('hides and shows the only axis without ECharts throwing', () => {
    const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 400, height: 300 });
    try {
      chart.setOption(option(true));
      expect(() => chart.setOption(option(false), UPDATE)).not.toThrow();
      expect(() => chart.setOption(option(true), UPDATE)).not.toThrow();
    } finally {
      chart.dispose();
    }
  });

  it('opens with the only axis hidden without ECharts throwing', () => {
    const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 400, height: 300 });
    try {
      expect(() => chart.setOption(option(false))).not.toThrow();
    } finally {
      chart.dispose();
    }
  });
});
