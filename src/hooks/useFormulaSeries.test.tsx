// @vitest-environment jsdom
//
// useFormulaSeries against a fake Fox, on fake timers. The probe component
// resolves each formula's window on every render, the way TraceApp does, so a
// "following" window drifts with Date.now() on every re-render.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { StrictMode, useEffect, useState } from 'react';
import { msToNs, type TimeWindowNs } from '../api/time';
import type { FormulaSpecDTO } from '../api/types';
import { resolveFormulaSpec } from '../formula';
import { formulaTrace, pvTrace } from '../test/traceAppHarness';
import type { PVTrace } from '../types';
import { useFormulaSeries, type FormulaSeriesResult } from './useFormulaSeries';

interface FoxCall {
  expression: string;
  t0Ns: number;
  t1Ns: number;
  signal: AbortSignal;
  settled: boolean;
  resolve: (values?: number[], decimated?: boolean) => void;
  reject: (err: unknown) => void;
}

// Expressions listed in `auto` settle by themselves after `latencyMs` (with
// `error`, if set); the rest stay pending until the test settles them. An abort
// rejects a pending call with AbortError, as fetch does.
const fox = vi.hoisted(() => {
  const calls: FoxCall[] = [];
  const auto = new Map<string, { latencyMs: number; error?: unknown; decimated?: boolean }>();
  // Signature-agnostic: spec, t0, t1 and signal are the last four arguments, so
  // this survives a leading connection argument.
  function evaluate(...args: unknown[]): Promise<unknown> {
    const [spec, t0Ns, t1Ns, signal] = args.slice(-4) as [
      { expression: string },
      number,
      number,
      AbortSignal,
    ];
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (fn: () => void) => {
        if (call.settled) return;
        call.settled = true;
        clearTimeout(timer);
        fn();
      };
      const call: FoxCall = {
        expression: spec.expression,
        t0Ns,
        t1Ns,
        signal,
        settled: false,
        // One point per value, the last one at t1.
        resolve: (values = [1], decimated = false) =>
          settle(() =>
            resolve({
              kind: 'timeseries',
              timeseries: {
                tsNs: values.map((_, i) => t1Ns - (values.length - 1 - i) * 1e6),
                values,
                severity: values.map(() => 'NO_ALARM'),
                inputs: {},
                decimated,
              },
            })
          ),
        reject: (err) => settle(() => reject(err)),
      };
      calls.push(call);
      signal.addEventListener('abort', () =>
        call.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      );
      const reply = auto.get(spec.expression);
      if (reply) {
        timer = setTimeout(
          () => (reply.error ? call.reject(reply.error) : call.resolve(undefined, reply.decimated)),
          reply.latencyMs
        );
      }
    });
  }
  return { calls, auto, evaluate };
});

vi.mock('../api/fox', () => ({ evaluateFormula: fox.evaluate }));

// ── Windows, resolved on every render ────────────────────────────────────────

type WindowFn = () => TimeWindowNs;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

// Relative range resolved from Date.now() on each render (main's TraceApp).
const following =
  (spanMs: number): WindowFn =>
  () => {
    const toNs = msToNs(Date.now());
    return { fromNs: toNs - msToNs(spanMs), toNs };
  };

const fixed =
  (fromMs: number, toMs: number): WindowFn =>
  () => ({ fromNs: msToNs(fromMs), toNs: msToNs(toMs) });

// Relative range anchored to the last autoscroll tick, so it only moves once
// per tick (the per-plot clock model of #97).
const anchored =
  (spanMs: number, tickMs: number): WindowFn =>
  () => {
    const toNs = msToNs(Math.floor(Date.now() / tickMs) * tickMs);
    return { fromNs: toNs - msToNs(spanMs), toNs };
  };

// ── Probe ────────────────────────────────────────────────────────────────────

interface ProbeProps {
  traces: PVTrace[];
  windows: Record<string, WindowFn>;
  // Re-render on an interval, like live-data batches or autoscroll ticks.
  renderEveryMs?: number;
  onRender: (results: Map<string, FormulaSeriesResult>) => void;
}

function Probe({ traces, windows, renderEveryMs, onRender }: ProbeProps) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!renderEveryMs) return;
    const id = setInterval(() => setTick((n) => n + 1), renderEveryMs);
    return () => clearInterval(id);
  }, [renderEveryMs]);
  const specByTrace = new Map<string, FormulaSpecDTO | null>();
  const windowByTrace = new Map<string, TimeWindowNs>();
  for (const t of traces) {
    if (t.kind !== 'formula') continue;
    specByTrace.set(t.id, resolveFormulaSpec(t, traces));
    windowByTrace.set(t.id, windows[t.id]());
  }
  onRender(useFormulaSeries(traces, specByTrace, windowByTrace));
  return null;
}

let frames: Map<string, FormulaSeriesResult>[] = [];
const record = (results: Map<string, FormulaSeriesResult>) => frames.push(results);
const latest = (id: string) => frames[frames.length - 1].get(id);
const callsFor = (expression: string) => fox.calls.filter((c) => c.expression === expression);

// Advance fake time in small steps, letting React render and run effects
// between them as the browser would.
async function advance(ms: number, stepMs = 50) {
  for (let done = 0; done < ms; done += stepMs) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(Math.min(stepMs, ms - done));
    });
  }
}

// Let pending answers land and React catch up, without moving the clock.
const settle = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });

const T0 = Date.UTC(2026, 9, 1, 12);
const source = pvTrace('trace-1', 'PV:A');
const formula = (
  id: string,
  expression: string,
  bindings: Record<string, string> = { x1: 'trace-1' }
) => formulaTrace(id, expression, bindings);

function mount(props: Omit<ProbeProps, 'onRender'>, { strict = false } = {}) {
  const view = render(
    <Probe {...props} onRender={record} />,
    strict ? { wrapper: StrictMode } : {}
  );
  return {
    rerender: (next: Omit<ProbeProps, 'onRender'>) =>
      view.rerender(<Probe {...next} onRender={record} />),
  };
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  fox.calls.length = 0;
  fox.auto.clear();
  frames = [];
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useFormulaSeries results belong to the current spec', () => {
  const windows = { f1: fixed(T0 - HOUR, T0) };

  async function readyWithFive() {
    const view = mount({ traces: [source, formula('f1', '{x1}*2')], windows });
    fox.calls[0].resolve([5]);
    await settle();
    expect(latest('f1')).toMatchObject({ status: 'ready', points: [[T0, 5]] });
    return view;
  }

  it('hides the previous curve while an edited spec evaluates', async () => {
    const view = await readyWithFive();
    view.rerender({ traces: [source, formula('f1', '{x1}*3')], windows });
    await settle();

    expect(latest('f1')).toMatchObject({ status: 'loading', points: [] });
  });

  it('never shows the previous points, not even on the first frame after an edit', async () => {
    const view = await readyWithFive();
    const from = frames.length;
    view.rerender({ traces: [source, formula('f1', '{x1}*3')], windows });
    await settle();

    const shown = frames.slice(from).map((f) => f.get('f1')?.points);
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.every((points) => points?.length === 0)).toBe(true);
  });

  it('shows an error with no points when the edited spec fails', async () => {
    const view = await readyWithFive();
    view.rerender({ traces: [source, formula('f1', '{x1}*')], windows });
    await settle();
    callsFor('{x1}*')[0].reject({ code: 'formula_parse_error', detail: 'bad', status: 400 });
    await settle();

    expect(latest('f1')).toMatchObject({
      status: 'error',
      points: [],
      error: { code: 'formula_parse_error' },
    });
  });

  it('shows nothing once the formula loses a binding', async () => {
    const view = await readyWithFive();
    view.rerender({ traces: [source, formula('f1', '{x1}*2', {})], windows });
    await settle();

    expect(latest('f1')).toEqual({ status: 'idle', points: [] });
  });

  it("doesn't re-evaluate a formula on a fixed window when another one's window moves", async () => {
    fox.auto.set('{x1}*2', { latencyMs: 100 });
    fox.auto.set('{x1}*3', { latencyMs: 100 });
    mount({
      traces: [source, formula('f1', '{x1}*2'), formula('f2', '{x1}*3')],
      windows: { f1: following(HOUR), f2: fixed(T0 - HOUR, T0) },
    });
    await advance(2_000);

    expect(callsFor('{x1}*3')).toHaveLength(1);
    expect(latest('f2')).toMatchObject({ status: 'ready', points: [[T0, 1]] });
  });
});

describe('useFormulaSeries evaluates only when the window needs it', () => {
  const traces = [source, formula('f1', '{x1}*2')];

  it('evaluates a following hour once in 10 s when nothing else re-renders', async () => {
    fox.auto.set('{x1}*2', { latencyMs: 200 });
    mount({ traces, windows: { f1: following(HOUR) } });
    await advance(10_000);

    expect(callsFor('{x1}*2')).toHaveLength(1);
    expect(latest('f1')?.status).toBe('ready');
  });

  it('evaluates a following hour once in 10 s of 10 Hz re-renders', async () => {
    fox.auto.set('{x1}*2', { latencyMs: 200 });
    mount({ traces, windows: { f1: following(HOUR) }, renderEveryMs: 100 });
    await advance(10_000);

    expect(callsFor('{x1}*2')).toHaveLength(1);
  });

  it('re-evaluates a following 5 minutes about every 3 s of drift', async () => {
    fox.auto.set('{x1}*2', { latencyMs: 200 });
    mount({ traces, windows: { f1: following(5 * MINUTE) }, renderEveryMs: 100 });
    await advance(10_000);

    // 1% of 5 minutes is 3 s: at 0, 3.1, 6.2 and 9.3 s.
    expect(callsFor('{x1}*2')).toHaveLength(4);
  });

  it('draws the curve even when re-renders come faster than Fox answers', async () => {
    fox.auto.set('{x1}*2', { latencyMs: 300 });
    mount({ traces, windows: { f1: following(HOUR) }, renderEveryMs: 100 });
    await advance(1_000);

    expect(latest('f1')?.status).toBe('ready');
    expect(callsFor('{x1}*2').filter((c) => c.signal.aborted)).toHaveLength(0);
  });

  it("doesn't let a fast formula starve a slow one", async () => {
    fox.auto.set('{x1}*2', { latencyMs: 50 });
    fox.auto.set('{x1}*3', { latencyMs: 400 });
    mount({
      traces: [source, formula('f1', '{x1}*2'), formula('f2', '{x1}*3')],
      windows: { f1: following(HOUR), f2: following(HOUR) },
    });
    await advance(2_000);

    expect(latest('f2')?.status).toBe('ready');
    expect(callsFor('{x1}*3')).toHaveLength(1);
  });

  it('backs off a failing formula instead of retrying on every render', async () => {
    fox.auto.set('{x1}*2', { latencyMs: 100, error: { code: 'buffer_at_capacity', status: 503 } });
    mount({ traces, windows: { f1: following(5 * MINUTE) }, renderEveryMs: 100 });
    await advance(30_000);

    // At 0, 1, 3, 7 and 15 s (plus Fox's latency each time); the next is due after 30 s.
    expect(callsFor('{x1}*2')).toHaveLength(5);
    expect(latest('f1')).toMatchObject({ status: 'error', error: { code: 'buffer_at_capacity' } });
  });

  it("doesn't retry a 400 as the window moves, but does after a spec edit", async () => {
    fox.auto.set('{x1}*', { latencyMs: 100, error: { code: 'formula_parse_error', status: 400 } });
    fox.auto.set('{x1}*2', { latencyMs: 100 });
    const windows = { f1: following(5 * MINUTE) };
    const view = mount({ traces: [source, formula('f1', '{x1}*')], windows, renderEveryMs: 100 });
    await advance(30_000);
    expect(callsFor('{x1}*')).toHaveLength(1);

    view.rerender({ traces: [source, formula('f1', '{x1}*2')], windows, renderEveryMs: 100 });
    await advance(1_000);
    expect(callsFor('{x1}*2')).toHaveLength(1);
    expect(latest('f1')?.status).toBe('ready');
  });

  it("doesn't call Fox to zoom inside the evaluated window, but does to zoom out", async () => {
    fox.auto.set('{x1}*2', { latencyMs: 100 });
    const view = mount({ traces, windows: { f1: fixed(T0 - HOUR, T0) } });
    await advance(500);

    view.rerender({ traces, windows: { f1: fixed(T0 - 30 * MINUTE, T0 - 20 * MINUTE) } });
    await advance(500);
    expect(callsFor('{x1}*2')).toHaveLength(1);

    view.rerender({ traces, windows: { f1: fixed(T0 - 2 * HOUR, T0) } });
    await advance(500);
    expect(callsFor('{x1}*2')).toHaveLength(2);
  });

  it('re-evaluates a zoom into under half of a decimated result, but not a wider one', async () => {
    fox.auto.set('{x1}*2', { latencyMs: 100, decimated: true });
    const view = mount({ traces, windows: { f1: fixed(T0 - HOUR, T0) } });
    await advance(500);

    view.rerender({ traces, windows: { f1: fixed(T0 - 40 * MINUTE, T0) } });
    await advance(500);
    expect(callsFor('{x1}*2')).toHaveLength(1);

    view.rerender({ traces, windows: { f1: fixed(T0 - 30 * MINUTE, T0 - 20 * MINUTE) } });
    await advance(500);
    expect(callsFor('{x1}*2')).toHaveLength(2);
    expect(latest('f1')).toMatchObject({ status: 'ready', decimated: true });
  });

  it('gives up on a hung evaluation after 30 s, retries it twice, then only for a new span', async () => {
    // No auto reply: Fox never answers.
    const view = mount({ traces, windows: { f1: following(5 * MINUTE) }, renderEveryMs: 100 });
    await advance(30_000);
    expect(latest('f1')).toMatchObject({ status: 'error', error: { code: 'client_timeout' } });
    expect(callsFor('{x1}*2')).toHaveLength(1);

    // Retried at 45 and 90 s; the third timeout, at 120 s, ends it for this span.
    await advance(30_000, 500);
    expect(callsFor('{x1}*2')).toHaveLength(2);
    await advance(120_000, 500);
    expect(callsFor('{x1}*2')).toHaveLength(3);

    view.rerender({ traces, windows: { f1: following(10 * MINUTE) }, renderEveryMs: 100 });
    await advance(100);
    expect(callsFor('{x1}*2')).toHaveLength(4);
  });

  it('with a tick-anchored clock, evaluates an hour about every 40 s and 5 minutes every tick', async () => {
    fox.auto.set('{x1}*2', { latencyMs: 200 });
    fox.auto.set('{x1}*3', { latencyMs: 200 });
    mount({
      traces: [source, formula('f1', '{x1}*2'), formula('f2', '{x1}*3')],
      windows: { f1: anchored(HOUR, 5_000), f2: anchored(5 * MINUTE, 5_000) },
      renderEveryMs: 5_000,
    });
    await advance(120_000, 250);

    // An hour's 36 s tolerance lets 7 ticks pass; 5 minutes' 3 s doesn't.
    expect(callsFor('{x1}*2').length).toBeGreaterThanOrEqual(3);
    expect(callsFor('{x1}*2').length).toBeLessThanOrEqual(4);
    expect(callsFor('{x1}*3')).toHaveLength(1 + 120 / 5);
  });

  it('settles after the StrictMode double mount', async () => {
    fox.auto.set('{x1}*2', { latencyMs: 200 });
    mount({ traces, windows: { f1: following(HOUR) }, renderEveryMs: 100 }, { strict: true });
    await advance(10_000);

    expect(callsFor('{x1}*2').length).toBeLessThanOrEqual(2);
    expect(latest('f1')?.status).toBe('ready');
  });
});
