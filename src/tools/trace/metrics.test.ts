// Trace's statistics frame (metrics.ts): the visible curves' points inside
// the view window, t relative to the window end, gap markers dropped, cross
// curve references, the data clock, the per-curve units, and the stored form
// of the metric list.
import { describe, expect, it } from 'vitest';
import { msToNs } from '../../api/time';
import { newTrace, unitAxis } from '../../embed/plotConfig';
import type { ArchiveSeriesResult } from '../../hooks/useArchiveSeries';
import type { FormulaSeriesResult } from '../../hooks/useFormulaSeries';
import type { LiveSeriesResult } from '../../hooks/useLiveSeries';
import { evaluateMetrics } from '../../statistics/evaluate';
import { defaultMetrics, type Metric } from '../../statistics/model';
import type { Plot, PVTrace } from '../../types';
import {
  frameClockMs,
  plotMetrics,
  storedMetrics,
  TRACE_METRICS,
  traceStatFrame,
  traceUnitOf,
} from './metrics';

const T0 = Date.UTC(2026, 9, 15, 12, 0, 0);
const AXIS = unitAxis('a1', 0, 'mA');

function plotWith(traces: PVTrace[]): Plot {
  return {
    id: 'p1',
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
    xAxis: { timeRange: '-1h' },
  };
}

function curve(id: string, over: Partial<PVTrace> = {}): PVTrace {
  return { ...newTrace(id, `PV:${id}`, AXIS.id, '#123456', []), useArchive: false, ...over };
}

function live(points: [number, number][], breaks: number[] = []): LiveSeriesResult {
  return {
    status: 'connected',
    connected: true,
    severity: null,
    latest: null,
    error: null,
    points: points.map(([time, value]) => ({ time, value, severity: 'NO_ALARM' })),
    breaks,
  };
}

const NONE = {
  archive: new Map<string, ArchiveSeriesResult>(),
  formula: new Map<string, FormulaSeriesResult>(),
};
const window = { fromNs: msToNs(T0 - 10_000), toNs: msToNs(T0) };

describe('traceStatFrame', () => {
  it('keeps the visible curves’ points inside the window, t relative to its end', () => {
    const plot = plotWith([curve('a'), curve('b', { visible: false })]);
    const liveMap = new Map([
      [
        'a',
        live([
          [T0 - 20_000, 100],
          [T0 - 8_000, 1],
          [T0 - 4_000, 3],
          [T0 + 1, 9],
        ]),
      ],
      ['b', live([[T0 - 5_000, 7]])],
    ]);
    const frame = traceStatFrame(plot, { ...NONE, live: liveMap }, window)!;
    // Every layer is a row (its position is `y<k>`); an invisible one is hidden and empty.
    expect(frame.rows.map((r) => [r.id, r.hidden === true])).toEqual([
      ['a', false],
      ['b', true],
    ]);
    expect(frame.rows[1].columns.y.length).toBe(0);
    expect(frame.rows[0].label).toBe('PV:a');
    expect(Array.from(frame.rows[0].columns.y)).toEqual([1, 3]);
    expect(Array.from(frame.rows[0].columns.t)).toEqual([-8, -4]);
    expect(frameClockMs(frame)).toBe(T0 - 4_000);
  });

  it('drops gap markers, is null without a point in the window, and evaluates the presets', () => {
    const plot = plotWith([curve('a'), curve('b')]);
    const liveMap = new Map([
      [
        'a',
        live(
          [
            [T0 - 9_000, 2],
            [T0 - 3_000, 4],
          ],
          [T0 - 6_000]
        ),
      ],
      [
        'b',
        live([
          [T0 - 9_500, 10],
          [T0 - 2_000, 20],
          [T0 - 1_000, 30],
        ]),
      ],
    ]);
    const frame = traceStatFrame(plot, { ...NONE, live: liveMap }, window)!;
    expect(Array.from(frame.rows[0].columns.y)).toEqual([2, 4]);
    const table = evaluateMetrics(TRACE_METRICS, frame, [
      ...defaultMetrics(TRACE_METRICS),
      { id: 'c1', label: 'diff', expr: 'mean(y) - mean(y1)', unit: 'y', on: true, strip: false },
      { id: 'c2', label: 'bad', expr: 'y - y1', unit: '', on: true, strip: false },
      { id: 'c3', label: 'held', expr: 'mean(y - y2)', unit: '', on: true, strip: false },
    ]);
    const b = table.rows[1].cells;
    expect(b.n.value).toBe(3);
    expect(b.mean.value).toBe(20);
    expect(b.min.value).toBe(10);
    expect(b.max.value).toBe(30);
    // A referenced curve is held onto this curve's times. For b, a at
    // [-9.5, -2, -1] s is [none, 4, 4]: the first sample drops out of the
    // joint set, so mean(y) is over [20, 30] and mean(y1) is 4.
    expect(b.c1.value).toBe(25 - 4);
    // For a, y1 is a itself and y2 (b) at [-9, -3] s is [10, 10].
    const a = table.rows[0].cells;
    expect(a.c1.value).toBe(0);
    expect(a.c3.value).toBe(3 - 10);
    // A vector result is a compile error of the whole column.
    expect(b.c2.value).toBeNull();
    expect(table.errors.c2).toBeDefined();
    const same = traceStatFrame(
      plot,
      {
        ...NONE,
        live: new Map([
          [
            'a',
            live([
              [T0 - 9_000, 2],
              [T0 - 3_000, 4],
            ]),
          ],
          [
            'b',
            live([
              [T0 - 8_000, 1],
              [T0 - 2_000, 1],
            ]),
          ],
        ]),
      },
      window
    )!;
    const t2 = evaluateMetrics(TRACE_METRICS, same, [
      { id: 'c2', label: 'diff', expr: 'mean(y - y2)', unit: '', on: true, strip: false },
    ]);
    // Equal sample counts do not align by index: at -9 s b has no sample yet, at -3 s it is 1.
    expect(t2.rows[0].cells.c2.value).toBe(4 - 1);
    expect(
      traceStatFrame(plot, { ...NONE, live: new Map([['a', live([[T0 - 60_000, 1]])]]) }, window)
    ).toBeNull();
  });

  it('units follow the curve’s axis; per second for a slope', () => {
    const plot = plotWith([curve('a')]);
    expect(traceUnitOf(plot, 'a', 'y')).toBe('mA');
    expect(traceUnitOf(plot, 'a', 'y/s')).toBe('mA/s');
    expect(traceUnitOf(plot, 'a', '')).toBe('');
    plot.axes[0] = { ...AXIS, unitLabel: 'A' };
    expect(traceUnitOf(plot, 'a', 'y')).toBe('A');
    plot.axes[0] = { ...AXIS, units: undefined };
    expect(traceUnitOf(plot, 'a', 'y/s')).toBe('1/s');
  });
});

describe('plotMetrics / storedMetrics', () => {
  it('reads the default list when none is stored and stores only off the default', () => {
    const plot = plotWith([]);
    expect(plotMetrics(plot)).toEqual(defaultMetrics(TRACE_METRICS));
    expect(storedMetrics(defaultMetrics(TRACE_METRICS))).toBeUndefined();
    const changed: Metric[] = defaultMetrics(TRACE_METRICS).map((m) =>
      m.id === 'last' ? { ...m, on: true } : m
    );
    expect(storedMetrics(changed)).toEqual(changed);
    expect(plotMetrics({ metrics: changed })).toEqual(changed);
  });
});
