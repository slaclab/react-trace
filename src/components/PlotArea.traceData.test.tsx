// @vitest-environment jsdom
// Memoized trace line data: SinglePlot computes the per-trace line data once
// per result change and hands it to buildPlotOption, which uses it instead of
// recomputing. Pins that the option is identical with and without the
// precomputed map (the Code tab calls without it), and that the memo hands back
// the same Map instance while its inputs are unchanged.
import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { Axis, Plot, PVTrace } from '../types';
import type { LiveSeriesResult } from '../hooks/useLiveSeries';
import type { ArchiveSeriesResult } from '../hooks/useArchiveSeries';
import type { FormulaSeriesResult } from '../hooks/useFormulaSeries';
import { drawingThemeFor } from '../annotationTheme';
import { buildPlotOption, computeTraceData, useTraceData } from './plotOption';
import type { TraceDataMap } from './plotOption';
import { seriesPoints } from '../test/seriesPoints';
import { newTrace } from '../embed/plotConfig';

const AXIS: Axis = {
  id: 'axis-1',
  name: 'Y-Axis 1',
  orientation: 'left',
  autoScale: true,
  logScale: false,
  visible: true,
};
const T0 = Date.UTC(2026, 9, 14, 12, 0, 0);

function curve(id: string, over: Partial<PVTrace> = {}): PVTrace {
  return {
    ...newTrace(id, `TEST:${id}`, AXIS.id, '#0f62fe', []),
    useLive: true,
    useArchive: false,
    ...over,
  };
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
    xAxis: { timeRange: 'custom', timeFrom: '2026-10-14T11:00', timeTo: '2026-10-14T13:00' },
  };
}

function live(values: number[]): LiveSeriesResult {
  return {
    status: 'connected',
    connected: true,
    severity: null,
    latest: null,
    error: null,
    points: values.map((value, i) => ({ time: T0 + i * 1000, value, severity: 'NO_ALARM' })),
    breaks: [],
  };
}

const plot = plotWith([curve('t1'), curve('t2'), curve('t3', { visible: false })]);
const archiveResults = new Map<string, ArchiveSeriesResult>();
const liveResults = new Map<string, LiveSeriesResult>([
  ['t1', live([1, 2, 3])],
  ['t2', live([5, 4])],
  ['t3', live([9])],
]);
const formulaResults = new Map<string, FormulaSeriesResult>();
const base = { plot, archiveResults, liveResults, formulaResults, theme: drawingThemeFor('dark') };

type Formatter = (params: unknown) => unknown;
const formatterOf = (option: ReturnType<typeof buildPlotOption>): Formatter | undefined =>
  (option.tooltip as { formatter?: Formatter } | undefined)?.formatter;

describe('buildPlotOption traceData', () => {
  it('produces the same option with and without a precomputed map', () => {
    const without = buildPlotOption(base);
    const traceData = computeTraceData(plot.traces, archiveResults, liveResults, formulaResults);
    const withMap = buildPlotOption({ ...base, traceData });
    expect(JSON.stringify(withMap)).toBe(JSON.stringify(without));
    // The tooltip formatter reads the map too: identical text for one hover.
    const hover = [{ axisValue: T0 + 1000, value: [T0 + 1000, 2], seriesId: 't1' }];
    expect(formatterOf(withMap)?.(hover)).toEqual(formatterOf(without)?.(hover));
  });

  it('uses the passed map instead of recomputing', () => {
    const forged: TraceDataMap = new Map([['t1', [[T0, 42]]]]);
    const option = buildPlotOption({ ...base, traceData: forged });
    const series = option.series as { data: unknown }[];
    expect(
      series.some((s) => JSON.stringify(seriesPoints(s.data)) === JSON.stringify([[T0, 42]]))
    ).toBe(true);
  });
});

describe('computeTraceData', () => {
  it('covers the visible traces only, keyed by trace id', () => {
    const map = computeTraceData(plot.traces, archiveResults, liveResults, formulaResults);
    expect([...map.keys()]).toEqual(['t1', 't2']);
    expect(map.get('t1')?.map(([, v]) => v)).toEqual([1, 2, 3]);
  });
});

describe('useTraceData', () => {
  it('returns the same Map instance while the inputs are unchanged', () => {
    const { result, rerender } = renderHook(
      ({ live: liveMap }: { live: ReadonlyMap<string, LiveSeriesResult> }) =>
        useTraceData(plot.traces, archiveResults, liveMap, formulaResults),
      { initialProps: { live: liveResults } }
    );
    const first = result.current;
    rerender({ live: liveResults });
    expect(result.current).toBe(first);

    const nextLive = new Map(liveResults);
    nextLive.set('t1', live([1, 2, 3, 4]));
    rerender({ live: nextLive });
    expect(result.current).not.toBe(first);
    expect(result.current.get('t1')?.length).toBe(4);
  });
});
