import { describe, expect, it } from 'vitest';
import type { TimeWindowNs } from '../api/time';
import type { FormulaResultDTO, FormulaSpecDTO } from '../api/types';
import { FormulaStore, type EvaluateFn } from './formulaStore';

// ── Fake Fox: every evaluation stays pending until the test settles it ───────

interface Call {
  expression: string;
  t0Ns: number;
  t1Ns: number;
  signal: AbortSignal;
  resolve: (values?: number[]) => void;
  reject: (err: unknown) => void;
}

// Deliberately ignores `signal`: the store must not rely on an aborted
// request rejecting.
function fakeFox() {
  const calls: Call[] = [];
  const evaluate: EvaluateFn = (spec, t0Ns, t1Ns, signal) =>
    new Promise<FormulaResultDTO>((resolve, reject) => {
      calls.push({
        expression: spec.expression,
        t0Ns,
        t1Ns,
        signal,
        // One point per value, the last one at t1.
        resolve: (values = [1]) =>
          resolve({
            kind: 'timeseries',
            timeseries: {
              tsNs: values.map((_, i) => t1Ns - (values.length - 1 - i) * 1e6),
              values,
              severity: values.map(() => 'NO_ALARM'),
              inputs: {},
              decimated: false,
            },
          }),
        reject,
      });
    });
  return { calls, evaluate };
}

const spec = (expression: string): FormulaSpecDTO => ({
  kind: 'timeseries',
  expression,
  bindings: { x1: 'PV:A' },
});
const win = (fromMs: number, toMs: number): TimeWindowNs => ({
  fromNs: fromMs * 1e6,
  toNs: toMs * 1e6,
});
const HOUR = win(0, 3_600_000);

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

function setup() {
  const fox = fakeFox();
  const store = new FormulaStore({ evaluate: fox.evaluate });
  return { fox, store, entry: (id: string) => store.getSnapshot().get(id) };
}

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
