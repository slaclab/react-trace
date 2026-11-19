// @vitest-environment jsdom
//
// The drawing rail floats over the plot's left gutter (2 to 32 px in), where
// Trace draws its left Y axes' names. Without room for it, the outermost
// name sat about 5 px in, under the rail. While the plot shows the rail, the
// left gutter widens until that name clears it, for one left axis or
// several; without the rail (Drawing tools off, the Code tab) the grid keeps
// its old inset. Measured on the chart ECharts lays out.
import { describe, expect, it } from 'vitest';
import * as echarts from 'echarts';
import { drawingThemeFor } from '../annotationTheme';
import { RAIL_RIGHT } from '../annotations/railMetrics';
import type { Axis, Plot } from '../types';
import { buildPlotOption, plotLayout } from './plotOption';
import { AXIS_OFFSET } from './axisHitTest';

function axis(i: number, orientation: 'left' | 'right' = 'left'): Axis {
  return {
    id: `a${i}`,
    name: `Axis name ${i}`,
    orientation,
    autoScale: true,
    logScale: false,
    visible: true,
  };
}

function plot(axes: Axis[]): Plot {
  return {
    id: 'p1',
    title: 'Plot',
    xAxis: { timeRange: '-1h' },
    axes,
    traces: [],
  } as unknown as Plot;
}

interface Rect {
  x: number;
  applyTransform(m: unknown): void;
  clone(): Rect;
}

/** A drawn zrender element, as far as the test reads it. */
interface DrawnEl {
  style?: { text?: string };
  getBoundingRect(): Rect;
  getComputedTransform(): unknown;
}

/** The left edge (canvas px) of the drawn axis name `name`. */
function nameLeft(p: Plot, railRight: number, name: string): number {
  const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 700, height: 400 });
  try {
    const option = buildPlotOption({
      plot: p,
      archiveResults: new Map(),
      liveResults: new Map(),
      formulaResults: new Map(),
      theme: drawingThemeFor('dark'),
      endMs: Date.parse('2026-06-05T12:00:00Z'),
      railRight,
    });
    chart.setOption(option as unknown as echarts.EChartsOption);
    const list = (
      chart.getZr() as unknown as { storage: { getDisplayList(update: boolean): DrawnEl[] } }
    ).storage.getDisplayList(true);
    const el = list.find((e) => e.style?.text === name);
    if (!el) throw new Error(`no drawn name ${name}`);
    const rect = el.getBoundingRect().clone();
    rect.applyTransform(el.getComputedTransform());
    return rect.x;
  } finally {
    chart.dispose();
  }
}

describe('the outermost left axis name and the drawing rail', () => {
  it.each([1, 2, 3])('clears the rail with %i left axes', (n) => {
    const axes = Array.from({ length: n }, (_, i) => axis(i + 1));
    expect(nameLeft(plot(axes), RAIL_RIGHT, `Axis name ${n}`)).toBeGreaterThanOrEqual(RAIL_RIGHT);
  });

  it('was under the rail without the gutter', () => {
    expect(nameLeft(plot([axis(1)]), 0, 'Axis name 1')).toBeLessThan(RAIL_RIGHT);
  });

  it('keeps the old inset without the rail or without a left axis', () => {
    expect(plotLayout([axis(1), axis(2)]).gridLeft).toBe(70 + AXIS_OFFSET);
    expect(plotLayout([axis(1, 'right')], RAIL_RIGHT).gridLeft).toBe(70);
  });

  it('gives the option and the hit-zones the same grid', () => {
    const axes = [axis(1), axis(2)];
    const option = buildPlotOption({
      plot: plot(axes),
      archiveResults: new Map(),
      liveResults: new Map(),
      formulaResults: new Map(),
      theme: drawingThemeFor('dark'),
      endMs: 0,
      railRight: RAIL_RIGHT,
    });
    expect((option.grid as { left: number }).left).toBe(plotLayout(axes, RAIL_RIGHT).gridLeft);
  });
});
