// @vitest-environment jsdom
//
// Line series carry flat [t0, v0, t1, v1, ...] Float64Array data (toSeriesData),
// and ECharts' development build asserts that typed-array data declares its
// `dimensions` ("dimensions must be given if data is TypedArray."). Production
// builds strip the assert, so only `pnpm dev` crashed, as soon as a curve had
// data (#187). The option is handed to a server-side ECharts instance; NODE_ENV
// is "test", so the development asserts are live.
import { describe, expect, it } from 'vitest';
import * as echarts from 'echarts';
import { drawingThemeFor } from '../annotationTheme';
import type { Plot } from '../types';
import { buildPlotOption } from './plotOption';

const T = Date.parse('2026-06-05T12:00:00Z');

function plotWithPoints(lineType: 'step' | 'linear'): Plot {
  return {
    id: 'p1',
    title: 'Plot',
    xAxis: { timeRange: '-1h' },
    axes: [
      { id: 'a1', name: 'Y', orientation: 'left', autoScale: true, logScale: false, visible: true },
    ],
    traces: [
      {
        id: 't1',
        pvName: 'TEST:PV',
        displayName: '',
        color: '#0f62fe',
        visible: true,
        axisId: 'a1',
        useLive: false,
        useArchive: false,
        lineWidth: 2,
        lineType,
        lineStyle: 'solid',
        showSymbol: false,
        symbolShape: 'circle',
        symbolSize: 10,
        data: [
          { time: T - 120_000, value: 1, severity: 'NO_ALARM' },
          { time: T - 60_000, value: 2, severity: 'NO_ALARM' },
          { time: T, value: 3, severity: 'NO_ALARM' },
        ],
      },
    ],
  } as unknown as Plot;
}

type Series = { id: string; type: string; data: unknown; dimensions?: unknown };

describe('typed-array series declare their dimensions', () => {
  it.each(['step', 'linear'] as const)('%s line: every Float64Array series has x/y', (lineType) => {
    const option = buildPlotOption({
      plot: plotWithPoints(lineType),
      archiveResults: new Map(),
      liveResults: new Map(),
      formulaResults: new Map(),
      theme: drawingThemeFor('dark'),
      endMs: T + 60_000,
    });
    const series = option.series as unknown as Series[];
    const typed = series.filter((s) => s.data instanceof Float64Array);
    expect(typed.length).toBeGreaterThan(0);
    for (const s of typed) expect(s.dimensions, s.id).toEqual(['x', 'y']);

    const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 400, height: 300 });
    try {
      expect(() => chart.setOption(option as unknown as echarts.EChartsOption)).not.toThrow();
    } finally {
      chart.dispose();
    }
  });
});
