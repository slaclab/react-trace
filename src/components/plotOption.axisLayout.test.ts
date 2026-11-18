// @vitest-environment jsdom
//
// Two Y axes on one side, one of them panned to a range with raw edges (what a
// Y-axis drag writes). ECharts 6 by default moves the grid so axis labels stay
// inside the chart ("outer bounds"), so a long edge label shifted the whole
// plot sideways while panning: the axes and their names jittered, and the
// axis hit-zones, which use the grid Trace sets (`plotLayout`), stopped
// matching the drawn axes, so a drag could land on the wrong axis. The grid
// now stays where Trace puts it, and a panned axis rounds its edge labels.
import { describe, expect, it } from 'vitest';
import * as echarts from 'echarts';
import { drawingThemeFor } from '../annotationTheme';
import type { Plot } from '../types';
import { buildPlotOption, plotLayout } from './plotOption';

const T = Date.parse('2026-06-05T12:00:00Z');

function plot(alarm: { min?: number; max?: number }): Plot {
  const manual = alarm.min !== undefined;
  return {
    id: 'p1',
    title: 'Plot',
    xAxis: { timeRange: '-1h' },
    axes: [
      {
        id: 'a1',
        name: 'Sine',
        orientation: 'left',
        autoScale: true,
        logScale: false,
        visible: true,
      },
      {
        id: 'a2',
        name: 'Alarm',
        orientation: 'left',
        autoScale: !manual,
        logScale: false,
        visible: true,
        ...alarm,
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
          { time: T - 60_000, value: -1, severity: 'NO_ALARM' },
          { time: T, value: 1, severity: 'NO_ALARM' },
        ],
      },
      {
        id: 't2',
        pvName: 'TEST:ALARM',
        displayName: '',
        color: '#198038',
        visible: true,
        axisId: 'a2',
        useLive: false,
        useArchive: false,
        lineWidth: 2,
        lineType: 'linear',
        lineStyle: 'solid',
        showSymbol: false,
        symbolShape: 'circle',
        symbolSize: 10,
        data: [
          { time: T - 60_000, value: 0, severity: 'NO_ALARM' },
          { time: T, value: 100, severity: 'NO_ALARM' },
        ],
      },
    ],
  } as unknown as Plot;
}

function option(p: Plot) {
  return buildPlotOption({
    plot: p,
    archiveResults: new Map(),
    liveResults: new Map(),
    formulaResults: new Map(),
    theme: drawingThemeFor('dark'),
    endMs: T + 60_000,
  });
}

/** The grid rectangle ECharts actually lays the plot out in. */
function drawnGridLeft(p: Plot): number {
  const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 700, height: 400 });
  try {
    chart.setOption(option(p) as unknown as echarts.EChartsOption);
    const grid = (
      chart as unknown as {
        getModel(): {
          getComponent(t: string): { coordinateSystem: { getRect(): { x: number } } };
        };
      }
    )
      .getModel()
      .getComponent('grid');
    return grid.coordinateSystem.getRect().x;
  } finally {
    chart.dispose();
  }
}

describe('two Y axes on the left, one panned to raw edges', () => {
  const panned = { min: 9.63855421686747, max: 109.63855421686748 };

  it('keeps the grid where the axis hit-zones expect it', () => {
    const { gridLeft } = plotLayout(plot(panned).axes);
    expect(drawnGridLeft(plot({}))).toBe(gridLeft);
    expect(drawnGridLeft(plot(panned))).toBe(gridLeft);
  });

  it("rounds the panned axis's edge labels to its span", () => {
    const yAxis = option(plot(panned)).yAxis as Array<{
      axisLabel: { formatter: (v: number) => string };
    }>;
    const fmt = yAxis[1].axisLabel.formatter;
    expect(fmt(panned.max)).toBe('109.6');
    expect(fmt(panned.min)).toBe('9.6');
    // Ticks inside the range keep their own text.
    expect(fmt(60)).toBe('60');
  });

  it('rounds a narrow span finer', () => {
    const yAxis = option(plot({ min: -0.6140578313253012, max: 1.3855421686746987 }))
      .yAxis as Array<{ axisLabel: { formatter: (v: number) => string } }>;
    expect(yAxis[1].axisLabel.formatter(1.3855421686746987)).toBe('1.386');
    expect(yAxis[1].axisLabel.formatter(-0.6140578313253012)).toBe('-0.614');
  });
});
