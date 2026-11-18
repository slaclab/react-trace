// @vitest-environment jsdom
//
// Clear's cut belongs to the PVs and the lookback it was made on: a frame of
// a subscription with other role PVs or another lookback is drawn whole (its
// backfill is what the operator asked for), while a re-subscribe of the same
// PVs and lookback (a tab shown again after hiding) keeps the cut. The old
// frame stays cut until the new subscription's first frame arrives.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import type {
  FormulaEngineSubscribeOptions,
  FormulaSpec,
  TableResultDTO,
} from '@slaclab/canopy-client';
import { parseCorrelationQuery } from './query';
import { buildTableSpec } from './spec';
import { TableController, type PlotFrame } from './useTable';
import { defaultMetrics } from '../../statistics/model';
import { CORRELATION_METRICS } from './metrics';
import type { PvModel } from '../shared/pvTracker';

vi.mock('echarts-for-react', async () => {
  const React = await import('react');
  class MockECharts extends React.Component {
    render() {
      return React.createElement('div');
    }
  }
  return { default: MockECharts };
});

const { useCorrelationFrame } = await import('./Plot');

const S = 1_000_000_000;
const BASE = 1_790_000_000_000_000_000;
const OK = { history: 'seeded', status: 'ok', lateAfterFinal: false } as const;
const METRICS = defaultMetrics(CORRELATION_METRICS);

/** Rows at BASE + i s for i in [from, to). */
function rows(from: number, to: number): TableResultDTO {
  const tsNs = Array.from({ length: to - from }, (_, i) => BASE + (from + i) * S);
  return {
    tsNs,
    columns: { x: tsNs.map((_, i) => i), y: tsNs.map((_, i) => 2 * i) },
    inputs: { x: { ...OK }, y: { ...OK }, trig: { ...OK } },
    totalRows: tsNs.length,
  };
}

/** A controller over a fake service; `push` answers the newest subscription. */
function controller() {
  const calls: FormulaEngineSubscribeOptions[] = [];
  const c = new TableController();
  c.attach({
    status: 'connected',
    connect: () => {},
    dispose: () => {},
    subscribe: (_spec: FormulaSpec, opts: FormulaEngineSubscribeOptions) => {
      calls.push(opts);
      return () => {};
    },
  });
  c.setWanted(true);
  const setQuery = (q: string) => {
    const state = parseCorrelationQuery(q);
    const model: PvModel = {
      x: { pv: state.x, status: 'ok', units: '' },
      ys: state.ys.map((pv) => ({ pv, status: 'ok' as const, units: '' })),
      trig: null,
      axisUnit: null,
      decided: true,
    };
    c.setSpec(buildTableSpec(state, model));
    vi.advanceTimersByTime(300);
  };
  const push = (t: TableResultDTO): PlotFrame => {
    calls[calls.length - 1].onResult({
      kind: 'table',
      scalar: null,
      timeseries: null,
      waveform: null,
      table: t,
    });
    const frame = c.getSnapshot().frame!;
    // Close the coalescing window, so the next frame is handed over at once.
    vi.advanceTimersByTime(300);
    return frame;
  };
  return { c, calls, setQuery, push };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function mountFrame(first: PlotFrame) {
  return renderHook(({ f }: { f: PlotFrame | null }) => useCorrelationFrame(f, METRICS), {
    initialProps: { f: first as PlotFrame | null },
  });
}

describe('the Clear cut', () => {
  const QUERY = 'x=TEST:SINE&y=DEMO:Y&dt=1&lookback=10m';

  it.each([
    ['a lookback change', 'x=TEST:SINE&y=DEMO:Y&dt=1&lookback=6h'],
    ['an X swap', 'x=TEST:COSINE&y=DEMO:Y&dt=1&lookback=10m'],
    ['a Y swap', 'x=TEST:SINE&y=DEMO:Y2&dt=1&lookback=10m'],
  ])('is dropped by %s once the new subscription draws', (_name, next) => {
    const { setQuery, push } = controller();
    setQuery(QUERY);
    const before = push(rows(0, 10));
    const hook = mountFrame(before);
    act(() => hook.result.current.clear());
    expect(hook.result.current.shown?.table.tsNs).toEqual([]);
    expect(hook.result.current.cut).toBe(BASE + 9 * S);

    // The edit: until the new subscription's first frame the old frame stays cut.
    setQuery(next);
    hook.rerender({ f: before });
    expect(hook.result.current.shown?.table.tsNs).toEqual([]);

    // The new subscription backfills the history before the Clear.
    const after = push(rows(0, 12));
    hook.rerender({ f: after });
    expect(hook.result.current.cut).toBeNull();
    expect(hook.result.current.shown?.table.tsNs).toHaveLength(12);
  });

  it('is kept across a re-subscribe of the same PVs and lookback', () => {
    const { c, calls, setQuery, push } = controller();
    setQuery(QUERY);
    const hook = mountFrame(push(rows(0, 10)));
    act(() => hook.result.current.clear());
    // Hidden long, then shown again: a new subscription of the same spec.
    c.setWanted(false);
    c.setWanted(true);
    expect(calls).toHaveLength(2);
    hook.rerender({ f: push(rows(0, 12)) });
    expect(hook.result.current.cut).toBe(BASE + 9 * S);
    expect(hook.result.current.shown?.table.tsNs).toEqual([BASE + 10 * S, BASE + 11 * S]);
  });

  it('is kept for later frames of the same subscription', () => {
    const { setQuery, push } = controller();
    setQuery(QUERY);
    const hook = mountFrame(push(rows(0, 10)));
    act(() => hook.result.current.clear());
    hook.rerender({ f: push(rows(5, 15)) });
    expect(hook.result.current.shown?.table.tsNs).toHaveLength(5);
  });

  it('does not come back when the PVs return to the ones it was made on', () => {
    const { setQuery, push } = controller();
    setQuery(QUERY);
    const hook = mountFrame(push(rows(0, 10)));
    act(() => hook.result.current.clear());
    setQuery('x=TEST:COSINE&y=DEMO:Y&dt=1&lookback=10m');
    hook.rerender({ f: push(rows(0, 10)) });
    setQuery(QUERY);
    hook.rerender({ f: push(rows(0, 10)) });
    expect(hook.result.current.cut).toBeNull();
    expect(hook.result.current.shown?.table.tsNs).toHaveLength(10);
  });
});
