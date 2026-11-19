import { describe, expect, it } from 'vitest';
import type { TableResultDTO } from '@slaclab/canopy-client';
import { drawingThemeFor } from '../../annotationTheme';
import { yColorMap } from './colors';
import { DEFAULT_MARKER, type CorrelationAxes } from './query';
import {
  correlationAxisPlacement,
  densityYOf,
  PLOT_HEIGHT,
  plotOption,
  shortPv,
  splitGeometry,
  type PlotOptionInput,
} from './plotOption';
import type { FrameLike } from './stats';
import { autoYColor } from '../shared/colors';

const PVS = { x: 'X:PV', y1: 'Y1:PV', y2: 'Y2:PV', y3: 'Y3:PV' };

function frame(columnPvs: Record<string, string> = PVS, rows = 10): FrameLike {
  const tsNs = Array.from({ length: rows }, (_, i) => i * 1e9);
  const columns: Record<string, (number | null)[]> = { x: tsNs.map((_, i) => i + 1) };
  Object.keys(columnPvs)
    .filter((c) => c !== 'x')
    .forEach((c, k) => {
      columns[c] = tsNs.map((_, i) => (k + 1) * (i + 1) + 1);
    });
  const table: TableResultDTO = { tsNs, columns, inputs: {}, totalRows: rows };
  return { table, columnPvs };
}

function option(extra: Partial<PlotOptionInput> = {}) {
  return plotOption({
    frame: frame(),
    view: 'scatter',
    axes: 'shared',
    densityPv: '',
    unitsOf: () => '',
    theme: drawingThemeFor('dark'),
    hidden: new Set(),
    width: 900,
    ...extra,
  });
}

interface SeriesLike {
  type?: string;
  name?: string;
  color?: string;
  symbol?: string;
  symbolSize?: number;
  itemStyle?: { opacity?: number };
}
interface AxisLike {
  type?: string;
  min?: number;
  max?: number;
  splitLine?: { show?: boolean };
  axisPointer?: { show?: boolean };
}

function seriesOf(o: ReturnType<typeof plotOption>): SeriesLike[] {
  return (o.series ?? []) as SeriesLike[];
}
function asArray<T>(v: unknown): T[] {
  return v === undefined ? [] : Array.isArray(v) ? (v as T[]) : [v as T];
}
const scatter = (o: ReturnType<typeof plotOption>) =>
  seriesOf(o).filter((s) => s.type === 'scatter');
const lines = (o: ReturnType<typeof plotOption>) => seriesOf(o).filter((s) => s.type === 'line');

describe('splitGeometry', () => {
  it('one row of panels keeps the usual plot height', () => {
    expect(splitGeometry(2, 1200)).toMatchObject({ columns: 2, rows: 1, height: PLOT_HEIGHT });
  });

  it('wraps to the width, balanced across rows', () => {
    expect(splitGeometry(5, 1200)).toMatchObject({ columns: 3, rows: 2 });
    expect(splitGeometry(8, 1200)).toMatchObject({ columns: 4, rows: 2 });
    expect(splitGeometry(3, 400)).toMatchObject({ columns: 1, rows: 3 });
    expect(splitGeometry(8, 1200).height).toBeGreaterThan(PLOT_HEIGHT);
  });

  it('assumes a width before the chart is measured', () => {
    expect(splitGeometry(3, 0)).toMatchObject({ columns: 3, rows: 1 });
  });
});

describe('shortPv', () => {
  it('keeps the last two segments', () => {
    expect(shortPv('SIM:RF:CAVITY:01:POWER:REV')).toBe('POWER:REV');
    expect(shortPv('A:B')).toBe('A:B');
  });
});

const LAYOUTS: CorrelationAxes[] = ['shared', 'overlay', 'split'];

describe('axis scale', () => {
  it.each(LAYOUTS)('a Y min/max and log apply to every Y axis (%s)', (axes) => {
    const o = option({ axes, yScale: { auto: false, min: 1, max: 100, log: true } });
    const yAxes = asArray<AxisLike>(o.yAxis);
    expect(yAxes.length).toBe(axes === 'shared' ? 1 : 3);
    for (const a of yAxes) expect(a).toMatchObject({ type: 'log', min: 1, max: 100 });
  });

  it.each(LAYOUTS)('the X scale applies to every X axis (%s)', (axes) => {
    const o = option({ axes, xScale: { auto: false, min: -5, max: 5 } });
    for (const a of asArray<AxisLike>(o.xAxis)) {
      expect(a).toMatchObject({ type: 'value', min: -5, max: 5 });
    }
  });

  it('min/max wait for Auto-scale off; absent scale is automatic linear', () => {
    const o = option({ yScale: { min: 1, max: 2 } });
    const y = asArray<AxisLike>(o.yAxis)[0];
    expect(y.type).toBe('value');
    expect(y.min).toBeUndefined();
    expect(y.max).toBeUndefined();
    expect(asArray<AxisLike>(option().xAxis)[0].type).toBe('value');
  });

  it('split panels keep the linked X extent while X is automatic', () => {
    const o = option({ axes: 'split' });
    for (const a of asArray<AxisLike>(o.xAxis)) expect(a).toMatchObject({ min: 1, max: 10 });
  });
});

describe('hidden Ys', () => {
  it.each(LAYOUTS)('a hidden Y has no series and no axis (%s)', (axes) => {
    const o = option({ axes, hidden: new Set(['Y2:PV']) });
    expect(seriesOf(o).some((s) => s.name === 'Y2:PV')).toBe(false);
    expect(scatter(o).map((s) => s.name)).toEqual(['Y1:PV', 'Y3:PV']);
    if (axes !== 'shared') expect(asArray<AxisLike>(o.yAxis).length).toBe(2);
  });

  it('the legend lists only drawn Ys; it is selectable only for the right-click menu', () => {
    const o = option({ hidden: new Set(['Y1:PV']) });
    const legend = asArray<{
      data?: string[];
      selectedMode?: unknown;
      triggerEvent?: unknown;
      show?: boolean;
    }>(o.legend)[0];
    expect(legend.data).toEqual(['Y2:PV', 'Y3:PV']);
    // A left-click toggles nothing: Plot.tsx's LegendMenu swallows it.
    expect(legend.selectedMode).toBe(true);
    expect(legend.triggerEvent).toBe(true);
    expect(legend.show).toBe(true);
  });
});

describe('markers', () => {
  it("a marker record changes only that Y's series", () => {
    const o = option({ markers: { 'Y2:PV': { shape: 'diamond', size: 12, opacity: 0.3 } } });
    const [a, b, c] = scatter(o);
    expect(b).toMatchObject({ symbol: 'diamond', symbolSize: 12, itemStyle: { opacity: 0.3 } });
    for (const s of [a, c]) {
      expect(s).toMatchObject({
        symbol: DEFAULT_MARKER.shape,
        symbolSize: DEFAULT_MARKER.size,
        itemStyle: { opacity: DEFAULT_MARKER.opacity },
      });
    }
  });

  it('a partial record keeps the other fields at their defaults', () => {
    const b = scatter(option({ markers: { 'Y2:PV': { size: 20 } } }))[1];
    expect(b).toMatchObject({ symbol: 'circle', symbolSize: 20, itemStyle: { opacity: 0.8 } });
  });
});

describe('fit lines', () => {
  it('are drawn by default, one per Y', () => {
    expect(lines(option()).map((s) => s.name)).toEqual(['Y1:PV', 'Y2:PV', 'Y3:PV']);
  });

  it('fit off removes the fit series', () => {
    const o = option({ fit: false });
    expect(lines(o)).toEqual([]);
    expect(scatter(o).length).toBe(3);
  });
});

describe('colours', () => {
  it('colours follow PVs when a Y is removed', () => {
    // Y1 removed from the state; the frame on screen still carries it.
    const colors = yColorMap({ ys: ['Y2:PV', 'Y3:PV'], colors: { 'Y3:PV': '#123456' } });
    const o = option({ colors, frame: frame({ x: 'X:PV', y1: 'Y2:PV', y2: 'Y3:PV' }) });
    const byName = Object.fromEntries(scatter(o).map((s) => [s.name, s.color]));
    expect(byName).toEqual({ 'Y2:PV': autoYColor(0), 'Y3:PV': '#123456' });
    const fit = Object.fromEntries(lines(o).map((s) => [s.name, s.color]));
    expect(fit).toEqual(byName);
  });

  it('a hidden neighbour does not recolour the rest', () => {
    const colors = yColorMap({ ys: ['Y1:PV', 'Y2:PV', 'Y3:PV'], colors: {} });
    const o = option({ colors, axes: 'overlay', hidden: new Set(['Y1:PV']) });
    expect(scatter(o).map((s) => s.color)).toEqual([autoYColor(1), autoYColor(2)]);
  });
});

describe('legend, grid and crosshair fields', () => {
  it('defaults: legend shown, gridlines on, crosshair off', () => {
    const o = option();
    expect(asArray<{ show?: boolean }>(o.legend)[0].show).toBe(true);
    const y = asArray<AxisLike>(o.yAxis)[0];
    const x = asArray<AxisLike>(o.xAxis)[0];
    expect(y.splitLine?.show).toBe(true);
    expect(x.splitLine?.show).toBe(true);
    expect(x.axisPointer?.show).toBe(false);
  });

  it('read their fields', () => {
    const o = option({ legend: false, grid: false, crosshair: true });
    expect(asArray<{ show?: boolean }>(o.legend)[0].show).toBe(false);
    for (const a of [...asArray<AxisLike>(o.xAxis), ...asArray<AxisLike>(o.yAxis)]) {
      expect(a.splitLine?.show).toBe(false);
      expect(a.axisPointer?.show).toBe(true);
    }
  });
});

interface SeriesOn extends SeriesLike {
  xAxisIndex?: number;
  yAxisIndex?: number;
}

describe('correlationAxisPlacement', () => {
  const layout = (extra: Partial<PlotOptionInput> = {}) => ({
    frame: frame(),
    view: 'scatter' as const,
    axes: 'shared' as CorrelationAxes,
    densityPv: '',
    hidden: new Set<string>(),
    ...extra,
  });

  it('with Y1 hidden, Y2 maps to overlay axis 0 and split grid 0', () => {
    const hidden = new Set(['Y1:PV']);
    expect(correlationAxisPlacement(layout({ axes: 'overlay', hidden }), 'Y2:PV')).toEqual({
      gridIndex: 0,
      xAxisIndex: 0,
      yAxisIndex: 0,
    });
    expect(correlationAxisPlacement(layout({ axes: 'split', hidden }), 'Y2:PV')).toEqual({
      gridIndex: 0,
      xAxisIndex: 0,
      yAxisIndex: 0,
    });
    expect(correlationAxisPlacement(layout({ axes: 'split', hidden }), 'Y3:PV')).toEqual({
      gridIndex: 1,
      xAxisIndex: 1,
      yAxisIndex: 1,
    });
  });

  it('shared maps every visible Y to 0', () => {
    for (const pv of ['Y1:PV', 'Y2:PV', 'Y3:PV']) {
      expect(correlationAxisPlacement(layout(), pv)).toEqual({
        gridIndex: 0,
        xAxisIndex: 0,
        yAxisIndex: 0,
      });
    }
  });

  it('a hidden, removed or unknown Y maps to null', () => {
    const hidden = new Set(['Y1:PV']);
    for (const axes of LAYOUTS) {
      expect(correlationAxisPlacement(layout({ axes, hidden }), 'Y1:PV')).toBeNull();
      expect(correlationAxisPlacement(layout({ axes }), 'GONE:PV')).toBeNull();
    }
    expect(correlationAxisPlacement(layout({ frame: null }), 'Y1:PV')).toBeNull();
  });

  it('density maps only the density Y, falling back to the first visible Y', () => {
    const d = (densityPv: string, hidden = new Set<string>()) =>
      layout({ view: 'density', axes: 'split', densityPv, hidden });
    expect(correlationAxisPlacement(d('Y2:PV'), 'Y2:PV')).toEqual({
      gridIndex: 0,
      xAxisIndex: 0,
      yAxisIndex: 0,
    });
    expect(correlationAxisPlacement(d('Y2:PV'), 'Y1:PV')).toBeNull();
    // The density Y hidden: the first visible Y is drawn instead.
    const hidden = new Set(['Y1:PV']);
    expect(correlationAxisPlacement(d('Y1:PV', hidden), 'Y2:PV')).not.toBeNull();
    expect(correlationAxisPlacement(d('Y1:PV', hidden), 'Y3:PV')).toBeNull();
    expect(densityYOf(['A', 'B'], 'B')).toBe('B');
    expect(densityYOf(['A', 'B'], 'C')).toBe('A');
    expect(densityYOf([], 'C')).toBeUndefined();
  });

  it.each(LAYOUTS)('agrees with the axes plotOption binds each series to (%s)', (axes) => {
    const hidden = new Set(['Y1:PV']);
    const o = option({ axes, hidden });
    for (const s of scatter(o) as SeriesOn[]) {
      const p = correlationAxisPlacement(layout({ axes, hidden }), s.name as string);
      expect(p).not.toBeNull();
      expect(s.yAxisIndex ?? 0).toBe(p?.yAxisIndex);
      expect(s.xAxisIndex ?? 0).toBe(p?.xAxisIndex);
    }
  });

  it('agrees with the series the density view draws', () => {
    const hidden = new Set(['Y1:PV']);
    const o = option({ view: 'density', densityPv: 'Y1:PV', hidden });
    const drawn = seriesOf(o).map((s) => s.name);
    expect(drawn.length).toBeGreaterThan(0);
    for (const pv of ['Y1:PV', 'Y2:PV', 'Y3:PV']) {
      const placed =
        correlationAxisPlacement(layout({ view: 'density', densityPv: 'Y1:PV', hidden }), pv) !==
        null;
      expect(placed).toBe(drawn.includes(pv));
    }
  });
});
