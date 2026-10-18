// @vitest-environment jsdom
//
// useFormulaSeries against a fake Fox, on fake timers. The probe component
// resolves each formula's window on every render, the way TraceApp does, so a
// "following" window drifts with Date.now() on every re-render.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { useEffect, useState } from 'react';
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
  resolve: (values?: number[]) => void;
  reject: (err: unknown) => void;
}

// Expressions listed in `auto` settle by themselves after `latencyMs` (with
// `error`, if set); the rest stay pending until the test settles them. An abort
// rejects a pending call with AbortError, as fetch does.
const fox = vi.hoisted(() => {
  const calls: FoxCall[] = [];
  const auto = new Map<string, { latencyMs: number; error?: unknown }>();
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
        resolve: (values = [1]) =>
          settle(() =>
            resolve({
              kind: 'timeseries',
              timeseries: {
                tsNs: values.map((_, i) => t1Ns - (values.length - 1 - i) * 1e6),
                values,
                severity: values.map(() => 'NO_ALARM'),
                inputs: {},
                decimated: false,
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
          () => (reply.error ? call.reject(reply.error) : call.resolve()),
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

function mount(props: Omit<ProbeProps, 'onRender'>) {
  const view = render(<Probe {...props} onRender={record} />);
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
