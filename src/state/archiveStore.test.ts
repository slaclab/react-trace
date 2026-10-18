import { describe, it, expect, vi, afterEach } from 'vitest';
import { ArchiveStore, DEFAULT_OPTIMIZED_BINS, type FetchDataFn } from './archiveStore';
import { CanopyError } from '../api/client';
import type { ArchiverDataDTO } from '../api/types';
import type { TimeWindowNs } from '../api/time';
import type { FetchDataParams } from '../api/mole';

// Regression tests for #93: the archiver must not be re-queried as "now"
// advances for a PV it doesn't have, and other failures back off instead of
// retrying on every window move. Each test drives `request()` the way
// useArchiveSeries does (once per render, window sliding with the clock) and
// counts calls to an injected `fetchData`.

const T0_MS = 1_700_000_000_000;
const PV = 'TEST:PV';

const notFound = () =>
  new CanopyError('pv_not_found_in_archiver', 404, `PV '${PV}' not in archiver 'test' (HTTP 404)`);
const unavailable = () =>
  new CanopyError('archiver_unavailable', 503, 'Appliance returned HTTP 503');

function rawDto(params: FetchDataParams): ArchiverDataDTO {
  return {
    mode: 'raw',
    pv: PV,
    archiver: 'test',
    from: params.fromNs,
    to: params.toNs ?? params.fromNs,
    decimated: false,
    samples: [
      { tsNs: params.fromNs, value: 1, severity: 'NO_ALARM', source: 'archive' },
      { tsNs: params.toNs ?? params.fromNs, value: 2, severity: 'NO_ALARM', source: 'archive' },
    ],
  };
}

type Impl = (pv: string, params: FetchDataParams, signal?: AbortSignal) => Promise<ArchiverDataDTO>;

function setup(impl: Impl) {
  // Retries are scheduled with setTimeout. Fake it and advance it in lockstep
  // with the injected clock.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let nowMs = T0_MS;
  const fetchData = vi.fn(impl);
  const store = new ArchiveStore({ fetchData: fetchData as FetchDataFn, now: () => nowMs });
  // Status of each trace at every publish, to catch flicker back to 'loading'.
  const published: Record<string, string[]> = {};
  store.subscribe(() => {
    for (const [id, entry] of store.getSnapshot()) (published[id] ??= []).push(entry.status);
  });
  return {
    store,
    fetchData,
    published,
    now: () => nowMs,
    advance: (ms: number) => {
      nowMs += ms;
      vi.advanceTimersByTime(ms);
    },
  };
}

// Each test builds its own store; drop its pending retries so none fires in
// the next test.
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

type Harness = ReturnType<typeof setup>;

function windowAt(nowMs: number, spanS: number): TimeWindowNs {
  const toNs = nowMs * 1e6;
  return { fromNs: toNs - spanS * 1e9, toNs };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

interface DriftOpts {
  traceId?: string;
  pv?: string;
  archiver?: string;
  spanS: number;
  stepMs?: number;
  steps: number;
  // Hold the window still (a plot whose range doesn't track now) while the
  // clock advances, as when another plot's drift re-runs useArchiveSeries.
  staticWindow?: TimeWindowNs;
}

async function drift(h: Harness, o: DriftOpts): Promise<void> {
  for (let i = 0; i < o.steps; i++) {
    h.store.request(o.traceId ?? 't1', {
      pv: o.pv ?? PV,
      archiver: o.archiver,
      window: o.staticWindow ?? windowAt(h.now(), o.spanS),
    });
    await flush();
    h.advance(o.stepMs ?? 100);
  }
}

// Let the clock run with no further request(): a plot whose range doesn't
// move, with nothing else re-running useArchiveSeries.
async function idle(h: Harness, ms: number, stepMs = 100): Promise<void> {
  for (let t = 0; t < ms; t += stepMs) {
    await flush();
    h.advance(stepMs);
  }
  await flush();
}

function loadingAfterFirstError(statuses: string[] = []): number {
  const first = statuses.indexOf('error');
  return first < 0 ? 0 : statuses.slice(first).filter((s) => s === 'loading').length;
}

describe('archiveStore: PV not in the archiver', () => {
  for (const spanS of [10, 30, 3600]) {
    it(`fetches once for a ${spanS}s window while now advances for 60s`, async () => {
      const h = setup(async () => {
        throw notFound();
      });
      await drift(h, { spanS, steps: 600 });

      expect(h.fetchData).toHaveBeenCalledTimes(1);
      const entry = h.store.getSnapshot().get('t1')!;
      expect(entry.status).toBe('error');
      expect(entry.error?.code).toBe('pv_not_found_in_archiver');
      expect(loadingAfterFirstError(h.published.t1)).toBe(0);
      // Only the initial loading → error transition is published.
      expect(h.published.t1).toEqual(['loading', 'error']);
    });
  }

  it('stays put through bins changes and asks again once when the span changes', async () => {
    const h = setup(async () => {
      throw notFound();
    });
    await drift(h, { spanS: 30, steps: 50 });
    // Different bins: same verdict, no fetch.
    h.store.request('t1', {
      pv: PV,
      archiver: undefined,
      bins: 100,
      window: windowAt(h.now(), 30),
    });
    await flush();
    expect(h.fetchData).toHaveBeenCalledTimes(1);

    // New range: 30 s → 1 h (also raw → binned). One more question, then sticky.
    await drift(h, { spanS: 3600, steps: 300 });
    expect(h.fetchData).toHaveBeenCalledTimes(2);
    expect(h.fetchData.mock.calls[1][1]).toMatchObject({ binning: 'auto' });
    expect(loadingAfterFirstError(h.published.t1)).toBe(0);
  });

  it('asks again for a new pv or archiver', async () => {
    const h = setup(async () => {
      throw notFound();
    });
    await drift(h, { spanS: 30, steps: 20 });
    await drift(h, { spanS: 30, steps: 20, pv: 'OTHER:PV' });
    expect(h.fetchData).toHaveBeenCalledTimes(2);
    await drift(h, { spanS: 30, steps: 20, pv: 'OTHER:PV', archiver: 'other' });
    expect(h.fetchData).toHaveBeenCalledTimes(3);
    expect(h.fetchData.mock.calls.map((c) => [c[0], c[1].archiver])).toEqual([
      [PV, undefined],
      ['OTHER:PV', undefined],
      ['OTHER:PV', 'other'],
    ]);
  });

  it('shares the verdict with other traces and survives release()', async () => {
    const h = setup(async () => {
      throw notFound();
    });
    await drift(h, { spanS: 30, steps: 20 });
    // Same PV on a second trace, and the first trace removed and re-added.
    await drift(h, { spanS: 30, steps: 20, traceId: 't2' });
    h.store.release('t1');
    await drift(h, { spanS: 30, steps: 20 });

    expect(h.fetchData).toHaveBeenCalledTimes(1);
    expect(h.store.getSnapshot().get('t1')?.status).toBe('error');
    expect(h.store.getSnapshot().get('t2')?.error?.code).toBe('pv_not_found_in_archiver');
    expect(h.published.t2).not.toContain('loading');
  });

  it('adopts a verdict learned elsewhere (Data Insight Tool) without its own 404', async () => {
    let fail = false;
    const h = setup(async (_pv, params) => {
      if (fail) throw notFound();
      return { ...rawDto(params), samples: [] };
    });
    // Archived-but-empty first answer, so the entry has no buffer to cover with.
    await drift(h, { spanS: 30, steps: 1 });
    expect(h.fetchData).toHaveBeenCalledTimes(1);
    fail = true;

    const listener = vi.fn();
    h.store.subscribe(listener);
    h.store.markNotArchived(PV, undefined, notFound());
    h.store.markNotArchived(PV, undefined, notFound()); // idempotent: no second publish
    h.store.forgetNotArchived('NEVER:MARKED', undefined); // absent: no publish
    expect(listener).toHaveBeenCalledTimes(1);

    await drift(h, { spanS: 30, steps: 100 });
    expect(h.fetchData).toHaveBeenCalledTimes(1);
    expect(h.store.getSnapshot().get('t1')?.status).toBe('error');
  });

  it('refetchAll() asks again with the current window, then stays sticky', async () => {
    const h = setup(async () => {
      throw notFound();
    });
    await drift(h, { spanS: 30, steps: 100 });
    h.store.refetchAll();
    await flush();
    expect(h.fetchData).toHaveBeenCalledTimes(2);
    // The latest wanted window, not the one from the first request 10 s ago.
    const toNs = h.fetchData.mock.calls[1][1].toNs!;
    expect(Math.abs(toNs - (h.now() - 100) * 1e6)).toBeLessThan(1e6);
    // A manual refresh shows loading → error once.
    expect(h.published.t1.slice(-2)).toEqual(['loading', 'error']);

    await drift(h, { spanS: 30, steps: 100 });
    expect(h.fetchData).toHaveBeenCalledTimes(2);
  });

  it('asks again after forgetNotArchived() (Data Insight Tool refresh)', async () => {
    const h = setup(async () => {
      throw notFound();
    });
    await drift(h, { spanS: 30, steps: 20 });
    h.store.forgetNotArchived(PV, undefined);
    await drift(h, { spanS: 30, steps: 20 });
    expect(h.fetchData).toHaveBeenCalledTimes(2);
    expect(loadingAfterFirstError(h.published.t1)).toBe(0);
  });

  it('does not ping-pong between two plots with different spans', async () => {
    const h = setup(async () => {
      throw notFound();
    });
    for (let i = 0; i < 200; i++) {
      h.store.request('hour', { pv: PV, archiver: undefined, window: windowAt(h.now(), 3600) });
      h.store.request('tenMin', { pv: PV, archiver: undefined, window: windowAt(h.now(), 600) });
      await flush();
      h.advance(100);
    }
    // Both ask in the first render (neither answer is back yet), then never again.
    expect(h.fetchData).toHaveBeenCalledTimes(2);
  });

  it('dedupes a StrictMode-style double request', async () => {
    const h = setup(async () => {
      throw notFound();
    });
    const window = windowAt(h.now(), 30);
    h.store.request('t1', { pv: PV, archiver: undefined, window });
    h.store.request('t1', { pv: PV, archiver: undefined, window });
    await flush();
    expect(h.fetchData).toHaveBeenCalledTimes(1);
  });

  it('a later success clears the verdict', async () => {
    let archived = false;
    const h = setup(async (_pv, params) => {
      if (!archived) throw notFound();
      return rawDto(params);
    });
    await drift(h, { spanS: 30, steps: 10 });
    archived = true;
    h.store.refetchAll();
    await flush();
    expect(h.store.getSnapshot().get('t1')?.status).toBe('ready');
    expect(h.store.getNotArchived(PV, undefined)).toBeUndefined();
  });

  it('keeps retrying when the re-ask after a span change fails transiently', async () => {
    let answer: 'notFound' | 'unavailable' = 'notFound';
    const h = setup(async () => {
      throw answer === 'notFound' ? notFound() : unavailable();
    });
    await drift(h, { spanS: 30, steps: 10 });
    expect(h.fetchData).toHaveBeenCalledTimes(1);

    // New range at 1 s: the re-ask gets a 503. That isn't an answer, so it
    // backs off (2 s, 4 s) instead of falling back on the older verdict.
    answer = 'unavailable';
    await drift(h, { spanS: 3600, steps: 40 });
    expect(h.fetchData).toHaveBeenCalledTimes(4);
    expect(h.store.getSnapshot().get('t1')?.error?.code).toBe('archiver_unavailable');
    // The shared verdict stands meanwhile, for other traces and the Data Insight Tool.
    expect(h.store.getNotArchived(PV, undefined)).toBeDefined();

    // The archiver answers at 8 s: sticky again.
    answer = 'notFound';
    await drift(h, { spanS: 3600, steps: 600 });
    expect(h.fetchData).toHaveBeenCalledTimes(5);
    expect(h.store.getSnapshot().get('t1')?.error?.code).toBe('pv_not_found_in_archiver');
  });

  it('adopts a verdict learned elsewhere over its own earlier 503', async () => {
    const h = setup(async () => {
      throw unavailable();
    });
    await drift(h, { spanS: 30, steps: 5 });
    h.store.markNotArchived(PV, undefined, notFound());
    await drift(h, { spanS: 30, steps: 600 });
    expect(h.fetchData).toHaveBeenCalledTimes(1);
    expect(h.store.getSnapshot().get('t1')?.error?.code).toBe('pv_not_found_in_archiver');
  });
});

describe('archiveStore: other failures back off', () => {
  async function failureTimes(
    error: () => Error,
    o: { spanS: number; staticWindow?: boolean }
  ): Promise<{ h: Harness; times: number[] }> {
    const times: number[] = [];
    const h: Harness = setup(async () => {
      times.push((h.now() - T0_MS) / 1000);
      throw error();
    });
    await drift(h, {
      spanS: o.spanS,
      steps: 600,
      staticWindow: o.staticWindow ? windowAt(T0_MS, o.spanS) : undefined,
    });
    return { h, times };
  }

  // Over 60 s, counting the retry the clock reaches at the end.
  const SCHEDULE = [0, 1, 3, 7, 15, 30, 45, 60];

  it('retries a 503 on the backoff schedule, not on window drift', async () => {
    const { h, times } = await failureTimes(unavailable, { spanS: 30 });
    expect(times).toEqual(SCHEDULE);
    expect(h.store.getSnapshot().get('t1')?.error?.code).toBe('archiver_unavailable');
    expect(loadingAfterFirstError(h.published.t1)).toBe(0);
  });

  it('retries a network error on the same schedule', async () => {
    const { times } = await failureTimes(
      () => new CanopyError('network_error', 0, 'Failed to fetch'),
      { spanS: 10 }
    );
    expect(times).toEqual(SCHEDULE);
  });

  it('retries a static window too (not blocked by the same-window dedup)', async () => {
    const { times } = await failureTimes(unavailable, { spanS: 3600, staticWindow: true });
    expect(times).toEqual(SCHEDULE);
  });

  it('retries a fixed window on its own when the backoff expires', async () => {
    const times: number[] = [];
    const h: Harness = setup(async () => {
      times.push((h.now() - T0_MS) / 1000);
      throw unavailable();
    });
    h.store.request('t1', { pv: PV, archiver: undefined, window: windowAt(T0_MS, 3600) });
    await idle(h, 60_000);
    expect(times).toEqual(SCHEDULE);
    expect(loadingAfterFirstError(h.published.t1)).toBe(0);
  });

  it('retries the latest window, not the one that failed', async () => {
    const h = setup(async () => {
      throw unavailable();
    });
    const pastToMs = T0_MS - 3_600_000;
    h.store.request('t1', { pv: PV, archiver: undefined, window: windowAt(pastToMs, 30) });
    await idle(h, 500);
    // Panned during the backoff: nothing fetched until it expires.
    const panned = windowAt(pastToMs + 60_000, 30);
    h.store.request('t1', { pv: PV, archiver: undefined, window: panned });
    await flush();
    expect(h.fetchData).toHaveBeenCalledTimes(1);
    await idle(h, 600);
    expect(h.fetchData).toHaveBeenCalledTimes(2);
    expect(h.fetchData.mock.calls[1][1]).toMatchObject({
      fromNs: panned.fromNs,
      toNs: panned.toNs,
    });
  });

  it('drops a scheduled retry on release() and refetchAll()', async () => {
    const times: number[] = [];
    const h: Harness = setup(async () => {
      times.push((h.now() - T0_MS) / 1000);
      throw unavailable();
    });
    h.store.request('t1', { pv: PV, archiver: undefined, window: windowAt(T0_MS, 30) });
    h.store.request('t2', { pv: PV, archiver: undefined, window: windowAt(T0_MS, 30) });
    await flush();
    h.store.release('t1');
    await idle(h, 500);
    h.store.refetchAll();
    await idle(h, 1_200);
    // t1 and t2 at 0; t2 again on refetchAll() at 0.5 s, then 1 s after that
    // failure. Neither 0 s failure retries at 1 s.
    expect(times).toEqual([0, 0, 0.5, 1.5]);
  });

  it('recovers when the archiver comes back, and resets the backoff', async () => {
    let up = false;
    let failures = 0;
    const h = setup(async (_pv, params) => {
      if (!up) {
        failures++;
        throw unavailable();
      }
      return rawDto(params);
    });
    await drift(h, { spanS: 30, steps: 80 }); // fails at 0, 1, 3, 7 s
    expect(failures).toBe(4);
    up = true;
    await drift(h, { spanS: 30, steps: 80 }); // retry at 15 s succeeds
    expect(h.store.getSnapshot().get('t1')?.status).toBe('ready');

    // The next failure (once drift uncovers the window) backs off from the
    // first step again: two attempts within 3 s, not one per 15 s.
    up = false;
    failures = 0;
    await drift(h, { spanS: 30, steps: 30 });
    expect(failures).toBe(2);
  });

  it('ignores a fetch that resolves after release()', async () => {
    let resolve!: (dto: ArchiverDataDTO) => void;
    const h = setup(
      (_pv, params) =>
        new Promise((r) => {
          resolve = () => r(rawDto(params));
        })
    );
    h.store.request('t1', { pv: PV, archiver: undefined, window: windowAt(h.now(), 30) });
    h.store.release('t1');
    const listener = vi.fn();
    h.store.subscribe(listener);
    resolve(rawDto({ fromNs: 0 }));
    await flush();
    expect(h.store.getSnapshot().has('t1')).toBe(false);
    expect(listener).not.toHaveBeenCalled();
  });
});

// Archived PVs as "now" advances (#93 "Additional context", and #94's
// seconds-scale strip-tool windows): fetch only the new tail, at most every
// DRIFT_MIN_INTERVAL_MS, without aborting in-flight requests.
describe('archiveStore: archived PV while the window tracks now', () => {
  // One sample per whole second in the requested range, value = epoch second.
  function secondsDto(params: FetchDataParams, decimated = false): ArchiverDataDTO {
    const toNs = params.toNs ?? params.fromNs;
    const samples = [];
    for (let s = Math.ceil(params.fromNs / 1e9); s * 1e9 <= toNs; s++) {
      samples.push({
        tsNs: s * 1e9,
        value: s,
        severity: 'NO_ALARM' as const,
        source: 'archive' as const,
      });
    }
    return {
      mode: 'raw',
      pv: PV,
      archiver: 'test',
      from: params.fromNs,
      to: toNs,
      decimated,
      samples,
    };
  }

  const spanOf = (p: FetchDataParams) => ((p.toNs ?? p.fromNs) - p.fromNs) / 1e9;

  for (const spanS of [10, 30]) {
    it(`${spanS}s span: fetches the tail every ~2 s and keeps a clean buffer`, async () => {
      const h = setup(async (_pv, params) => secondsDto(params));
      await drift(h, { spanS, steps: 600 });

      const calls = h.fetchData.mock.calls.map((c) => c[1]);
      expect(calls.length).toBeGreaterThan(20);
      expect(calls.length).toBeLessThanOrEqual(31);
      expect(spanOf(calls[0])).toBe(spanS);
      // Later requests are the new part plus TAIL_OVERLAP_MS, never more than the window.
      for (const p of calls.slice(1)) expect(spanOf(p)).toBeLessThanOrEqual(Math.min(spanS, 12.2));

      const entry = h.store.getSnapshot().get('t1')!;
      expect(entry.status).toBe('ready');
      // Sorted, no duplicates, one point per second, trimmed to the window.
      const times = entry.mean.map((p) => p.time);
      expect(times.slice(1).every((t, i) => t - times[i] === 1000)).toBe(true);
      expect(times[0]).toBeGreaterThanOrEqual(h.now() - 100 - spanS * 1000 - 2100);
      // Background refreshes never flip back to 'loading'.
      expect(h.published.t1.filter((st) => st === 'loading')).toHaveLength(1);
    });
  }

  it('20 min raw span: tail requests are seconds long, not 20 minutes', async () => {
    const h = setup(async (_pv, params) => secondsDto(params));
    await drift(h, { spanS: 1200, steps: 600 });
    const spans = h.fetchData.mock.calls.map((c) => spanOf(c[1]));
    expect(spans[0]).toBe(1200);
    expect(spans.length).toBeGreaterThan(2);
    // Slack is 1% of the span (12 s) here, plus the 10 s overlap.
    for (const s of spans.slice(1)) expect(s).toBeLessThan(23);
  });

  it('lets a slow fetch finish instead of aborting it on every advance', async () => {
    const signals: AbortSignal[] = [];
    let resolve!: () => void;
    const h = setup(
      (_pv, params, signal) =>
        new Promise((r) => {
          signals.push(signal!);
          resolve = () => r(secondsDto(params));
        })
    );
    // 10 s span, a request every 16 ms (rAF-rate scrolling), answer after 400 ms.
    await drift(h, { spanS: 10, stepMs: 16, steps: 25 });
    expect(h.fetchData).toHaveBeenCalledTimes(1);
    resolve();
    await flush();
    expect(signals[0].aborted).toBe(false);
    expect(h.store.getSnapshot().get('t1')?.status).toBe('ready');
  });

  it('treats an empty answer as covered (quiet PV), not as missing', async () => {
    const h = setup(async (_pv, params) => ({ ...secondsDto(params), samples: [] }));
    await drift(h, { spanS: 30, steps: 600 });
    expect(h.fetchData.mock.calls.length).toBeLessThanOrEqual(31);
    expect(h.store.getSnapshot().get('t1')?.status).toBe('ready');
  });

  it('fills a small forward pan of a historical window right away', async () => {
    const h = setup(async (_pv, params) => secondsDto(params));
    const pastToMs = T0_MS - 3_600_000;
    h.store.request('t1', { pv: PV, archiver: undefined, window: windowAt(pastToMs, 30) });
    await flush();
    h.store.request('t1', { pv: PV, archiver: undefined, window: windowAt(pastToMs + 1000, 30) });
    await flush();
    expect(h.fetchData).toHaveBeenCalledTimes(2);
    // Only the new second plus the overlap.
    expect(spanOf(h.fetchData.mock.calls[1][1])).toBeCloseTo(11, 3);
  });

  for (const panS of [10, 60]) {
    it(`fetches a historical window panned ${panS} s forward during a fetch`, async () => {
      const pending: (() => void)[] = [];
      const h = setup(
        (_pv, params) => new Promise((r) => pending.push(() => r(secondsDto(params))))
      );
      const pastToMs = T0_MS - 3_600_000;
      const panned = windowAt(pastToMs + panS * 1000, 30);
      h.store.request('t1', { pv: PV, archiver: undefined, window: windowAt(pastToMs, 30) });
      await flush();
      h.store.request('t1', { pv: PV, archiver: undefined, window: panned });
      await flush();
      // The pending fetch isn't aborted for a forward move...
      expect(h.fetchData).toHaveBeenCalledTimes(1);
      pending[0]();
      await flush();
      // ...and once it lands, the rest of the new window is fetched without
      // another request().
      expect(h.fetchData).toHaveBeenCalledTimes(2);
      expect(h.fetchData.mock.calls[1][1].toNs).toBe(panned.toNs);
      pending[1]();
      await flush();

      const entry = h.store.getSnapshot().get('t1')!;
      expect(entry.status).toBe('ready');
      expect(entry.mean[0].time).toBe(panned.fromNs / 1e6);
      expect(entry.mean[entry.mean.length - 1].time).toBe(panned.toNs / 1e6);
    });
  }

  it('refetches the whole window when tails would pass the raw point budget', async () => {
    // Quiet for the first fetch, then 200 Hz. Like the archiver, answer with at
    // most maxPoints samples, flagged decimated when there were more.
    const busyFromMs = T0_MS + 1_000;
    const h = setup(async (_pv, params) => {
      const first = Math.max(0, Math.ceil((params.fromNs / 1e6 - busyFromMs) / 5));
      const last = Math.floor(((params.toNs ?? params.fromNs) / 1e6 - busyFromMs) / 5);
      const stride = Math.max(1, Math.ceil((last - first + 1) / (params.maxPoints ?? Infinity)));
      const samples = [];
      for (let k = first; k <= last; k += stride) {
        samples.push({
          tsNs: (busyFromMs + 5 * k) * 1e6,
          value: k,
          severity: 'NO_ALARM' as const,
          source: 'archive' as const,
        });
      }
      return { ...secondsDto(params), decimated: stride > 1, samples };
    });
    let maxBuffered = 0;
    h.store.subscribe(() => {
      const n = h.store.getSnapshot().get('t1')?.mean.length ?? 0;
      maxBuffered = Math.max(maxBuffered, n);
    });

    await drift(h, { spanS: 1200, stepMs: 200, steps: 450 });
    const spans = h.fetchData.mock.calls.map((c) => spanOf(c[1]));
    expect(spans[0]).toBe(1200);
    // Tails while the buffer fits, then the whole window once it wouldn't.
    expect(spans[1]).toBeLessThan(1200);
    expect(spans.slice(2)).toContain(1200);
    expect(maxBuffered).toBeLessThanOrEqual(8000);
    expect(h.store.getSnapshot().get('t1')?.decimated).toBe(true);
  });

  it('binned (1 h): full-window refetch only after 1% of the span', async () => {
    const h = setup(async (_pv, params) => ({
      mode: 'binned',
      pv: PV,
      archiver: 'test',
      from: params.fromNs,
      to: params.toNs ?? params.fromNs,
      binning: 'auto',
      binSizeNs: null,
      targetBuckets: 5000,
      points: [
        {
          tsNs: params.fromNs,
          binNs: 1e9,
          mean: 1,
          stdDev: 0,
          min: 1,
          max: 1,
          count: 1,
          severity: 'NO_ALARM',
        },
      ],
    }));
    await drift(h, { spanS: 3600, steps: 600 });
    const spans = h.fetchData.mock.calls.map((c) => spanOf(c[1]));
    expect(spans).toEqual([3600, 3600]);
    expect(h.published.t1.filter((st) => st === 'loading')).toHaveLength(1);
  });

  it('a decimated buffer is refetched whole', async () => {
    const h = setup(async (_pv, params) => secondsDto(params, true));
    await drift(h, { spanS: 30, steps: 100 });
    const spans = h.fetchData.mock.calls.map((c) => spanOf(c[1]));
    expect(spans.length).toBeGreaterThan(1);
    expect(spans.every((s) => s === 30)).toBe(true);
  });
});

// #121: a zoom into a binned buffer used to keep drawing the bins fetched for
// the whole range, since the fetch signature holds the bin count, not the bin
// width. Windows here stay over 30 min, so the raw/binned flip isn't what
// triggers the refetch.
describe('archiveStore: zooming into a binned buffer', () => {
  // Ten evenly spaced bins over the requested range, mean = bin index.
  function binnedDto(params: FetchDataParams): ArchiverDataDTO {
    const toNs = params.toNs ?? params.fromNs;
    const binNs = (toNs - params.fromNs) / 10;
    return {
      mode: 'binned',
      pv: PV,
      archiver: 'lcls',
      from: params.fromNs,
      to: toNs,
      binning: 'auto',
      binSizeNs: null,
      targetBuckets: params.maxPoints ?? null,
      points: Array.from({ length: 10 }, (_, i) => ({
        tsNs: params.fromNs + i * binNs,
        binNs,
        mean: i,
        stdDev: 0,
        min: i,
        max: i,
        count: 1,
        severity: 'NO_ALARM' as const,
      })),
    };
  }

  const DAY_S = 86_400;
  // The last `spanS` of `win`, as a wheel zoom anchored at the right edge.
  const zoomTo = (win: TimeWindowNs, spanS: number): TimeWindowNs => ({
    fromNs: win.toNs - spanS * 1e9,
    toNs: win.toNs,
  });
  const ask = (h: Harness, window: TimeWindowNs) =>
    h.store.request('t1', { pv: PV, archiver: undefined, window });

  it('fetches finer bins for a 40 min zoom, keeping the coarse line until they land', async () => {
    let resolveZoom!: () => void;
    const h: Harness = setup((_pv, params) => {
      if (h.fetchData.mock.calls.length === 1) return Promise.resolve(binnedDto(params));
      return new Promise((r) => {
        resolveZoom = () => r(binnedDto(params));
      });
    });
    const day = windowAt(h.now(), DAY_S);
    ask(h, day);
    await flush();
    const coarse = h.store.getSnapshot().get('t1')!.mean;

    const zoom = zoomTo(day, 40 * 60);
    ask(h, zoom);
    ask(h, zoom); // re-render while the zoom fetch is in flight
    await flush();
    expect(h.fetchData).toHaveBeenCalledTimes(2);
    expect(h.fetchData.mock.calls[1][1]).toMatchObject({
      fromNs: zoom.fromNs,
      toNs: zoom.toNs,
      binning: 'auto',
      maxPoints: DEFAULT_OPTIMIZED_BINS,
    });
    // Coarse buffer still on screen, and no 'loading' blink.
    expect(h.store.getSnapshot().get('t1')!.mean).toBe(coarse);
    expect(h.store.getSnapshot().get('t1')!.status).toBe('ready');

    resolveZoom();
    await flush();
    const entry = h.store.getSnapshot().get('t1')!;
    expect(entry.mean[0].time).toBe(zoom.fromNs / 1e6);
    expect(entry.coverFromNs).toBe(zoom.fromNs);
    expect(h.published.t1.filter((st) => st === 'loading')).toHaveLength(1);

    // Settled: re-renders of the zoomed window are free.
    ask(h, zoom);
    await flush();
    expect(h.fetchData).toHaveBeenCalledTimes(2);
  });

  it('a zoom to more than half the fetched span stays on the buffer', async () => {
    const h = setup(async (_pv, params) => binnedDto(params));
    const day = windowAt(h.now(), DAY_S);
    ask(h, day);
    await flush();
    ask(h, zoomTo(day, 20 * 3600));
    await flush();
    expect(h.fetchData).toHaveBeenCalledTimes(1);
    ask(h, zoomTo(day, 11 * 3600));
    await flush();
    expect(h.fetchData).toHaveBeenCalledTimes(2);
  });

  it('a gradual zoom refetches once per halving of the span, not per step', async () => {
    const h = setup(async (_pv, params) => binnedDto(params));
    const day = windowAt(h.now(), DAY_S);
    let spanS = DAY_S;
    // 30 settled zoom steps of 10% each: 1 day down to about 1 h.
    for (let i = 0; i <= 30; i++) {
      ask(h, zoomTo(day, spanS));
      await flush();
      spanS *= 0.9;
    }
    // The first fetch, then one at every 7th step (0.9^7 < 0.5 < 0.9^6).
    expect(h.fetchData).toHaveBeenCalledTimes(5);
  });

  it('after a zoom refetch, a pan or a zoom back out fetches its own window', async () => {
    const h = setup(async (_pv, params) => binnedDto(params));
    const day = windowAt(h.now(), DAY_S);
    ask(h, day);
    await flush();
    const zoom = zoomTo(day, 40 * 60);
    ask(h, zoom);
    await flush();
    // The buffer now holds only the zoomed window, at its own resolution.
    const panned = { fromNs: zoom.fromNs - 600e9, toNs: zoom.toNs - 600e9 };
    ask(h, panned);
    await flush();
    ask(h, day);
    await flush();
    expect(h.fetchData.mock.calls.map((c) => [c[1].fromNs, c[1].toNs])).toEqual([
      [day.fromNs, day.toNs],
      [zoom.fromNs, zoom.toNs],
      [panned.fromNs, panned.toNs],
      [day.fromNs, day.toNs],
    ]);
  });
});
