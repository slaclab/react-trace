// @vitest-environment jsdom
//
// Regression tests for #120: an INVALID sample breaks the line until the next
// good sample, the stretch is marked under the x-axis, and the min/max band and
// the extension line don't bridge it. Mounts SinglePlot with canopy-charts'
// CanopyChart stubbed out and inspects the option it's handed.
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { SinglePlot } from './PlotArea';
import type { Plot, PVTrace } from '../types';
import type { AlarmSeverity } from '../api/types';
import type { ArchiveSeriesResult } from '../hooks/useArchiveSeries';
import type { LiveSeriesResult } from '../hooks/useLiveSeries';
import { chartStub } from '../test/chartStub';

type Series = Record<string, unknown> & { id: string; type: string; data: unknown[] };
interface Option {
  series: Series[];
  xAxis: { axisLabel: { margin: number } };
  tooltip: { formatter: (p: { axisValue: number }[]) => string };
}

const { lastOption } = vi.hoisted(() => ({ lastOption: { current: null as unknown } }));

// No instance: the chart never becomes ready, so SinglePlot's effects bail out
// early without one.
vi.mock('@slaclab/canopy-charts', async (importOriginal) =>
  (await import('../test/chartStub')).mockCanopyCharts(importOriginal)
);
chartStub.onRender = (props) => {
  lastOption.current = props.option;
};

// A fixed custom window, so the x-axis end (and a trailing stretch) is exact.
const FROM_MS = Date.UTC(2026, 9, 1, 12, 0, 0);
const TO_MS = FROM_MS + 60_000;
const at = (s: number) => FROM_MS + s * 1000;
const COLOR = '#ff00aa';

function makeTrace(over: Partial<PVTrace> = {}): PVTrace {
  return {
    id: 't1',
    pvName: 'AV:TEMP',
    displayName: 'AV:TEMP',
    color: COLOR,
    visible: true,
    axisId: 'ax1',
    useLive: false,
    updateRate: '1s',
    useArchive: true,
    lineWidth: 2,
    lineType: 'direct',
    lineStyle: 'solid',
    showSymbol: false,
    symbolShape: 'circle',
    symbolSize: 4,
    data: [],
    ...over,
  };
}

const AX1: Plot['axes'][number] = {
  id: 'ax1',
  name: 'Y',
  orientation: 'left',
  autoScale: true,
  logScale: false,
  visible: true,
};

function makePlot(traces: PVTrace[], axes: Plot['axes'] = [AX1]): Plot {
  return {
    id: 'p1',
    title: 'Plot 1',
    traces,
    axes,
    backgroundColor: 'default',
    showLegend: false,
    showXGridlines: false,
    showYGridlines: false,
    showCrosshair: false,
    gridStyle: 'solid',
    gridOpacity: 1,
    tickFontSize: 11,
    xAxis: {
      timeRange: 'custom',
      timeFrom: new Date(FROM_MS).toISOString(),
      timeTo: new Date(TO_MS).toISOString(),
    },
  };
}

type Pt = [seconds: number, value: number, severity: AlarmSeverity];
const points = (pts: Pt[]) => pts.map(([s, value, severity]) => ({ time: at(s), value, severity }));

function rawResult(pts: Pt[]): ArchiveSeriesResult {
  return { status: 'ready', mode: 'raw', mean: points(pts), band: [] };
}

function mount(
  traces: PVTrace[],
  archive: Map<string, ArchiveSeriesResult>,
  live = new Map<string, LiveSeriesResult>(),
  axes?: Plot['axes']
): Option {
  const { unmount } = render(
    <SinglePlot
      plot={makePlot(traces, axes)}
      endMs={TO_MS}
      archiveResults={archive}
      liveResults={live}
      formulaResults={new Map()}
    />
  );
  unmount();
  return lastOption.current as Option;
}

const seriesById = (opt: Option, id: string) => opt.series.find((s) => s.id === id);

// Series data as [t, v] pairs. Lines without an INVALID sample and extension
// lines are flat [t0, v0, t1, v1, ...] typed arrays.
function pairs(data: unknown): unknown[] {
  if (!(data instanceof Float64Array)) return data as unknown[];
  return Array.from({ length: data.length / 2 }, (_, i) => [data[2 * i], data[2 * i + 1]]);
}

// Good samples at 10 s and 20 s, INVALID at 30 s and 35 s, good again from 40 s.
const WITH_INVALID: Pt[] = [
  [10, 1, 'NO_ALARM'],
  [20, 2, 'MINOR'],
  [30, 99, 'INVALID'],
  [35, 98, 'INVALID'],
  [40, 3, 'NO_ALARM'],
  [50, 4, 'NO_ALARM'],
];

// Runs a marker series' renderItem for one stretch against a 300 px-wide grid
// spanning the window, and returns the shape it draws.
function renderMarker(marker: Series, index: number) {
  const grid = { type: 'cartesian2d', x: 70, y: 40, width: 300, height: 200 };
  const stretch = marker.data[index] as [number, number];
  const toPx = (t: number) => grid.x + ((t - FROM_MS) / (TO_MS - FROM_MS)) * grid.width;
  const renderItem = marker.renderItem as (
    params: unknown,
    api: unknown
  ) => { type: string; shape: Record<string, number>; style: { fill: string } };
  return renderItem(
    { coordSys: grid },
    { value: (dim: number) => stretch[dim], coord: ([t]: [number]) => [toPx(t), 0] }
  );
}

describe('PlotArea: INVALID samples (#120)', () => {
  it('direct line: breaks at the first INVALID sample and restarts at the next good one', () => {
    const opt = mount([makeTrace()], new Map([['t1', rawResult(WITH_INVALID)]]));
    expect(seriesById(opt, 't1')!.data).toEqual([
      [at(10), 1],
      [at(20), 2],
      [at(30), null],
      [at(40), 3],
      [at(50), 4],
    ]);
  });

  it('step line: holds the last good value up to the bad sample, then breaks', () => {
    const opt = mount(
      [makeTrace({ lineType: 'step' })],
      new Map([['t1', rawResult(WITH_INVALID)]])
    );
    const line = seriesById(opt, 't1')!;
    expect(line.step).toBe('end');
    expect(line.data).toEqual([
      [at(10), 1],
      [at(20), 2],
      // The hold point isn't a sample, so it never draws a symbol.
      { value: [at(30), 2], symbol: 'none' },
      [at(30), null],
      [at(40), 3],
      [at(50), 4],
    ]);
  });

  it('marks the INVALID stretch under the x-axis in the trace colour', () => {
    for (const lineType of ['direct', 'step'] as const) {
      const opt = mount([makeTrace({ lineType })], new Map([['t1', rawResult(WITH_INVALID)]]));
      const marker = seriesById(opt, 't1-invalid')!;
      expect(marker.type).toBe('custom');
      // From the first INVALID sample to the next good one.
      expect(marker.data).toEqual([[at(30), at(40)]]);
      // It must not stretch the y-axis.
      expect(marker.encode).toEqual({ x: [0, 1] });

      const rect = renderMarker(marker, 0);
      expect(rect.type).toBe('rect');
      expect(rect.style.fill).toBe(COLOR);
      // Below the axis line (grid bottom = 40 + 200), spanning 30 s → 40 s.
      expect(rect.shape.y).toBeGreaterThan(240);
      expect(rect.shape.x).toBeCloseTo(70 + 150);
      expect(rect.shape.width).toBeCloseTo(50);
    }
  });

  it('no marker series and an unbroken line without INVALID samples', () => {
    const clean = WITH_INVALID.filter(([, , sev]) => sev !== 'INVALID');
    const opt = mount([makeTrace()], new Map([['t1', rawResult(clean)]]));
    expect(seriesById(opt, 't1-invalid')).toBeUndefined();
    expect(pairs(seriesById(opt, 't1')!.data)).toEqual(clean.map(([s, v]) => [at(s), v]));
    expect(opt.xAxis.axisLabel.margin).toBe(8);
  });

  it('extension line: drawn from the last good sample, not across a trailing INVALID stretch', () => {
    const ok = mount([makeTrace()], new Map([['t1', rawResult(WITH_INVALID)]]));
    const ext = seriesById(ok, 't1-extension')!;
    expect(pairs(ext.data)[0]).toEqual([at(50), 4]);

    const endsInvalid: Pt[] = [...WITH_INVALID, [55, 97, 'INVALID']];
    for (const lineType of ['direct', 'step'] as const) {
      const opt = mount([makeTrace({ lineType })], new Map([['t1', rawResult(endsInvalid)]]));
      expect(seriesById(opt, 't1-extension')).toBeUndefined();
      // The open stretch runs to the window end instead.
      expect(seriesById(opt, 't1-invalid')!.data).toEqual([
        [at(30), at(40)],
        [at(55), TO_MS],
      ]);
    }
  });

  const bins: [number, number, number, AlarmSeverity][] = [
    [10, 0, 2, 'NO_ALARM'],
    [20, 1, 3, 'NO_ALARM'],
    [30, 50, 60, 'INVALID'],
    [40, 2, 4, 'NO_ALARM'],
  ];
  const binnedResult: ArchiveSeriesResult = {
    status: 'ready',
    mode: 'binned',
    mean: bins.map(([s, lo, hi, severity]) => ({ time: at(s), value: (lo + hi) / 2, severity })),
    band: bins.map(([s, min, max, severity]) => ({ time: at(s), min, max, severity })),
  };

  it('min/max band: both stacked series break at the INVALID bin', () => {
    const opt = mount([makeTrace()], new Map([['t1', binnedResult]]));
    expect(seriesById(opt, 't1-band-min')!.data).toEqual([
      [at(10), 0],
      [at(20), 1],
      [at(30), null],
      [at(40), 2],
    ]);
    expect(seriesById(opt, 't1-band-max')!.data).toEqual([
      [at(10), 2],
      [at(20), 2],
      [at(30), null],
      [at(40), 2],
    ]);
  });

  it('min/max band on a step line: holds up to the INVALID bin like the line', () => {
    const opt = mount([makeTrace({ lineType: 'step' })], new Map([['t1', binnedResult]]));
    expect(seriesById(opt, 't1-band-min')!.data).toEqual([
      [at(10), 0],
      [at(20), 1],
      { value: [at(30), 1], symbol: 'none' },
      [at(30), null],
      [at(40), 2],
    ]);
    expect(seriesById(opt, 't1-band-max')!.data).toContainEqual({
      value: [at(30), 2],
      symbol: 'none',
    });
  });

  it('live points: an INVALID live sample breaks the line the same way', () => {
    const live: LiveSeriesResult = {
      status: 'connected',
      connected: true,
      severity: 'NO_ALARM',
      latest: null,
      error: null,
      points: points(WITH_INVALID),
    };
    const opt = mount(
      [makeTrace({ useArchive: false, useLive: true })],
      new Map(),
      new Map([['t1', live]])
    );
    expect(seriesById(opt, 't1')!.data).toContainEqual([at(30), null]);
    expect(seriesById(opt, 't1-invalid')!.data).toEqual([[at(30), at(40)]]);
  });

  it('each trace with INVALID stretches gets its own marker lane', () => {
    const opt = mount(
      [makeTrace(), makeTrace({ id: 't2', pvName: 'AV:TEMP2', displayName: 'AV:TEMP2' })],
      new Map([
        ['t1', rawResult(WITH_INVALID)],
        ['t2', rawResult(WITH_INVALID)],
      ])
    );
    const y1 = renderMarker(seriesById(opt, 't1-invalid')!, 0).shape.y;
    const y2 = renderMarker(seriesById(opt, 't2-invalid')!, 0).shape.y;
    expect(y1).not.toBe(y2);
    // The x-axis labels move down to clear the second lane.
    expect(opt.xAxis.axisLabel.margin).toBeGreaterThan(8);
  });

  it('caps the marker lanes so the labels stay clear of the legend', () => {
    const ids = ['t1', 't2', 't3', 't4', 't5', 't6'];
    const opt = mount(
      ids.map((id) => makeTrace({ id, pvName: `AV:${id}`, displayName: `AV:${id}` })),
      new Map(ids.map((id) => [id, rawResult(WITH_INVALID)]))
    );
    const ys = ids.map((id) => renderMarker(seriesById(opt, `${id}-invalid`)!, 0).shape.y);
    expect(new Set(ys.slice(0, 4)).size).toBe(4);
    // Traces past the last lane share it.
    expect(ys[4]).toBe(ys[3]);
    expect(ys[5]).toBe(ys[3]);
    expect(opt.xAxis.axisLabel.margin).toBe(20);
  });

  it('traces on a hidden axis take no marker lane', () => {
    const ids = ['t1', 't2', 't3', 't4', 't5'];
    // t1-t3 sit on a hidden axis ahead of t4 and t5 on the visible one.
    const traces = ids.map((id, i) =>
      makeTrace({ id, pvName: `AV:${id}`, displayName: `AV:${id}`, axisId: i < 3 ? 'ax2' : 'ax1' })
    );
    const opt = mount(traces, new Map(ids.map((id) => [id, rawResult(WITH_INVALID)])), new Map(), [
      { ...AX1, id: 'ax2', visible: false },
      AX1,
    ]);
    for (const id of ['t1', 't2', 't3']) {
      expect(seriesById(opt, id)).toBeUndefined();
      expect(seriesById(opt, `${id}-invalid`)).toBeUndefined();
    }
    // t4 and t5 get the first two lanes instead of sharing the capped one.
    expect(renderMarker(seriesById(opt, 't4-invalid')!, 0).shape.y).toBe(240 + 2);
    expect(renderMarker(seriesById(opt, 't5-invalid')!, 0).shape.y).toBe(240 + 6);
    expect(opt.xAxis.axisLabel.margin).toBe(12);
  });

  it('INVALID stretches outside the window take no marker lane', () => {
    // Live points from before the window start (retention > span).
    const live: LiveSeriesResult = {
      status: 'connected',
      connected: true,
      severity: 'NO_ALARM',
      latest: null,
      error: null,
      points: points([
        [-30, 1, 'NO_ALARM'],
        [-20, 9, 'INVALID'],
        [-10, 2, 'NO_ALARM'],
        [10, 3, 'NO_ALARM'],
      ]),
    };
    const opt = mount(
      [makeTrace({ useArchive: false, useLive: true }), makeTrace({ id: 't2' })],
      new Map([['t2', rawResult(WITH_INVALID)]]),
      new Map([['t1', live]])
    );
    expect(seriesById(opt, 't1-invalid')).toBeUndefined();
    // The line still breaks there, off-screen.
    expect(seriesById(opt, 't1')!.data).toContainEqual([at(-20), null]);
    // t2's stretch gets the first lane, and the labels don't move.
    expect(opt.xAxis.axisLabel.margin).toBe(8);
    expect(renderMarker(seriesById(opt, 't2-invalid')!, 0).shape.y).toBe(240 + 2);
  });

  it('tooltip: shows a non-NO_ALARM severity next to the value', () => {
    const opt = mount([makeTrace()], new Map([['t1', rawResult(WITH_INVALID)]]));
    expect(opt.tooltip.formatter([{ axisValue: at(31) }])).toContain('INVALID');
    expect(opt.tooltip.formatter([{ axisValue: at(21) }])).toContain('MINOR');
    expect(opt.tooltip.formatter([{ axisValue: at(49) }])).not.toMatch(/NO_ALARM|INVALID|MINOR/);
  });

  it('tooltip escapes untrusted labels and severity and rejects unsafe colors', () => {
    const maliciousLabel = '<img src=x onerror=alert(1)>';
    const maliciousSeverity = '<svg onload=alert(1)>';
    const maliciousColor = '#ff0000" onmouseover="alert(1)';
    const opt = mount(
      [makeTrace({ displayName: maliciousLabel, color: maliciousColor })],
      new Map([['t1', rawResult([[10, 1, maliciousSeverity as AlarmSeverity]])]])
    );

    const html = opt.tooltip.formatter([{ axisValue: at(10) }]);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&lt;svg onload=alert(1)&gt;');
    expect(html).toContain('style="color:#000000"');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<svg');
    expect(html).not.toContain('onmouseover');
  });

  it('tooltip escapes untrusted sample values', () => {
    const maliciousValue = '<img src=x onerror=alert(1)>';
    const opt = mount(
      [
        makeTrace({
          useArchive: false,
          data: [{ time: at(10), value: maliciousValue as unknown as number }],
        }),
      ],
      new Map()
    );

    const html = opt.tooltip.formatter([{ axisValue: at(10) }]);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img');
  });
});
