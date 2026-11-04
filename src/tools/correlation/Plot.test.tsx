// @vitest-environment jsdom
import { fireMouse } from '../../plot/testUtils';
import { PLOT_TOGGLES } from '../../plot/plotToggles';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { useLayoutEffect, useMemo, useState } from 'react';
import { createShedStore } from '../../annotations/host/shedStore';
import {
  useDrawingDocument,
  type DrawingDocument,
} from '../../annotations/host/useDrawingDocument';
import type { Annotation } from '../../annotations/model';
import { firePointer } from '../../plot/testUtils';
import { useCorrelationUi, type CorrelationUiRecord } from './tool';
import type { CorrelationUi } from './schema';
import { createSelectionStore } from '../../workbench/selection';
import { apply } from './edit';
import type { TableResultDTO } from '@slaclab/canopy-client';
import type ReactECharts from 'echarts-for-react';
import ormFrameRaw from './__fixtures__/orm-frame.json?raw';
import { yColumns, type FrameLike } from './stats';
import { downloadCsv } from './export';
import type { CorrelationFrame } from './Plot';
import { drawingThemeFor } from '../../annotationTheme';
import { CORRELATION_METRICS } from './metrics';
import { defaultMetrics, type Metric } from '../../statistics/model';
import {
  defaultCorrelationState,
  type CorrelationAxes,
  type CorrelationState,
  type CorrelationView,
} from './query';

interface AxisOption {
  position?: string;
  offset?: number;
  gridIndex?: number;
  min?: number;
  max?: number;
  axisLabel?: { color?: string };
}

interface Captured {
  className?: string;
  style?: { height?: number };
  option: {
    animation?: boolean;
    legend?: { data: string[]; selected?: Record<string, boolean> };
    grid?: unknown;
    title?: { text: string; textStyle?: { color?: string } }[];
    xAxis?: AxisOption | AxisOption[];
    yAxis?: AxisOption | AxisOption[];
    series: {
      type: string;
      name?: string;
      large?: boolean;
      xAxisIndex?: number;
      yAxisIndex?: number;
      data: unknown[];
    }[];
  };
}

const { rendered, onFinished, overlay } = vi.hoisted(() => ({
  rendered: [] as Captured[],
  onFinished: { current: undefined as undefined | (() => void) },
  /** Commits of the drawing svgs (a Profiler around `DrawingLayers`). */
  overlay: { commits: 0 },
}));

// The drawing svgs, wrapped in a Profiler that counts their commits.
vi.mock('../../annotations/host/DrawingOverlay', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../annotations/host/DrawingOverlay')>();
  const React = await import('react');
  return {
    ...actual,
    DrawingLayers: (props: Parameters<typeof actual.DrawingLayers>[0]) =>
      React.createElement(
        React.Profiler,
        { id: 'overlay', onRender: () => void (overlay.commits += 1) },
        React.createElement(actual.DrawingLayers, props)
      ),
  };
});

// The chart's laid-out geometry: one grid at (80, 36) 500 x 300 with
// x = 0..10 across it and y = 0..30 up it, on every axis index.
const GRID = { x: 80, y: 36, width: 500, height: 300 };
const toPx = (finder: { xAxisIndex?: number; yAxisIndex?: number }, v: number) =>
  finder.xAxisIndex !== undefined
    ? GRID.x + (v / 10) * GRID.width
    : GRID.y + GRID.height - (v / 30) * GRID.height;
const fromPx = (finder: { xAxisIndex?: number; yAxisIndex?: number }, px: number) =>
  finder.xAxisIndex !== undefined
    ? ((px - GRID.x) / GRID.width) * 10
    : ((GRID.y + GRID.height - px) / GRID.height) * 30;
function mockInstance() {
  const listeners = new Map<string, Set<() => void>>();
  return {
    getDataURL: () => 'data:image/png;base64,AAAA',
    getWidth: () => 640,
    getHeight: () => 400,
    isDisposed: () => false,
    convertToPixel: toPx,
    convertFromPixel: fromPx,
    dispatchAction: () => {},
    getModel: () => ({
      getComponent: (type: string) =>
        type === 'grid'
          ? { coordinateSystem: { getRect: () => ({ ...GRID }) } }
          : { axis: { scale: { getExtent: () => (type === 'xAxis' ? [0, 10] : [0, 30]) } } },
    }),
    on: (type: string, cb: () => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)?.add(cb);
    },
    off: (type: string, cb: () => void) => listeners.get(type)?.delete(cb),
    /** Fires `type` to its `on` listeners (the `finished` emitter). */
    emit: (type: string) => listeners.get(type)?.forEach((cb) => cb()),
  };
}

vi.mock('echarts-for-react', async () => {
  const React = await import('react');
  class MockECharts extends React.Component<Captured & { onEvents?: { finished?: () => void } }> {
    instance = mockInstance();
    getEchartsInstance() {
      return this.instance;
    }
    render() {
      rendered.push({
        className: this.props.className,
        style: this.props.style,
        option: this.props.option,
      });
      if (this.props.onEvents?.finished) onFinished.current = this.props.onEvents.finished;
      return React.createElement('div');
    }
  }
  return { default: MockECharts };
});

const { CorrelationCanvas, downloadChartPng, RENDERED_MARK, useCorrelationFrame } =
  await import('./Plot');

const S = 1_000_000_000;
const BASE = 1_790_000_000_000_000_000;
const PVS = { x: 'X:PV', y1: 'Y1:PV', y2: 'Y2:PV' };

function frame(start: number, rows: number): FrameLike {
  const tsNs = Array.from({ length: rows }, (_, i) => BASE + (start + i) * S);
  const table: TableResultDTO = {
    tsNs,
    columns: {
      x: tsNs.map((_, i) => start + i),
      y1: tsNs.map((_, i) => 2 * (start + i) + 1),
      y2: tsNs.map((_, i) => -(start + i)),
    },
    inputs: {},
    totalRows: rows,
  };
  return { table, columnPvs: PVS };
}

function lastPlot(): Captured['option'] {
  const plots = rendered.filter((r) => r.className === 'correlation-plot__chart');
  return plots[plots.length - 1].option;
}

function lastPlotStyle(): Captured['style'] {
  const plots = rendered.filter((r) => r.className === 'correlation-plot__chart');
  return plots[plots.length - 1].style;
}

function asArray<T>(v: T | T[] | undefined): T[] {
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

function framePvs(start: number, rows: number, columnPvs: Record<string, string>): FrameLike {
  const f = frame(start, rows);
  return { ...f, columnPvs };
}

/** The strip charts' titles in the newest render (after `rendered.length = 0`). */
function stripTitles(): string[] {
  return rendered
    .filter((r) => r.className === 'stats-strips__chart')
    .map((r) => (r.option.title as unknown as { text: string }).text);
}

/** The newest strip chart titled `label`. */
function lastStrip(label: string): Captured['option'] {
  const strips = rendered.filter(
    (r) =>
      r.className === 'stats-strips__chart' &&
      (r.option.title as unknown as { text: string }).text === label
  );
  expect(strips.length).toBeGreaterThan(0);
  return strips[strips.length - 1].option;
}

/** The default list with `patch` applied to the metrics named in it. */
function metricsWith(patch: Record<string, Partial<Metric>>): Metric[] {
  return defaultMetrics(CORRELATION_METRICS).map((m) => ({ ...m, ...patch[m.id] }));
}

/** The header texts of the readout table, after the PV column. */
function readoutColumns(): string[] {
  const heads = [...document.querySelectorAll('.stats-readout thead th')];
  return heads.slice(1).map((th) => th.textContent ?? '');
}

let blobs: Blob[];

beforeEach(() => {
  rendered.length = 0;
  blobs = [];
  URL.createObjectURL = vi.fn((b: Blob) => {
    blobs.push(b);
    return 'blob:x';
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

interface ChartProps {
  f: FrameLike | null;
  view?: CorrelationView;
  densityPv?: string;
  axes?: CorrelationAxes;
  metrics?: Metric[];
  hidden?: Record<string, true>;
  unitsOf?: (pv: string) => string;
}

/** What the chart harness exposes: the frame on screen and the chart. */
const chartLive = {
  frame: null as CorrelationFrame | null,
  chart: { current: null as ReactECharts | null },
};

/**
 * The workbench canvas over a state that draws the frame's PVs (X, the Ys in
 * column order, so the automatic colours are positional) with the statistics
 * on, and the view, layout, metrics and hidden Ys given.
 */
function Chart({
  f,
  view = 'scatter',
  densityPv = '',
  axes = 'shared',
  metrics,
  hidden,
  unitsOf = NO_UNITS,
}: ChartProps) {
  const columnPvs = f?.columnPvs;
  const s = useMemo(
    () => ({
      ...defaultCorrelationState(),
      x: columnPvs?.x ?? '',
      ys: columnPvs === undefined ? [] : yColumns(columnPvs).map((c) => columnPvs[c]),
      view,
      dy: densityPv,
      axes,
      readout: true,
      hidden: hidden ?? {},
      ...(metrics === undefined ? {} : { metrics }),
    }),
    [columnPvs, view, densityPv, axes, metrics, hidden]
  );
  const onScreen = useCorrelationFrame(f, s.metrics);
  useLayoutEffect(() => {
    chartLive.frame = onScreen;
  });
  return (
    <CorrelationCanvas
      state={s}
      frame={onScreen}
      unitsOf={unitsOf}
      chartTheme={drawingThemeFor('dark')}
      chartRef={chartLive.chart}
    />
  );
}

function mount(f: FrameLike | null, extra: Partial<ChartProps> = {}) {
  const props: ChartProps = { f, ...extra };
  const utils = render(<Chart {...props} />);
  return {
    ...utils,
    update: (next: Partial<ChartProps>) => {
      Object.assign(props, next);
      utils.rerender(<Chart {...props} />);
    },
  };
}

/** The Clear action as App.tsx registers it: the frame hook's `clear`. */
function clear() {
  act(() => chartLive.frame?.clear());
}

describe('CorrelationCanvas chart', () => {
  it('draws a large scatter and a fit line per Y, without animation', () => {
    mount(frame(0, 5));
    const option = lastPlot();
    expect(option.animation).toBe(false);
    expect(option.legend?.data).toEqual(['Y1:PV', 'Y2:PV']);
    const scatters = option.series.filter((s) => s.type === 'scatter');
    expect(scatters.map((s) => s.name)).toEqual(['Y1:PV', 'Y2:PV']);
    expect(scatters.every((s) => s.large === true)).toBe(true);
    expect(option.series.filter((s) => s.type === 'line')).toHaveLength(2);
  });

  it('no fit line where the slope is undefined (one row)', () => {
    mount(frame(0, 1));
    expect(lastPlot().series.filter((s) => s.type === 'line')).toHaveLength(0);
    expect(screen.getByTestId('readout-y1').textContent).toContain('–');
  });

  it('density view: one hex-bin custom series for the density Y, plus its fit', () => {
    mount(frame(0, 20), { view: 'density', densityPv: 'Y2:PV' });
    const series = lastPlot().series;
    expect(series.filter((s) => s.type === 'custom').map((s) => s.name)).toEqual(['Y2:PV']);
    expect(series.filter((s) => s.type === 'scatter')).toHaveLength(0);
    expect(series.filter((s) => s.type === 'line').map((s) => s.name)).toEqual(['Y2:PV']);
  });

  it('marks nothing without bench=1 in the page URL', () => {
    const mark = vi.spyOn(performance, 'mark');
    mount(frame(0, 3));
    onFinished.current?.();
    expect(mark).not.toHaveBeenCalledWith(RENDERED_MARK);
  });

  it('marks corr:rendered on ECharts finished with bench=1', () => {
    const mark = vi.spyOn(performance, 'mark');
    window.history.replaceState(null, '', '?bench=1');
    mount(frame(0, 3));
    onFinished.current?.();
    expect(mark).toHaveBeenCalledWith(RENDERED_MARK);
    window.history.replaceState(null, '', '/');
  });

  it('Clear, then a new frame, then Export CSV: rows newer than the cut, cut in the header', async () => {
    const { update } = mount(frame(0, 5));
    clear();
    expect(screen.getByTestId('readout-y1').children[1].textContent).toBe('0'); // n
    update({ f: frame(3, 5) }); // rows 3..7; the cut is row 4
    expect(screen.getByTestId('readout-y1').children[1].textContent).toBe('3');
    const { shown, cut: cutNs } = chartLive.frame!;
    downloadCsv(shown!, cutNs);
    expect(blobs).toHaveLength(1);
    const csv = await blobs[0].text();
    const cut = BASE + 4 * S;
    expect(csv).toContain(`# clear-cut-tsNs: ${cut}\n`);
    const rows = csv
      .trim()
      .split('\n')
      .filter((l) => !l.startsWith('#'))
      .slice(1);
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(Number(r.split(',')[0])).toBeGreaterThan(cut);
  });

  it('Clear on a frozen frame (paused) still cuts at its newest row', () => {
    const { update } = mount(frame(0, 5));
    clear();
    expect(screen.getByTestId('readout-y1').children[1].textContent).toBe('0');
    update({ f: frame(0, 5) }); // the same rows again: still all cut
    expect(screen.getByTestId('readout-y1').children[1].textContent).toBe('0');
  });

  it('strips append only when the newest tsNs advances, and Clear resets them', () => {
    const { update } = mount(frame(0, 5), { metrics: metricsWith({ r: { strip: true } }) });
    const points = () => lastStrip('r').series[0].data.length;
    expect(points()).toBe(1);
    update({ f: frame(0, 5) }); // a new object with the same newest tsNs
    expect(points()).toBe(1);
    update({ f: frame(1, 5) });
    expect(points()).toBe(2);
    clear();
    expect(points()).toBe(0);
  });

  it('a Y hidden in the state stays unselected and undrawn across new frames', () => {
    const { update } = mount(frame(0, 5));
    expect(lastPlot().legend?.selected).toEqual({ 'Y1:PV': true, 'Y2:PV': true });
    update({ hidden: { 'Y1:PV': true } });
    update({ f: frame(1, 5) });
    update({ f: frame(2, 5) });
    expect(lastPlot().legend?.selected).toEqual({ 'Y1:PV': false, 'Y2:PV': true });
    expect(lastPlot().series.filter((s) => s.name === 'Y1:PV')).toEqual([]);
    // Visual only: the readout keeps reporting the hidden Y.
    expect(screen.getByTestId('readout-y1').textContent).toContain('Y1:PV');
    update({ hidden: {}, f: frame(3, 5) });
    expect(lastPlot().legend?.selected).toEqual({ 'Y1:PV': true, 'Y2:PV': true });
  });

  it('shared layout: one Y axis, one grid', () => {
    mount(frame(0, 5), { axes: 'shared' });
    const option = lastPlot();
    expect(asArray(option.yAxis)).toHaveLength(1);
    expect(Array.isArray(option.grid)).toBe(false);
    expect(option.series.every((s) => s.yAxisIndex === undefined)).toBe(true);
  });

  it('overlay layout: one coloured Y axis per Y, the third offset right; fits on their axis', () => {
    const f = framePvs(0, 5, { x: 'X:PV', y1: 'Y1:PV', y2: 'Y2:PV', y3: 'Y3:PV' });
    f.table.columns.y3 = f.table.columns.y1.map((v) => (v === null ? null : 1000 * v));
    mount(f, { axes: 'overlay' });
    const option = lastPlot();
    const yAxes = asArray(option.yAxis);
    expect(yAxes.map((a) => a.position)).toEqual(['left', 'right', 'right']);
    expect(yAxes.map((a) => a.offset)).toEqual([0, 0, 64]);
    expect(yAxes.map((a) => a.axisLabel?.color)).toEqual(['#5470c6', '#91cc75', '#fac858']);
    const y3 = option.series.filter((s) => s.name === 'Y3:PV');
    expect(y3.map((s) => s.type)).toEqual(['scatter', 'line']);
    expect(y3.every((s) => s.yAxisIndex === 2)).toBe(true);
  });

  it('split layout: a panel per Y with its own axes, linked X range, titled in colour', () => {
    const { update } = mount(frame(0, 5), { axes: 'split' });
    let option = lastPlot();
    expect(asArray(option.grid)).toHaveLength(2);
    const xAxes = asArray(option.xAxis);
    expect(xAxes.map((a) => a.gridIndex)).toEqual([0, 1]);
    expect(xAxes.map((a) => [a.min, a.max])).toEqual([
      [0, 4],
      [0, 4],
    ]);
    expect(asArray(option.yAxis).map((a) => a.gridIndex)).toEqual([0, 1]);
    const y2 = option.series.filter((s) => s.name === 'Y2:PV');
    expect(y2.every((s) => s.xAxisIndex === 1 && s.yAxisIndex === 1)).toBe(true);
    expect(option.title?.map((t) => t.text)).toEqual(['Y1:PV', 'Y2:PV']);
    expect(option.title?.[1].textStyle?.color).toBe('#91cc75');
    // A Y hidden in split stays hidden on the next frame.
    update({ hidden: { 'Y2:PV': true } });
    update({ f: frame(1, 5) });
    option = lastPlot();
    expect(option.legend?.selected).toEqual({ 'Y1:PV': true, 'Y2:PV': false });
    // A hidden Y is not drawn (plotOption): no panel, no title.
    expect(option.title?.map((t) => t.text)).toEqual(['Y1:PV']);
  });

  it('split layout wraps many Y into rows and grows the chart', () => {
    const pvs: Record<string, string> = { x: 'X:PV' };
    for (let i = 1; i <= 8; i++) pvs[`y${i}`] = `A:B:Y${i}`;
    const f = framePvs(0, 5, pvs);
    for (let i = 3; i <= 8; i++) f.table.columns[`y${i}`] = f.table.columns.y1;
    mount(f, { axes: 'split' });
    expect(asArray(lastPlot().grid)).toHaveLength(8);
    expect(lastPlotStyle()?.height).toBeGreaterThan(420);
    expect(lastPlot().title?.[0].text).toBe('B:Y1'); // short names when narrow
  });

  it('density view ignores the layout', () => {
    mount(frame(0, 20), { view: 'density', densityPv: 'Y2:PV', axes: 'split' });
    const option = lastPlot();
    expect(asArray(option.yAxis)).toHaveLength(1);
    expect(option.series.filter((s) => s.type === 'custom').map((s) => s.name)).toEqual(['Y2:PV']);
  });

  it('Export PNG works in every layout', () => {
    for (const axes of ['shared', 'overlay', 'split'] as const) {
      const { unmount } = mount(frame(0, 5), { axes });
      downloadChartPng(chartLive.chart.current, chartLive.frame!.shown, drawingThemeFor('dark'));
      unmount();
    }
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledTimes(3);
  });

  it('reads the oracle fixture into the readout with units', () => {
    const f = JSON.parse(ormFrameRaw) as FrameLike;
    mount(f, { unitsOf: (pv: string) => (pv.includes('HCM') ? 'A' : 'm') });
    expect(screen.getByTestId('readout-y1').textContent).toContain('4.457e-6 m/A');
    expect(screen.getByTestId('readout-y3').textContent).toContain('-2.549e-6 m/A');
    // The row rate moved into the health line.
    expect(screen.queryByTestId('readout-rate')).toBeNull();
  });

  it('the columns are the metrics that are on, in list order, titled by expression', () => {
    mount(frame(0, 5), {
      metrics: metricsWith({ std: { on: false }, r2: { on: true }, xmean: { on: true } }),
    });
    expect(readoutColumns()).toEqual(['n', 'mean', 'r', 'slope', 'R²', 'X mean']);
    expect(screen.queryByTestId('readout-col-std')).toBeNull();
    expect(screen.getByTestId('readout-col-r').getAttribute('title')).toBe('corr(x, y)');
    expect(screen.queryByTestId('readout-x')).toBeNull();
    // y1 = 2x + 1 over x = 0..4: R² 1, X mean 2.
    const cells = [...screen.getByTestId('readout-y1').querySelectorAll('td')].map(
      (td) => td.textContent
    );
    expect(cells).toEqual(['5', '5.000', '1.000', '2.000', '1.000', '2.000']);
  });

  it('a column whose expression does not compile is marked invalid, its cells "–"', () => {
    const bad: Metric = {
      id: 'c1',
      label: 'bad',
      expr: 'mean(',
      unit: '',
      on: true,
      strip: false,
    };
    mount(frame(0, 5), { metrics: [...defaultMetrics(CORRELATION_METRICS), bad] });
    const head = screen.getByTestId('readout-col-c1');
    expect(head.className).toBe('stats-readout__invalid');
    expect(head.getAttribute('title')).not.toBe('mean(');
    const cells = screen.getByTestId('readout-y1').querySelectorAll('td');
    expect(cells[cells.length - 1].textContent).toBe('–');
  });

  it('units follow each metric rule: y, x, y/x, none', () => {
    mount(frame(0, 5), {
      unitsOf: (pv: string) => (pv === 'X:PV' ? 'A' : 'm'),
      metrics: metricsWith({ n: { on: false }, xmean: { on: true } }),
    });
    const cells = [...screen.getByTestId('readout-y1').querySelectorAll('td')].map(
      (td) => td.textContent
    );
    expect(cells).toEqual(['5.000 m', '3.162 m', '1.000', '2.000 m/A', '2.000 A']);
  });

  it('no strips by default; the strips are the metrics with strip, in list order', () => {
    const { update } = mount(frame(0, 5));
    expect(stripTitles()).toEqual([]);
    expect(screen.queryByRole('region', { name: 'Strip charts' })).toBeNull();
    const metrics = metricsWith({ std: { strip: true }, r: { strip: true } });
    update({ metrics });
    rendered.length = 0;
    update({ f: frame(1, 5), metrics });
    expect(stripTitles()).toEqual(['std', 'r']);
    expect(lastStrip('r').yAxis).toMatchObject({ min: -1, max: 1 });
  });

  it('a strip turned on shows the points recorded while it was off', () => {
    const { update } = mount(frame(0, 5));
    update({ f: frame(1, 5) });
    update({ f: frame(2, 5) });
    update({ f: frame(2, 5), metrics: metricsWith({ mean: { strip: true } }) });
    const data = lastStrip('mean').series[0].data as [number, number][];
    expect(data.map((p) => p[1])).toEqual([5, 7, 9]);
  });
});

const NO_UNITS = () => '';
const FRAME = frame(0, 5);

function state(over: Partial<CorrelationState> = {}): CorrelationState {
  return { ...defaultCorrelationState(), x: 'X:PV', ys: ['Y1:PV', 'Y2:PV'], ...over };
}

function Canvas({ s, f = FRAME }: { s: CorrelationState; f?: FrameLike | null }) {
  const onScreen = useCorrelationFrame(f, s.metrics);
  return (
    <CorrelationCanvas
      state={s}
      frame={onScreen}
      unitsOf={NO_UNITS}
      chartTheme={drawingThemeFor('dark')}
    />
  );
}

describe('CorrelationCanvas statistics', () => {
  it('the readout and strips sit in one Statistics section; columns follow the state', () => {
    render(<Canvas s={state({ readout: true, metrics: metricsWith({ r: { strip: true } }) })} />);
    const stats = screen.getByRole('region', { name: 'Statistics' });
    expect(stats.querySelector('.stats-readout')).not.toBeNull();
    expect(stats.querySelector('.stats-strips')).not.toBeNull();
    expect(readoutColumns()).toEqual(['n', 'mean', 'std', 'r', 'slope']);
    expect(screen.getByTestId('readout-y2').textContent).toContain('Y2:PV');
  });

  it('dist=1 docks the distribution block under the table', () => {
    const { rerender } = render(<Canvas s={state({ readout: true })} />);
    expect(screen.queryByTestId('stats-distribution')).toBeNull();
    rerender(<Canvas s={state({ readout: true, dist: true })} />);
    expect(screen.getByTestId('stats-distribution')).toBeTruthy();
    // One density chart per Y, each titled with its n.
    const titles = [
      ...new Set(
        rendered
          .filter((r) => r.className === 'stats-dist__chart')
          .map((r) => (r.option as unknown as { title: { text: string } }).title.text)
      ),
    ];
    expect(titles).toHaveLength(2);
    expect(titles[0]).toMatch(/^Y1:PV — n \d+, mean /);
    rerender(<Canvas s={state({ readout: false, dist: true })} />);
    expect(screen.queryByTestId('stats-distribution')).toBeNull();
  });

  it('readout=false hides the table; no metric on hides it too; the section empties', () => {
    const { rerender, container } = render(<Canvas s={state({ readout: false })} />);
    expect(screen.queryByRole('table')).toBeNull();
    expect(container.querySelector('.stats-panel')).toBeNull();
    const none = defaultMetrics(CORRELATION_METRICS).map((m) => ({ ...m, on: false }));
    rerender(<Canvas s={state({ readout: true, metrics: none })} />);
    expect(screen.queryByRole('table')).toBeNull();
    // Show statistics hides the strips with the table (the whole panel).
    rerender(
      <Canvas s={state({ readout: false, metrics: metricsWith({ std: { strip: true } }) })} />
    );
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Strip charts' })).toBeNull();
    rerender(
      <Canvas s={state({ readout: true, metrics: metricsWith({ std: { strip: true } }) })} />
    );
    expect(screen.getByRole('region', { name: 'Strip charts' })).toBeTruthy();
  });
});

// ── Drawings on the canvas ─────────────────────────────────

interface DrawingLive {
  state: CorrelationState;
  ui: CorrelationUiRecord | null;
  doc: DrawingDocument | null;
}

/**
 * The workbench canvas with its drawing host, over a state written the way
 * App.tsx writes it (`apply`), a document over `state.drawings`, and the
 * Correlation ui record.
 */
function DrawingCanvas({
  initial,
  f,
  report,
}: {
  initial: CorrelationState;
  f: FrameLike | null;
  report: (live: DrawingLive) => void;
}) {
  const [s, setS] = useState(initial);
  const update = useMemo(
    () => (fn: (s: CorrelationState) => CorrelationState) => setS((prev) => apply(prev, fn)),
    []
  );
  const ui = useCorrelationUi();
  const [selection] = useState(() => createSelectionStore());
  const [shed] = useState(createShedStore);
  const doc = useDrawingDocument<CorrelationState, CorrelationUi>({
    list: s.drawings,
    update,
    undo: NO_UNDO,
    selection,
    ui,
    setUi: ui.setUi,
  });
  useLayoutEffect(() => {
    report({ state: s, ui, doc });
  });
  const onScreen = useCorrelationFrame(f, s.metrics);
  const drawing = useMemo(() => ({ document: doc, shed }), [doc, shed]);
  return (
    <CorrelationCanvas
      state={s}
      frame={onScreen}
      unitsOf={NO_UNITS}
      chartTheme={drawingThemeFor('dark')}
      drawing={drawing}
      update={update}
    />
  );
}

const NO_UNDO = () => {};

function mountDrawing(initial = state({}), f: FrameLike | null = frame(0, 10)) {
  const live: DrawingLive = { state: initial, ui: null, doc: null };
  const report = (next: DrawingLive) => void Object.assign(live, next);
  const utils = render(<DrawingCanvas initial={initial} f={f} report={report} />);
  const box = utils.container.querySelector('.correlation-plot__box') as HTMLDivElement;
  const key = (init: KeyboardEventInit) => {
    const ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    act(() => {
      box.dispatchEvent(ev);
    });
    return ev;
  };
  const svgs = () => [...box.querySelectorAll('svg[data-annotation-layer]')] as SVGSVGElement[];
  return { ...utils, live, report, box, key, svgs };
}

function hline(id: string, v: number): Annotation {
  return {
    id,
    kind: 'hline',
    points: [{ t: 0, v }],
    axisId: 'Y1:PV',
    color: '#000000',
    width: 1.5,
    text: '',
  };
}

const plots = () => rendered.filter((r) => r.className === 'correlation-plot__chart');

describe('CorrelationCanvas strip', () => {
  const toggle = (scope: ParentNode, name: string) =>
    scope.querySelector(`[data-drawing-rail] [data-drawing-toggle="${name}"]`) as HTMLButtonElement;

  it('shows every shared toggle; tooltip on and a zoom-box drag by default', () => {
    const { container, live } = mountDrawing();
    const names = [...container.querySelectorAll('[data-drawing-toggle]')].map((b) =>
      b.getAttribute('data-drawing-toggle')
    );
    expect(names).toEqual(PLOT_TOGGLES.map((t) => t.toggle));
    expect(toggle(container, 'tooltip').getAttribute('aria-pressed')).toBe('true');
    expect(toggle(container, 'drag').getAttribute('aria-pressed')).toBe('true');
    const last = () =>
      plots()[plots().length - 1].option as unknown as { tooltip: { showContent: boolean } };
    expect(last().tooltip.showContent).toBe(true);
    act(() => toggle(container, 'tooltip').click());
    expect(live.state.tooltip).toBe(false);
    expect(last().tooltip.showContent).toBe(false);
    act(() => toggle(container, 'drag').click());
    expect(live.state.drag).toBe('pan');
  });
});

describe('CorrelationCanvas gestures', () => {
  it('a zoom box writes the X and Y scales; a double-click returns them to auto', () => {
    const { box, live } = mountDrawing();
    act(() => onFinished.current?.());
    // x 130..330 is 1..5; y 86..236 is 25..10.
    act(() => {
      fireMouse(box, 'mousedown', { x: 130, y: 86 });
      fireMouse(window, 'mousemove', { x: 330, y: 236 });
      fireMouse(window, 'mouseup', { x: 330, y: 236 });
    });
    expect(live.state.xScale).toEqual({ auto: false, min: 1, max: 5 });
    expect(live.state.yScale?.auto).toBe(false);
    expect(live.state.yScale?.min).toBeCloseTo(10, 9);
    expect(live.state.yScale?.max).toBeCloseTo(25, 9);
    act(() => {
      fireMouse(box, 'dblclick', { x: 300, y: 200 });
    });
    expect(live.state.xScale).toBeUndefined();
    expect(live.state.yScale).toBeUndefined();
  });

  it('the wheel over the plot zooms both scales about the cursor', () => {
    const { box, live } = mountDrawing();
    act(() => onFinished.current?.());
    act(() => {
      box.dispatchEvent(
        new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          clientX: 330,
          clientY: 186,
          deltaY: -100,
        })
      );
    });
    expect(live.state.xScale?.auto).toBe(false);
    expect(live.state.yScale?.auto).toBe(false);
    const x = live.state.xScale!;
    expect(x.max! - x.min!).toBeLessThan(10);
  });
});

describe('CorrelationCanvas drawings', () => {
  beforeEach(() => {
    overlay.commits = 0;
  });

  it('places the layers inside the chart box and the rail and status line outside the scroller', () => {
    const { container, box, svgs } = mountDrawing();
    act(() => onFinished.current?.());
    const stage = container.querySelector('.correlation-plot__stage') as HTMLElement;
    expect(stage.contains(box)).toBe(true);
    expect(svgs().length).toBeGreaterThan(0);
    const rail = container.querySelector('[data-drawing-rail]') as HTMLElement;
    expect(rail).not.toBeNull();
    expect(stage.contains(rail)).toBe(false);
    const status = container.querySelector('[data-status-line]');
    expect(status).not.toBeNull();
    expect(stage.contains(status)).toBe(false);
    // The box is the host's wrapper: focusable, without a tab stop.
    expect(box.tabIndex).toBe(-1);
  });

  it('keeps the corr:rendered mark on finished', () => {
    const mark = vi.spyOn(performance, 'mark');
    window.history.replaceState(null, '', '?bench=1');
    mountDrawing();
    act(() => onFinished.current?.());
    expect(mark).toHaveBeenCalledWith(RENDERED_MARK);
    window.history.replaceState(null, '', '/');
  });

  it('a drawing commit leaves the chart option reference unchanged', () => {
    const { live } = mountDrawing();
    const before = plots().at(-1)?.option;
    const n = plots().length;
    act(() => live.doc?.commit((list) => [...list, hline('d1', 5)], 'add'));
    expect(live.state.drawings).toHaveLength(1);
    // The chart may re-render, but with the very same option.
    expect(plots().length).toBeGreaterThanOrEqual(n);
    expect(plots().at(-1)?.option).toBe(before);
  });

  it('a new frame with unchanged extents commits nothing in the overlay', () => {
    const { rerender, live, report } = mountDrawing();
    act(() => onFinished.current?.());
    const settled = overlay.commits;
    expect(settled).toBeGreaterThan(0);
    for (let i = 1; i <= 5; i++) {
      rerender(<DrawingCanvas initial={live.state} f={frame(i, 10)} report={report} />);
      act(() => onFinished.current?.());
    }
    expect(overlay.commits).toBe(settled);
  });

  it('a new drawing is stamped with the drawn X; a Y-only tool is not', () => {
    const { key, svgs, live } = mountDrawing();
    act(() => onFinished.current?.());
    // Alt+V arms the vertical line; a click inside the grid places it.
    key({ key: '√', code: 'KeyV', altKey: true });
    const svg = svgs()[0];
    act(() => void firePointer(svg, 'pointerdown', { x: 330, y: 186 }));
    act(() => void firePointer(svg, 'pointerup', { x: 330, y: 186 }));
    expect(live.state.drawings).toHaveLength(1);
    expect(live.state.drawings[0].kind).toBe('vline');
    expect(live.state.drawings[0].xRef).toBe('X:PV');
    // An H-line ignores X: no stamp.
    key({ key: '˙', code: 'KeyH', altKey: true });
    act(() => void firePointer(svgs()[0], 'pointerdown', { x: 330, y: 186 }));
    act(() => void firePointer(svgs()[0], 'pointerup', { x: 330, y: 186 }));
    expect(live.state.drawings).toHaveLength(2);
    expect(live.state.drawings[1].kind).toBe('hline');
    expect(live.state.drawings[1].xRef).toBeUndefined();
  });

  it('an Escape that cancels a drawing tool does not also clear pendingTrigger', () => {
    const { key, live } = mountDrawing();
    act(() => live.ui?.setPendingTrigger(true));
    expect(live.ui?.pendingTrigger).toBe(true);
    const arm = key({ key: '˙', code: 'KeyH', altKey: true });
    expect(arm.defaultPrevented).toBe(true);
    const esc = key({ key: 'Escape' });
    expect(esc.defaultPrevented).toBe(true);
    expect(live.ui?.pendingTrigger).toBe(true);
    // Nothing left to cancel: the Escape falls through and clears it.
    expect(key({ key: 'Escape' }).defaultPrevented).toBe(false);
    expect(live.ui?.pendingTrigger).toBe(false);
  });

  it('hide all writes the ui record and hides the drawings', () => {
    const { container, live } = mountDrawing(state({ drawings: [hline('d1', 5)] }));
    act(() => onFinished.current?.());
    const toggle = container.querySelector(
      '[data-drawing-rail] button[aria-label*="Hide"]'
    ) as HTMLButtonElement;
    expect(toggle).not.toBeNull();
    act(() => toggle.click());
    expect(live.ui?.drawingsHidden).toBe(true);
    expect(live.doc?.hidden).toBe(true);
  });
});
