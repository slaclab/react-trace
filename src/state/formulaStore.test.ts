import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TimeWindowNs } from '../api/time';
import type { FormulaResultDTO, FormulaSpecDTO } from '../api/types';
import {
  EVAL_TIMEOUT_MS,
  FormulaStore,
  NEAR_NOW_SLACK_MS,
  isTerminalError,
  type EvaluateFn,
  type FormulaErrorInfo,
} from './formulaStore';

// ── Fake Fox: each evaluation stays pending until settled (by the test, or by
// `reply` right away) ─────────────────────────────────────────────────────────

interface Call {
  expression: string;
  t0Ns: number;
  t1Ns: number;
  signal: AbortSignal;
  // Fake clock time the request went out, relative to T0.
  atMs: number;
  resolve: (values?: number[], decimated?: boolean) => void;
  reject: (err: unknown) => void;
}

// Deliberately ignores `signal`: the store must not rely on an aborted
// request rejecting.
function fakeFox(reply?: (call: Call) => void) {
  const calls: Call[] = [];
  const evaluate: EvaluateFn = (spec, t0Ns, t1Ns, signal) =>
    new Promise<FormulaResultDTO>((resolve, reject) => {
      const call: Call = {
        expression: spec.expression,
        t0Ns,
        t1Ns,
        signal,
        atMs: Date.now() - T0,
        // One point per value, the last one at t1.
        resolve: (values = [1], decimated = false) =>
          resolve({
            kind: 'timeseries',
            timeseries: {
              tsNs: values.map((_, i) => t1Ns - (values.length - 1 - i) * 1e6),
              values,
              severity: values.map(() => 'NO_ALARM'),
              inputs: {},
              decimated,
            },
          }),
        reject,
      };
      calls.push(call);
      reply?.(call);
    });
  return { calls, evaluate };
}

const T0 = Date.UTC(2026, 9, 1, 12);
const MINUTE = 60_000;

const spec = (expression: string): FormulaSpecDTO => ({
  kind: 'timeseries',
  expression,
  bindings: { x1: 'PV:A' },
});
const win = (fromMs: number, toMs: number): TimeWindowNs => ({
  fromNs: fromMs * 1e6,
  toNs: toMs * 1e6,
});
// A historical hour, far behind the fake clock.
const HOUR = win(0, 3_600_000);
// The last `spanMs` up to the fake clock's now.
const lastSpan = (spanMs: number) => win(Date.now() - spanMs, Date.now());

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

function setup(reply?: (call: Call) => void) {
  const fox = fakeFox(reply);
  const store = new FormulaStore({ evaluate: fox.evaluate });
  return { fox, store, entry: (id: string) => store.getSnapshot().get(id) };
}

const err = (status: number, code: string): FormulaErrorInfo & { status: number } => ({
  status,
  code,
  detail: code,
});

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('FormulaStore identity', () => {
  it('starts a new spec from no points and replaces the previous one', async () => {
    const { fox, store, entry } = setup();
    store.request('f1', { spec: spec('{x1}*2'), window: HOUR });
    expect(entry('f1')).toMatchObject({ status: 'loading', points: [] });

    fox.calls[0].resolve([5]);
    await flush();
    expect(entry('f1')).toMatchObject({ status: 'ready', points: [[3_600_000, 5]] });

    store.request('f1', { spec: spec('{x1}*3'), window: HOUR });
    expect(entry('f1')).toMatchObject({ status: 'loading', points: [] });
    expect(fox.calls).toHaveLength(2);
  });

  it('aborts and ignores the outgoing spec when the spec changes mid-flight', async () => {
    const { fox, store, entry } = setup();
    store.request('f1', { spec: spec('{x1}*2'), window: HOUR });
    store.request('f1', { spec: spec('{x1}*3'), window: HOUR });
    expect(fox.calls[0].signal.aborted).toBe(true);

    fox.calls[0].resolve([5]);
    await flush();
    expect(entry('f1')).toMatchObject({ status: 'loading', points: [] });

    fox.calls[1].resolve([9]);
    await flush();
    expect(entry('f1')).toMatchObject({ status: 'ready', points: [[3_600_000, 9]] });
  });

  it('shows an error under a new spec with no points', async () => {
    const { fox, store, entry } = setup();
    store.request('f1', { spec: spec('{x1}*2'), window: HOUR });
    fox.calls[0].resolve([5]);
    await flush();

    store.request('f1', { spec: spec('{x1}*'), window: HOUR });
    fox.calls[1].reject({ code: 'formula_parse_error', detail: 'bad', status: 400 });
    await flush();
    expect(entry('f1')).toMatchObject({
      status: 'error',
      points: [],
      error: { code: 'formula_parse_error', detail: 'bad', status: 400 },
    });
  });

  it("keeps the last good points when the same spec's re-evaluation fails", async () => {
    const { fox, store, entry } = setup();
    store.request('f1', { spec: spec('{x1}*2'), window: HOUR });
    fox.calls[0].resolve([5]);
    await flush();

    store.request('f1', { spec: spec('{x1}*2'), window: win(0, 7_200_000) });
    fox.calls[1].reject({ code: 'buffer_at_capacity', detail: 'full', status: 503 });
    await flush();
    expect(entry('f1')).toMatchObject({ status: 'error', points: [[3_600_000, 5]] });
  });

  it('drops the entry when the spec becomes unevaluable', async () => {
    const { fox, store, entry } = setup();
    store.request('f1', { spec: spec('{x1}*2'), window: HOUR });
    fox.calls[0].resolve([5]);
    await flush();
    store.request('f1', { spec: spec('{x1}*2'), window: win(0, 7_200_000) });

    store.request('f1', { spec: null, window: HOUR });
    expect(entry('f1')).toBeUndefined();
    expect(fox.calls[1].signal.aborted).toBe(true);
  });

  it('reads a non-Canopy failure as unknown_error', async () => {
    const { fox, store, entry } = setup();
    store.request('f1', { spec: spec('{x1}*2'), window: HOUR });
    fox.calls[0].reject(new TypeError('Failed to fetch'));
    await flush();
    expect(entry('f1')?.error).toEqual({ code: 'unknown_error', detail: 'Failed to fetch' });
  });
});

describe('FormulaStore requests', () => {
  it("never aborts another trace's request", () => {
    const { fox, store } = setup();
    store.request('f1', { spec: spec('{x1}*2'), window: HOUR });
    store.request('f2', { spec: spec('{x1}*3'), window: HOUR });
    store.request('f1', { spec: spec('{x1}*2'), window: win(0, 7_200_000) });

    expect(fox.calls.map((c) => [c.expression, c.signal.aborted])).toEqual([
      ['{x1}*2', true],
      ['{x1}*3', false],
      ['{x1}*2', false],
    ]);
  });

  it("doesn't publish or evaluate for a request that changes nothing", async () => {
    const { fox, store } = setup();
    store.request('f1', { spec: spec('{x1}*2'), window: HOUR });
    fox.calls[0].resolve();
    await flush();
    const before = store.getSnapshot();
    let published = 0;
    store.subscribe(() => published++);

    store.request('f1', { spec: spec('{x1}*2'), window: HOUR });
    store.release('missing');
    store.retain(new Set(['f1']));

    expect(store.getSnapshot()).toBe(before);
    expect(published).toBe(0);
    expect(fox.calls).toHaveLength(1);
  });

  it('retain releases every trace not listed', () => {
    const { fox, store, entry } = setup();
    store.request('f1', { spec: spec('{x1}*2'), window: HOUR });
    store.request('f2', { spec: spec('{x1}*3'), window: HOUR });

    store.retain(new Set(['f1']));
    expect(entry('f2')).toBeUndefined();
    expect(fox.calls[1].signal.aborted).toBe(true);
    expect(fox.calls[0].signal.aborted).toBe(false);
  });

  it('dispose aborts everything without publishing, and the store stays usable', async () => {
    const { fox, store, entry } = setup();
    store.request('f1', { spec: spec('{x1}*2'), window: HOUR });
    store.request('f2', { spec: spec('{x1}*3'), window: HOUR });
    let published = 0;
    store.subscribe(() => published++);

    store.dispose();
    expect(fox.calls.every((c) => c.signal.aborted)).toBe(true);
    expect(published).toBe(0);
    fox.calls[0].resolve();
    await flush();
    expect(published).toBe(0);

    store.request('f1', { spec: spec('{x1}*2'), window: HOUR });
    expect(fox.calls).toHaveLength(3);
    fox.calls[2].resolve([4]);
    await flush();
    expect(entry('f1')).toMatchObject({ status: 'ready', points: [[3_600_000, 4]] });
  });
});

describe('FormulaStore coverage', () => {
  it('draws a window inside the evaluated range without asking Fox', async () => {
    const { fox, store } = setup((c) => c.resolve());
    store.request('f1', { spec: spec('{x1}*2'), window: HOUR });
    await flush();

    store.request('f1', { spec: spec('{x1}*2'), window: win(10 * MINUTE, 20 * MINUTE) });
    store.request('f1', { spec: spec('{x1}*2'), window: win(0, 3_600_000 + 30_000) });
    expect(fox.calls).toHaveLength(1);

    store.request('f1', { spec: spec('{x1}*2'), window: win(0, 7_200_000) });
    expect(fox.calls).toHaveLength(2);
  });

  it('re-evaluates a window following "now" once it drifts past the slack', async () => {
    const { fox, store } = setup((c) => c.resolve());
    // 1% of 5 minutes is 3 s, which outweighs the 2 s minimum slack.
    store.request('f1', { spec: spec('{x1}*2'), window: lastSpan(5 * MINUTE) });
    await flush();

    vi.setSystemTime(T0 + 2_900);
    store.request('f1', { spec: spec('{x1}*2'), window: lastSpan(5 * MINUTE) });
    expect(fox.calls).toHaveLength(1);

    vi.setSystemTime(T0 + 3_100);
    store.request('f1', { spec: spec('{x1}*2'), window: lastSpan(5 * MINUTE) });
    expect(fox.calls).toHaveLength(2);
  });

  it('applies the near-now slack only to windows that reach "now"', async () => {
    const { fox, store } = setup((c) => c.resolve());
    const slid = (w: TimeWindowNs, ms: number) => ({
      fromNs: w.fromNs + ms * 1e6,
      toNs: w.toNs + ms * 1e6,
    });
    // One minute: 1% is 0.6 s, so the 2 s slack decides near "now".
    const recent = lastSpan(MINUTE);
    const historical = win(T0 - 61 * MINUTE, T0 - 60 * MINUTE);
    store.request('recent', { spec: spec('{x1}*2'), window: recent });
    store.request('historical', { spec: spec('{x1}*3'), window: historical });
    await flush();

    const drift = NEAR_NOW_SLACK_MS - 500;
    vi.setSystemTime(T0 + drift);
    store.request('recent', { spec: spec('{x1}*2'), window: slid(recent, drift) });
    store.request('historical', { spec: spec('{x1}*3'), window: slid(historical, drift) });
    expect(fox.calls.map((c) => c.expression)).toEqual(['{x1}*2', '{x1}*3', '{x1}*3']);
  });
});

describe('FormulaStore decimated results', () => {
  // Evaluate the historical hour, answered with `decimated`, then zoom to `zoom`.
  async function zoomInto(decimated: boolean, zoom: TimeWindowNs) {
    const { fox, store } = setup((c) => c.resolve([1], decimated));
    store.request('f1', { spec: spec('{x1}*2'), window: HOUR });
    await flush();
    store.request('f1', { spec: spec('{x1}*2'), window: zoom });
    await flush();
    return fox.calls;
  }

  it('re-evaluates a zoom into under half of a decimated result', async () => {
    const calls = await zoomInto(true, win(10 * MINUTE, 20 * MINUTE));
    expect(calls).toHaveLength(2);
    expect([calls[1].t0Ns, calls[1].t1Ns]).toEqual([10 * MINUTE * 1e6, 20 * MINUTE * 1e6]);
  });

  it('draws the same zoom from a result that was not decimated', async () => {
    expect(await zoomInto(false, win(10 * MINUTE, 20 * MINUTE))).toHaveLength(1);
  });

  it('draws a zoom to more than half of a decimated result from what it has', async () => {
    expect(await zoomInto(true, win(10 * MINUTE, 45 * MINUTE))).toHaveLength(1);
  });

  it('re-evaluates when zooming back out past the detailed window', async () => {
    const { fox, store } = setup((c) => c.resolve([1], true));
    store.request('f1', { spec: spec('{x1}*2'), window: HOUR });
    await flush();
    store.request('f1', { spec: spec('{x1}*2'), window: win(10 * MINUTE, 20 * MINUTE) });
    await flush();
    store.request('f1', { spec: spec('{x1}*2'), window: HOUR });
    await flush();
    expect(fox.calls).toHaveLength(3);
  });
});

describe('FormulaStore in-flight requests', () => {
  it("doesn't abort or repeat a request when the window only slides forward", async () => {
    const { fox, store, entry } = setup();
    store.request('f1', { spec: spec('{x1}*2'), window: lastSpan(5 * MINUTE) });
    for (let ms = 100; ms <= 2_000; ms += 100) {
      vi.setSystemTime(T0 + ms);
      store.request('f1', { spec: spec('{x1}*2'), window: lastSpan(5 * MINUTE) });
    }
    expect(fox.calls).toHaveLength(1);
    expect(fox.calls[0].signal.aborted).toBe(false);

    fox.calls[0].resolve();
    await flush();
    expect(entry('f1')?.status).toBe('ready');
    expect(fox.calls).toHaveLength(1);
  });

  it('re-sends when the window moves back or changes span', () => {
    const { fox, store } = setup();
    // Panned back by a whole span, then zoomed out.
    store.request('f1', { spec: spec('{x1}*2'), window: win(3_600_000, 7_200_000) });
    store.request('f1', { spec: spec('{x1}*2'), window: HOUR });
    store.request('f1', { spec: spec('{x1}*2'), window: win(0, 7_200_000) });

    expect(fox.calls.map((c) => c.signal.aborted)).toEqual([true, true, false]);
  });

  it('re-sends when the window jumps forward past the in-flight one', () => {
    const { fox, store } = setup();
    store.request('f1', { spec: spec('{x1}*2'), window: HOUR });
    store.request('f1', { spec: spec('{x1}*2'), window: win(10 * 3_600_000, 11 * 3_600_000) });

    expect(fox.calls.map((c) => c.signal.aborted)).toEqual([true, false]);
  });

  it('drops an in-flight request when the window comes back inside the evaluated range', async () => {
    const { fox, store, entry } = setup();
    store.request('f1', { spec: spec('{x1}*2'), window: HOUR });
    fox.calls[0].resolve([5]);
    await flush();
    store.request('f1', { spec: spec('{x1}*2'), window: win(3_600_000, 7_200_000) });
    store.request('f1', { spec: spec('{x1}*2'), window: win(10 * MINUTE, 50 * MINUTE) });
    expect(fox.calls[1].signal.aborted).toBe(true);

    fox.calls[1].resolve([9]);
    await flush();
    expect(entry('f1')).toMatchObject({ status: 'ready', points: [[3_600_000, 5]] });
    expect(fox.calls).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits for an answer slower than a short following window spans', async () => {
    const { fox, store, entry } = setup();
    // 15 s span, and Fox takes 20 s: the window passes the request entirely.
    store.request('f1', { spec: spec('{x1}*2'), window: lastSpan(15_000) });
    for (let ms = 100; ms <= 20_000; ms += 100) {
      await vi.advanceTimersByTimeAsync(100);
      store.request('f1', { spec: spec('{x1}*2'), window: lastSpan(15_000) });
    }
    expect(fox.calls).toHaveLength(1);
    expect(fox.calls[0].signal.aborted).toBe(false);

    fox.calls[0].resolve();
    await flush();
    expect(entry('f1')?.status).toBe('ready');
  });

  it('keeps waiting when the window was resolved a little before the request went out', async () => {
    const { fox, store } = setup();
    // Rendered 100 ms before the effect sent it: 2% of this 5 s span.
    const rendered = win(Date.now() - 5_100, Date.now() - 100);
    store.request('f1', { spec: spec('{x1}*2'), window: rendered });
    for (let ms = 100; ms <= 12_000; ms += 100) {
      await vi.advanceTimersByTimeAsync(100);
      store.request('f1', { spec: spec('{x1}*2'), window: lastSpan(5_000) });
    }
    expect(fox.calls).toHaveLength(1);
  });

  it("doesn't wait on a historical request the window was panned past", async () => {
    const { fox, store } = setup();
    const start = T0 - 60 * MINUTE;
    store.request('f1', { spec: spec('{x1}*2'), window: win(start, start + 10_000) });
    // Fox is slow: 15 s in, the user drags the 10 s view 12 s forward.
    await vi.advanceTimersByTimeAsync(15_000);
    store.request('f1', { spec: spec('{x1}*2'), window: win(start + 12_000, start + 22_000) });

    expect(fox.calls.map((c) => c.signal.aborted)).toEqual([true, false]);
  });

  it('catches up after an answer when the window slid past it and then stopped', async () => {
    const { fox, store } = setup();
    store.request('f1', { spec: spec('{x1}*2'), window: lastSpan(5 * MINUTE) });
    vi.setSystemTime(T0 + 4_000);
    const frozen = lastSpan(5 * MINUTE);
    store.request('f1', { spec: spec('{x1}*2'), window: frozen });
    expect(fox.calls).toHaveLength(1);

    fox.calls[0].resolve();
    await flush();
    expect(fox.calls).toHaveLength(2);
    expect(fox.calls[1].t1Ns).toBe(frozen.toNs);
  });
});

describe('FormulaStore failures', () => {
  it.each([
    [400, 'formula_parse_error', true],
    [400, 'formula_unsafe', true],
    [400, 'formula_circular_reference', true],
    [422, 'formula_type_error', true],
    [422, 'formula_dimension_mismatch', true],
    [422, 'window_too_large', true],
    [422, 'validation_error', true],
    [422, 'unknown_error', true],
    [422, 'formula_input_missing', false],
    [404, 'pv_not_buffered', false],
    [504, 'formula_eval_timeout', false],
    [503, 'buffer_at_capacity', false],
    [429, 'subscription_limit_exceeded', false],
    [0, 'network_error', false],
  ])('classifies %i %s as terminal: %s', (status, code, terminal) => {
    expect(isTerminalError(err(status, code))).toBe(terminal);
  });

  it('classifies a client timeout as terminal and an unknown failure as transient', () => {
    expect(isTerminalError({ code: 'client_timeout', detail: '' })).toBe(true);
    expect(isTerminalError({ code: 'unknown_error', detail: 'Failed to fetch' })).toBe(false);
  });

  it('retries a transient failure on a backoff timer: 1, 2, 4, 8, then every 15 s', async () => {
    const { fox, store, entry } = setup((c) => c.reject(err(504, 'formula_eval_timeout')));
    store.request('f1', { spec: spec('{x1}*2'), window: HOUR });
    await vi.advanceTimersByTimeAsync(45_000);

    expect(fox.calls.map((c) => c.atMs)).toEqual([0, 1_000, 3_000, 7_000, 15_000, 30_000, 45_000]);
    expect(entry('f1')).toMatchObject({ status: 'error', error: { code: 'formula_eval_timeout' } });
  });

  it('waits out the backoff when the window moves, then retries the latest window', async () => {
    const { fox, store } = setup((c) => {
      if (fox.calls.length === 1) c.reject(err(503, 'buffer_at_capacity'));
    });
    store.request('f1', { spec: spec('{x1}*2'), window: lastSpan(5 * MINUTE) });
    let latest = lastSpan(5 * MINUTE);
    for (let ms = 100; ms < 1_000; ms += 100) {
      await vi.advanceTimersByTimeAsync(100);
      latest = lastSpan(5 * MINUTE);
      store.request('f1', { spec: spec('{x1}*2'), window: latest });
    }
    expect(fox.calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(100);
    expect(fox.calls).toHaveLength(2);
    expect(fox.calls[1].t1Ns).toBe(latest.toNs);
  });

  it('shows ready once the window is back inside the evaluated range', async () => {
    const { fox, store, entry } = setup((c) => {
      if (fox.calls.length > 1) c.reject(err(503, 'buffer_at_capacity'));
    });
    store.request('f1', { spec: spec('{x1}*2'), window: HOUR });
    fox.calls[0].resolve([5]);
    await flush();
    store.request('f1', { spec: spec('{x1}*2'), window: win(3_600_000, 7_200_000) });
    await flush();
    expect(entry('f1')?.status).toBe('error');

    store.request('f1', { spec: spec('{x1}*2'), window: win(10 * MINUTE, 50 * MINUTE) });
    expect(entry('f1')?.status).toBe('ready');
    expect(entry('f1')?.error).toBeUndefined();
    expect(entry('f1')?.points).toEqual([[3_600_000, 5]]);
    // The retry finds the window covered and does nothing.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fox.calls).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("doesn't let moves in and out of the evaluated range get round the backoff", async () => {
    const { fox, store, entry } = setup((c) => {
      if (fox.calls.length > 1) c.reject(err(503, 'buffer_at_capacity'));
    });
    const inside = win(10 * MINUTE, 50 * MINUTE);
    const outside = win(3_600_000, 7_200_000);
    store.request('f1', { spec: spec('{x1}*2'), window: HOUR });
    fox.calls[0].resolve();
    await flush();
    store.request('f1', { spec: spec('{x1}*2'), window: outside });
    await flush();

    store.request('f1', { spec: spec('{x1}*2'), window: inside });
    store.request('f1', { spec: spec('{x1}*2'), window: outside });
    expect(fox.calls).toHaveLength(2);
    expect(entry('f1')?.status).toBe('error');

    // The 1 s retry goes out, fails, and the next one waits 2 s.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fox.calls.map((c) => c.atMs)).toEqual([0, 0, 1_000]);
    store.request('f1', { spec: spec('{x1}*2'), window: inside });
    store.request('f1', { spec: spec('{x1}*2'), window: outside });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fox.calls).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(fox.calls.map((c) => c.atMs)).toEqual([0, 0, 1_000, 3_000]);
  });

  it('shows ready over a terminal failure for another window, and the failure again on its span', async () => {
    // A decimated hour, then a 10-minute zoom whose detail request times out.
    const { fox, store, entry } = setup((c) => {
      if (fox.calls.length === 1) c.resolve([1], true);
    });
    store.request('f1', { spec: spec('{x1}*2'), window: HOUR });
    await flush();
    store.request('f1', { spec: spec('{x1}*2'), window: win(10 * MINUTE, 20 * MINUTE) });
    await vi.advanceTimersByTimeAsync(EVAL_TIMEOUT_MS);
    expect(entry('f1')).toMatchObject({ status: 'error', error: { code: 'client_timeout' } });

    store.request('f1', { spec: spec('{x1}*2'), window: win(10 * MINUTE, 50 * MINUTE) });
    expect(entry('f1')?.status).toBe('ready');

    store.request('f1', { spec: spec('{x1}*2'), window: win(30 * MINUTE, 40 * MINUTE) });
    expect(entry('f1')).toMatchObject({ status: 'error', error: { code: 'client_timeout' } });
    expect(fox.calls).toHaveLength(2);
  });

  it('drops an in-flight request for another window when a terminal failure blocks the new one', async () => {
    const { fox, store, entry } = setup();
    store.request('f1', { spec: spec('{x1}*2'), window: HOUR });
    await vi.advanceTimersByTimeAsync(EVAL_TIMEOUT_MS);
    store.request('f1', { spec: spec('{x1}*2'), window: win(0, 10 * MINUTE) });
    expect(fox.calls).toHaveLength(2);

    // Back to a 1-hour span, the one that timed out.
    store.request('f1', { spec: spec('{x1}*2'), window: win(3_600_000, 7_200_000) });
    expect(fox.calls[1].signal.aborted).toBe(true);
    fox.calls[1].resolve([9]);
    await flush();
    expect(fox.calls).toHaveLength(2);
    expect(entry('f1')).toMatchObject({
      status: 'error',
      points: [],
      error: { code: 'client_timeout' },
    });
  });

  it('starts the backoff over after a success', async () => {
    const outcomes = ['fail', 'fail', 'ok', 'fail'];
    const { fox, store } = setup((c) => {
      if (outcomes[fox.calls.length - 1] === 'ok') c.resolve();
      else c.reject(err(503, 'buffer_at_capacity'));
    });
    store.request('f1', { spec: spec('{x1}*2'), window: HOUR });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(fox.calls.map((c) => c.atMs)).toEqual([0, 1_000, 3_000]);

    store.request('f1', { spec: spec('{x1}*2'), window: win(0, 7_200_000) });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fox.calls.map((c) => c.atMs)).toEqual([0, 1_000, 3_000, 3_000, 4_000]);
  });

  it("doesn't retry a terminal failure as the window moves; a new span or spec does", async () => {
    const { fox, store, entry } = setup((c) => {
      if (c.expression === '{x1}*') c.reject(err(400, 'formula_parse_error'));
    });
    store.request('f1', { spec: spec('{x1}*'), window: lastSpan(5 * MINUTE) });
    for (let s = 1; s <= 60; s++) {
      await vi.advanceTimersByTimeAsync(1_000);
      store.request('f1', { spec: spec('{x1}*'), window: lastSpan(5 * MINUTE) });
    }
    expect(fox.calls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(entry('f1')).toMatchObject({ status: 'error', error: { status: 400 } });

    store.request('f1', { spec: spec('{x1}*'), window: lastSpan(10 * MINUTE) });
    await flush();
    store.request('f1', { spec: spec('{x1}*'), window: lastSpan(10 * MINUTE) });
    expect(fox.calls).toHaveLength(2);

    store.request('f1', { spec: spec('{x1}*2'), window: lastSpan(10 * MINUTE) });
    expect(fox.calls).toHaveLength(3);
  });
});

describe('FormulaStore client timeout', () => {
  it('gives up after EVAL_TIMEOUT_MS and shows an error, even if the request ignores its signal', async () => {
    const { fox, store, entry } = setup();
    store.request('f1', { spec: spec('{x1}*2'), window: lastSpan(5 * MINUTE) });
    await vi.advanceTimersByTimeAsync(EVAL_TIMEOUT_MS - 1);
    expect(entry('f1')?.status).toBe('loading');

    await vi.advanceTimersByTimeAsync(1);
    expect(entry('f1')).toMatchObject({
      status: 'error',
      points: [],
      error: { code: 'client_timeout' },
    });
    expect(fox.calls[0].signal.aborted).toBe(true);

    // A late answer for the abandoned request is ignored.
    fox.calls[0].resolve();
    await flush();
    expect(entry('f1')?.status).toBe('error');
  });

  it('keeps the last good points when a re-evaluation of the same spec times out', async () => {
    const { fox, store, entry } = setup();
    store.request('f1', { spec: spec('{x1}*2'), window: HOUR });
    fox.calls[0].resolve([5]);
    await flush();

    store.request('f1', { spec: spec('{x1}*2'), window: win(0, 7_200_000) });
    await vi.advanceTimersByTimeAsync(EVAL_TIMEOUT_MS);
    expect(entry('f1')).toMatchObject({
      status: 'error',
      points: [[3_600_000, 5]],
      error: { code: 'client_timeout' },
    });
  });

  it("isn't retried on a timer or as the window drifts; a new span or spec retries", async () => {
    const { fox, store } = setup();
    store.request('f1', { spec: spec('{x1}*2'), window: lastSpan(5 * MINUTE) });
    await vi.advanceTimersByTimeAsync(EVAL_TIMEOUT_MS);
    expect(vi.getTimerCount()).toBe(0);

    for (let s = 1; s <= 60; s++) {
      await vi.advanceTimersByTimeAsync(1_000);
      store.request('f1', { spec: spec('{x1}*2'), window: lastSpan(5 * MINUTE) });
    }
    expect(fox.calls).toHaveLength(1);

    store.request('f1', { spec: spec('{x1}*2'), window: lastSpan(10 * MINUTE) });
    expect(fox.calls).toHaveLength(2);
    store.request('f1', { spec: spec('{x1}*3'), window: lastSpan(10 * MINUTE) });
    expect(fox.calls).toHaveLength(3);
  });
});

describe('FormulaStore timers', () => {
  it('release, a spec change and dispose clear the timeout and retry timers', async () => {
    const { store } = setup((c) => {
      if (c.expression === '{x1}*3') c.reject(err(503, 'buffer_at_capacity'));
    });
    store.request('f1', { spec: spec('{x1}*2'), window: HOUR }); // in flight: timeout timer
    store.request('f2', { spec: spec('{x1}*3'), window: HOUR }); // failed: retry timer
    await flush();
    expect(vi.getTimerCount()).toBe(2);

    store.release('f2');
    expect(vi.getTimerCount()).toBe(1);

    store.request('f1', { spec: spec('{x1}*4'), window: HOUR });
    expect(vi.getTimerCount()).toBe(1);

    store.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});
