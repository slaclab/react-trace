// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { newPlot, newTrace } from '../../embed/plotConfig';
import type { LiveSeriesResult } from '../../hooks/useLiveSeries';
import type { Plot } from '../../types';
import {
  sampleAt,
  traceMenuWriters,
  tracePointMenu,
  traceSignalOf,
  type TraceMenuInput,
} from './menu';

function plotWith(): Plot {
  const plot = newPlot('p1', 0);
  const axis = plot.axes[0].id;
  return {
    ...plot,
    axes: [{ ...plot.axes[0], units: 'mA' }],
    traces: [
      newTrace('t1', 'TEST:TEST', axis, '#000', 'archive' as never),
      newTrace('t2', 'TEST:TEST2', axis, '#111', 'archive' as never),
      {
        ...newTrace('f1', '', axis, '#222', 'archive' as never),
        kind: 'formula',
        displayName: 'A+B',
      },
    ],
  };
}

function input(over: Partial<TraceMenuInput> = {}): TraceMenuInput {
  const plot = plotWith();
  const live = {
    points: [
      { time: 1000, value: 1 },
      { time: 2000, value: 2 },
      { time: 3000, value: 3 },
    ],
    breaks: [],
  } as unknown as LiveSeriesResult;
  return {
    state: { plots: [plot], activePlotId: plot.id },
    archiveResultsByPlot: new Map(),
    liveResultsByPlot: new Map([[plot.id, new Map([['t1', live]])]]),
    formulaResultsByPlot: new Map(),
    cursorOf: () => undefined,
    ...over,
  };
}

const t1 = { id: 't1', pv: 'TEST:TEST' };

describe('Trace writers', () => {
  it('a PV curve is a signal; a formula curve is not', () => {
    const { state } = input();
    expect(traceSignalOf(state, 't1')).toEqual(t1);
    expect(traceSignalOf(state, 'f1')).toBeNull();
  });

  it('Copy value: at the cursor (the step at or before it), else the latest', () => {
    expect(
      sampleAt(
        [
          [1, 1],
          [2, null],
          [3, 3],
        ],
        2.5
      )
    ).toEqual([1, 1]);
    const latest = traceMenuWriters(input()).copyValue!(t1)!;
    expect(latest).toMatchObject({ label: 'Copy latest value', text: '3' });
    const at = traceMenuWriters(input({ cursorOf: () => 2500 })).copyValue!(t1)!;
    expect(at.label).toBe('Copy value at cursor');
    expect(at.text).toBe('2');
    expect(at.what).toMatch(/^TEST:TEST = 2 mA at /);
  });

  it('Correlate against the plot’s other PV', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const offer = traceMenuWriters(input()).correlateAgainst!(t1)!;
    expect(offer.label).toBe('Correlate against TEST:TEST2');
    offer.run();
    expect(open.mock.calls[0][0]).toMatch(
      /correlation\.html\?x=TEST:TEST2&y=TEST:TEST&lookback=1h$/
    );
    open.mockRestore();
  });

  it('a point names the time, the value with units and the curve', () => {
    const plot = plotWith();
    const p = {
      at: { localX: 0, localY: 0, clientX: 0, clientY: 0 },
      hit: { t: Date.UTC(2026, 9, 22, 18), v: 1.5, axisId: plot.axes[0].id, traceId: 't1' },
      t: 0,
      v: 0,
    };
    const menu = tracePointMenu(p, {
      plot,
      colorMode: 'light',
      drawingsHidden: false,
      resetView: () => {},
    });
    expect(menu.reading?.header).toMatch(/^\d\d:\d\d:\d\d · 1.500 mA · TEST:TEST$/);
    expect(menu.signals).toEqual([t1]);
    expect(menu.writers?.viewLink?.()).toMatch(/index\.html\?pv=TEST:TEST&pv=TEST:TEST2&range=-1h/);
  });
});
