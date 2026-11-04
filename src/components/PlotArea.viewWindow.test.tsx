// @vitest-environment jsdom
// The view window owns the visible range. `buildPlotOption` spans the x axis
// over `viewWindow` instead of an inside dataZoom, and cuts every series to it
// plus one neighbour sample each side so auto-scaled Y axes fit what is on
// screen; without a window it prints the configured range and the data whole,
// as the Code tab always has. `SinglePlot` takes the window as a controlled
// prop.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { Axis, Plot, PVTrace } from '../types';
import type { LiveSeriesResult } from '../hooks/useLiveSeries';
import type { ArchiveSeriesResult } from '../hooks/useArchiveSeries';
import type { FormulaSeriesResult } from '../hooks/useFormulaSeries';
import { drawingThemeFor } from '../annotationTheme';
import { msToNs, nsToMs, resolveTimeWindow } from '../api/time';
import { newTrace } from '../embed/plotConfig';
import type { LinePoint } from '../components/traceGaps';

type Captured = {
  option: { xAxis: { min: number; max: number }; dataZoom?: unknown };
  onEvents?: Record<string, unknown>;
};
const { rendered } = vi.hoisted(() => ({ rendered: [] as Captured[] }));

vi.mock('echarts-for-react', async () => {
  const React = await import('react');
  const fakeInstance = {
    getWidth: () => 800,
    getHeight: () => 400,
    isDisposed: () => false,
    getZr: () => ({ setCursorStyle: () => {}, on: () => {}, off: () => {} }),
    getModel: () => null,
    convertToPixel: () => 0,
    convertFromPixel: () => 0,
    getDataURL: () => '',
    getDom: () => document.createElement('div'),
    resize: () => {},
    dispatchAction: () => {},
    on: () => {},
    off: () => {},
  };
  class MockECharts extends React.Component<Captured> {
    getEchartsInstance() {
      return fakeInstance;
    }
    render() {
      rendered.push({ option: this.props.option, onEvents: this.props.onEvents });
      return React.createElement('div');
    }
  }
  return { default: MockECharts };
});

import { SinglePlot } from './PlotArea';
import { buildPlotOption } from './plotOption';
import { seriesPoints } from '../test/seriesPoints';

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  rendered.length = 0;
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const AXIS: Axis = {
  id: 'axis-1',
  name: 'Y-Axis 1',
  orientation: 'left',
  autoScale: true,
  logScale: false,
  visible: true,
};
const T0 = Date.UTC(2026, 9, 14, 12, 0, 0);
const S = 1000;

function curve(id: string, over: Partial<PVTrace> = {}): PVTrace {
  return {
    ...newTrace(id, `TEST:${id}`, AXIS.id, '#0f62fe', []),
    useLive: true,
    useArchive: false,
    ...over,
  };
}

// A datetime-local string (the custom range's format) for `ms` in local time.
function localInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function plotWith(traces: PVTrace[]): Plot {
  return {
    id: 'plot-1',
    title: 'Plot 1',
    traces,
    axes: [AXIS],
    showLegend: true,
    showXGridlines: true,
    showYGridlines: true,
    showCrosshair: true,
    gridStyle: 'solid',
    gridOpacity: 1,
    tickFontSize: 11,
    // One hour either side of T0, so every fixture sample lies inside it.
    xAxis: {
      timeRange: 'custom',
      timeFrom: localInput(T0 - 3600 * 1000),
      timeTo: localInput(T0 + 3600 * 1000),
    },
  };
}

// One sample a second for 60 s; the first and last carry extremes far outside
// anything the window [T0+10s, T0+20s] holds.
function liveBuffer(): LiveSeriesResult {
  return {
    status: 'connected',
    connected: true,
    severity: null,
    latest: null,
    error: null,
    points: Array.from({ length: 60 }, (_, i) => ({
      time: T0 + i * S,
      value: i === 0 ? 1e6 : i === 59 ? -1e6 : i,
      severity: 'NO_ALARM',
    })),
    breaks: [],
  };
}

function archiveBuffer(): ArchiveSeriesResult {
  const times = Array.from({ length: 60 }, (_, i) => T0 + i * S);
  return {
    status: 'ready',
    mode: 'binned',
    mean: times.map((time, i) => ({ time, value: i, severity: 'NO_ALARM' as const })),
    band: times.map((time, i) => ({
      time,
      min: i === 0 ? -1e6 : i - 1,
      max: i === 59 ? 1e6 : i + 1,
      severity: 'NO_ALARM' as const,
    })),
  };
}

const WINDOW = { fromNs: msToNs(T0 + 10 * S), toNs: msToNs(T0 + 20 * S) };
const NO_ARCHIVE = new Map<string, ArchiveSeriesResult>();
const NO_FORMULA = new Map<string, FormulaSeriesResult>();

type Series = { id: string; data: LinePoint[] };
const seriesOf = (option: ReturnType<typeof buildPlotOption>, id: string): Series => {
  const found = (option.series as unknown as Series[]).find((s) => s.id === id);
  expect(found).toBeDefined();
  return found!;
};
const points = (data: unknown) => seriesPoints(data) as LinePoint[];
const times = (data: unknown) =>
  points(data)
    .filter((p) => p[1] !== null)
    .map((p) => p[0]);
const values = (data: unknown) =>
  points(data)
    .map((p) => p[1])
    .filter((v) => v !== null);

// The window's samples (10 s..20 s) and one neighbour each side (9 s, 21 s).
const EXPECTED_TIMES = Array.from({ length: 13 }, (_, i) => T0 + (9 + i) * S);

describe('buildPlotOption viewWindow', () => {
  it('spans the x axis over the view window and emits no dataZoom', () => {
    const plot = plotWith([curve('t1')]);
    const option = buildPlotOption({
      plot,
      archiveResults: NO_ARCHIVE,
      liveResults: new Map([['t1', liveBuffer()]]),
      formulaResults: NO_FORMULA,
      theme: drawingThemeFor('dark'),
      viewWindow: WINDOW,
    });
    expect(option.xAxis.min).toBe(T0 + 10 * S);
    expect(option.xAxis.max).toBe(T0 + 20 * S);
    expect('dataZoom' in option).toBe(false);
  });

  it('cuts an auto axis line to the in-window samples plus the two neighbours', () => {
    const plot = plotWith([curve('t1')]);
    const option = buildPlotOption({
      plot,
      archiveResults: NO_ARCHIVE,
      liveResults: new Map([['t1', liveBuffer()]]),
      formulaResults: NO_FORMULA,
      theme: drawingThemeFor('dark'),
      viewWindow: WINDOW,
    });
    const line = seriesOf(option, 't1').data;
    expect(times(line)).toEqual(EXPECTED_TIMES);
    // The out-of-window extremes that would stretch the auto axis are gone.
    expect(values(line)).not.toContain(1e6);
    expect(values(line)).not.toContain(-1e6);
  });

  it('cuts the archive band the same way', () => {
    const plot = plotWith([curve('t1', { useLive: false, useArchive: true })]);
    const option = buildPlotOption({
      plot,
      archiveResults: new Map([['t1', archiveBuffer()]]),
      liveResults: new Map(),
      formulaResults: NO_FORMULA,
      theme: drawingThemeFor('dark'),
      viewWindow: WINDOW,
    });
    for (const id of ['t1-band-min', 't1-band-max', 't1']) {
      const data = seriesOf(option, id).data;
      expect(times(data)).toEqual(EXPECTED_TIMES);
      expect(values(data)).not.toContain(1e6);
      expect(values(data)).not.toContain(-1e6);
    }
  });

  it('keeps the tooltip on the full data, outside the window too', () => {
    const plot = plotWith([curve('t1')]);
    const option = buildPlotOption({
      plot,
      archiveResults: NO_ARCHIVE,
      liveResults: new Map([['t1', liveBuffer()]]),
      formulaResults: NO_FORMULA,
      theme: drawingThemeFor('dark'),
      viewWindow: WINDOW,
    });
    const formatter = (option.tooltip as { formatter: (p: unknown) => string }).formatter;
    // The sample at T0 (cut from the series) still answers a hover there.
    const html = formatter([{ axisValue: T0 }]);
    expect(html).toContain(': 1000000 ');
  });

  it('keeps a window inside one sample interval drawable with its two neighbours', () => {
    const plot = plotWith([curve('t1')]);
    const option = buildPlotOption({
      plot,
      archiveResults: NO_ARCHIVE,
      liveResults: new Map([['t1', liveBuffer()]]),
      formulaResults: NO_FORMULA,
      theme: drawingThemeFor('dark'),
      viewWindow: { fromNs: msToNs(T0 + 10.2 * S), toNs: msToNs(T0 + 10.8 * S) },
    });
    expect(times(seriesOf(option, 't1').data)).toEqual([T0 + 10 * S, T0 + 11 * S]);
  });

  it('without viewWindow equals the configured range and the whole data, as today', () => {
    const plot = plotWith([curve('t1')]);
    const base = {
      plot,
      archiveResults: NO_ARCHIVE,
      liveResults: new Map([['t1', liveBuffer()]]),
      formulaResults: NO_FORMULA,
      theme: drawingThemeFor('dark'),
    };
    const option = buildPlotOption(base);
    const configured = resolveTimeWindow(plot.xAxis, Date.now()).window;
    expect(option.xAxis.min).toBe(nsToMs(configured.fromNs));
    expect(option.xAxis.max).toBe(nsToMs(configured.toNs));
    expect('dataZoom' in option).toBe(false);
    // Uncut: all 60 samples, extremes included.
    expect(times(seriesOf(option, 't1').data)).toHaveLength(60);
    // Passing the configured window over data that lies wholly inside it is
    // the same option.
    const explicit = buildPlotOption({ ...base, viewWindow: configured });
    expect(JSON.stringify(explicit)).toBe(JSON.stringify(option));
  });
});

describe('SinglePlot viewWindowNs', () => {
  const props = {
    archiveResults: new Map<string, ArchiveSeriesResult>(),
    liveResults: new Map([['t1', liveBuffer()]]),
    formulaResults: new Map<string, FormulaSeriesResult>(),
  };

  it('draws the controlled window and follows it on every render', () => {
    const plot = plotWith([curve('t1')]);
    const { rerender } = render(<SinglePlot plot={plot} {...props} viewWindowNs={WINDOW} />);
    let last = rendered[rendered.length - 1];
    expect(last.option.xAxis.min).toBe(T0 + 10 * S);
    expect(last.option.xAxis.max).toBe(T0 + 20 * S);
    expect(last.option.dataZoom).toBeUndefined();
    // Only `finished` and the legend menu's events are wired; no datazoom event.
    expect(Object.keys(last.onEvents ?? {}).sort()).toEqual([
      'contextmenu',
      'finished',
      'mouseout',
      'mouseover',
    ]);

    const moved = { fromNs: msToNs(T0 + 30 * S), toNs: msToNs(T0 + 40 * S) };
    rerender(<SinglePlot plot={plot} {...props} viewWindowNs={moved} />);
    last = rendered[rendered.length - 1];
    expect(last.option.xAxis.min).toBe(T0 + 30 * S);
    expect(last.option.xAxis.max).toBe(T0 + 40 * S);
  });

  it('never reports a window by itself', () => {
    const plot = plotWith([curve('t1')]);
    const onViewWindowChange = vi.fn();
    render(
      <SinglePlot
        plot={plot}
        {...props}
        viewWindowNs={WINDOW}
        onViewWindowChange={onViewWindowChange}
      />
    );
    expect(onViewWindowChange).not.toHaveBeenCalled();
  });
});
