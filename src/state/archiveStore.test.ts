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

  it('drops the backoff once the window is back on the buffer', async () => {
    const pastToMs = T0_MS - 3_600_000;
    const covered = windowAt(pastToMs, 30);
    const failing = windowAt(pastToMs + 600_000, 30);
    const h = setup(async (_pv, params) => {
      if (params.fromNs === failing.fromNs) throw unavailable();
      return rawDto(params);
    });
    h.store.request('t1', { pv: PV, archiver: undefined, window: covered });
    await flush();
    h.store.request('t1', { pv: PV, archiver: undefined, window: failing });
    await flush();
    expect(h.store.getSnapshot().get('t1')?.status).toBe('error');
    // Back on the buffer: shown as ready, and the 503 no longer applies.
    h.store.request('t1', { pv: PV, archiver: undefined, window: covered });
    await flush();
    expect(h.store.getSnapshot().get('t1')?.status).toBe('ready');
    // A new window inside the old backoff is fetched right away.
    const fresh = windowAt(pastToMs - 600_000, 30);
    h.store.request('t1', { pv: PV, archiver: undefined, window: fresh });
    await flush();
    expect(h.fetchData).toHaveBeenCalledTimes(3);
    expect(h.fetchData.mock.calls[2][1]).toMatchObject({ fromNs: fresh.fromNs, toNs: fresh.toNs });
    expect(h.store.getSnapshot().get('t1')?.status).toBe('ready');
  });

  it('fetches the window that failed when it is asked for again after that', async () => {
    const pastToMs = T0_MS - 3_600_000;
    const covered = windowAt(pastToMs, 30);
    const failing = windowAt(pastToMs + 600_000, 30);
    const h: Harness = setup(async (_pv, params) => {
      if (h.fetchData.mock.calls.length === 2) throw unavailable();
      return rawDto(params);
    });
    h.store.request('t1', { pv: PV, archiver: undefined, window: covered });
    await flush();
    h.store.request('t1', { pv: PV, archiver: undefined, window: failing });
    await flush();
    h.store.request('t1', { pv: PV, archiver: undefined, window: covered });
    await flush();
    // Back to the window that failed, with its backoff dropped: fetched now,
    // not skipped as already asked for.
    h.store.request('t1', { pv: PV, archiver: undefined, window: failing });
    await flush();
    expect(h.fetchData).toHaveBeenCalledTimes(3);
    expect(h.fetchData.mock.calls[2][1]).toMatchObject({
      fromNs: failing.fromNs,
      toNs: failing.toNs,
    });
    const entry = h.store.getSnapshot().get('t1')!;
    expect(entry.status).toBe('ready');
    expect(entry.coverFromNs).toBe(failing.fromNs);
  });

  it('keeps a retry in flight whose answer covers the window it is back on', async () => {
    const pastToMs = T0_MS - 3_600_000;
    const here = windowAt(pastToMs, 600);
    // Zoomed out around `here`: the same raw mode, twice the span.
    const wide = { fromNs: here.fromNs - 300e9, toNs: here.toNs + 300e9 };
    let release!: () => void;
    const h: Harness = setup((_pv, params) => {
      const call = h.fetchData.mock.calls.length;
      if (call === 2) return Promise.reject(unavailable());
      if (call === 3) {
        return new Promise((r) => {
          release = () => r(rawDto(params));
        });
      }
      return Promise.resolve(rawDto(params));
    });
    h.store.request('t1', { pv: PV, archiver: undefined, window: here });
    await flush();
    h.store.request('t1', { pv: PV, archiver: undefined, window: wide });
    await flush();
    // The backoff expires and the timer retries `wide`, still in flight.
    await idle(h, 1_000);
    expect(h.fetchData).toHaveBeenCalledTimes(3);
    // Zoom back in, then out again before the retry answers.
    h.store.request('t1', { pv: PV, archiver: undefined, window: here });
    await flush();
    h.store.request('t1', { pv: PV, archiver: undefined, window: wide });
    await flush();
    expect(h.fetchData.mock.calls[2][2]?.aborted).toBe(false);
    expect(h.fetchData).toHaveBeenCalledTimes(3);
    release();
    await flush();
    const entry = h.store.getSnapshot().get('t1')!;
    expect(entry.status).toBe('ready');
    expect(entry.coverFromNs).toBe(wide.fromNs);
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

// #122: Mole thins a raw answer over maxPoints by keeping the sample nearest
// each of maxPoints evenly spaced times, which drops spikes between them. A
// decimated raw answer is re-requested binned, whose min/max band keeps them.

// A PV whose raw answers come back decimated for windows longer than
// `rawCapS`. Binned requests get ten bins over the window.
function decimatingFetch(rawCapS: number): Impl {
  return async (_pv, params) => {
    const toNs = params.toNs ?? params.fromNs;
    if (!params.binning) {
      return { ...rawDto(params), decimated: toNs - params.fromNs > rawCapS * 1e9 };
    }
    const binNs = (toNs - params.fromNs) / 10;
    return {
      mode: 'binned',
      pv: PV,
      archiver: 'test',
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
        min: i - 1,
        max: i + 1,
        count: 1,
        severity: 'NO_ALARM' as const,
      })),
    };
  };
}

describe('archiveStore: decimated raw answers', () => {
  const RAW_CAP_S = 15 * 60;
  const modes = (h: Harness) => h.fetchData.mock.calls.map((c) => c[1].binning ?? 'raw');
  const ask = (h: Harness, window: TimeWindowNs, o: { pv?: string; bins?: number } = {}) =>
    h.store.request('t1', { pv: o.pv ?? PV, archiver: undefined, bins: o.bins, window });

  it('re-requests a decimated 30 min window binned, and stays binned as now advances', async () => {
    const h = setup(decimatingFetch(RAW_CAP_S));
    const thinnedShown: boolean[] = [];
    h.store.subscribe(() => thinnedShown.push(!!h.store.getSnapshot().get('t1')?.decimated));
    await drift(h, { spanS: 30 * 60, steps: 600 });

    // One raw request, then bins for the same window, then a full binned
    // refetch whenever the window drifts 1% (18 s) past the buffer.
    expect(modes(h)).toEqual(['raw', 'auto', 'auto', 'auto', 'auto']);
    const [first, second] = h.fetchData.mock.calls.map((c) => c[1]);
    expect(second).toMatchObject({
      fromNs: first.fromNs,
      toNs: first.toNs,
      maxPoints: DEFAULT_OPTIMIZED_BINS,
    });
    const entry = h.store.getSnapshot().get('t1')!;
    expect(entry).toMatchObject({ status: 'ready', mode: 'binned', decimated: false });
    expect(entry.band).toHaveLength(10);
    // The thinned raw samples are never put on screen.
    expect(thinnedShown).not.toContain(true);
    expect(h.published.t1).not.toContain('error');
  });

  it('only a shorter window tries raw again', async () => {
    const h = setup(decimatingFetch(RAW_CAP_S));
    const toNs = windowAt(h.now(), 0).toNs;
    const last = (spanS: number): TimeWindowNs => ({ fromNs: toNs - spanS * 1e9, toNs });
    for (const spanS of [1800, 1200, 1500, 600, 1194]) {
      ask(h, last(spanS));
      await flush();
    }
    expect(modes(h)).toEqual([
      'raw', // 30 min: decimated,
      'auto', // so bins.
      'raw', // 20 min, shorter: decimated again,
      'auto', // so bins.
      'auto', // 25 min, longer than 20: bins straight away.
      'raw', // 10 min: not decimated, kept.
      'auto', // 19.9 min: within 1% of 20 min, so bins straight away.
    ]);
  });

  it('remembers it per pv: other traces, release() and refetchAll() go straight to bins', async () => {
    const h = setup(decimatingFetch(RAW_CAP_S));
    const win = windowAt(h.now(), 30 * 60);
    ask(h, win, { bins: 2000 });
    await flush();
    // Same PV on another trace, then this trace removed and re-added.
    h.store.request('t2', { pv: PV, archiver: undefined, window: win });
    h.store.release('t1');
    ask(h, win);
    await flush();
    h.store.refetchAll();
    await flush();
    // A different PV starts over with raw.
    h.store.request('t3', { pv: 'OTHER:PV', archiver: undefined, window: win });
    await flush();
    expect(modes(h)).toEqual(['raw', 'auto', 'auto', 'auto', 'auto', 'auto', 'raw', 'auto']);
    // The trace's own bin count is used for the binned request.
    expect(h.fetchData.mock.calls[1][1].maxPoints).toBe(2000);
  });

  it('a decimated tail switches the window to bins too', async () => {
    // The window's first answer fits; later ones (the tails) come back decimated.
    const fits = decimatingFetch(Infinity);
    const dense = decimatingFetch(0);
    const h: Harness = setup((pv, params, signal) =>
      (h.fetchData.mock.calls.length === 1 ? fits : dense)(pv, params, signal)
    );
    const thinnedShown: boolean[] = [];
    h.store.subscribe(() => thinnedShown.push(!!h.store.getSnapshot().get('t1')?.decimated));
    await drift(h, { spanS: 30, steps: 50 });
    const calls = h.fetchData.mock.calls.map((c) => c[1]);
    expect(modes(h).slice(0, 3)).toEqual(['raw', 'raw', 'auto']);
    // The second request was a tail; the binned one is the whole window.
    expect((calls[1].toNs! - calls[1].fromNs) / 1e9).toBeLessThan(30);
    expect((calls[2].toNs! - calls[2].fromNs) / 1e9).toBeCloseTo(30, 3);
    expect(
      modes(h)
        .slice(2)
        .every((m) => m === 'auto')
    ).toBe(true);
    expect(thinnedShown).not.toContain(true);
  });
});

// Archived PVs as "now" advances (#93 "Additional context", and #94's
// seconds-scale strip-tool windows): fetch only the new tail, at most every
// DRIFT_MIN_INTERVAL_MS, without aborting in-flight requests.
describe('archiveStore: archived PV while the window tracks now', () => {
  // One sample per whole second in the requested range, value = epoch second.
  function secondsDto(params: FetchDataParams): ArchiverDataDTO {
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
      decimated: false,
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

  it('switches the window to bins when tails would pass the raw point budget', async () => {
    // Quiet for the first fetch, then 200 Hz, so each tail fits but the
    // buffer they add up to doesn't. Like the archiver, a raw answer has at
    // most maxPoints samples, flagged decimated when there were more; a binned
    // one has ten bins over the window.
    const busyFromMs = T0_MS + 1_000;
    const h = setup(async (pv, params) => {
      if (params.binning) return decimatingFetch(Infinity)(pv, params);
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
    const thinnedShown: boolean[] = [];
    h.store.subscribe(() => {
      const entry = h.store.getSnapshot().get('t1');
      maxBuffered = Math.max(maxBuffered, entry?.mean.length ?? 0);
      thinnedShown.push(!!entry?.decimated);
    });

    await drift(h, { spanS: 1200, stepMs: 200, steps: 450 });
    const calls = h.fetchData.mock.calls.map((c) => c[1]);
    const modes = calls.map((p) => p.binning ?? 'raw');
    const firstBinned = modes.indexOf('auto');
    // Tails while the buffer fits...
    expect(firstBinned).toBeGreaterThan(2);
    expect(spanOf(calls[0])).toBe(1200);
    expect(spanOf(calls[1])).toBeLessThan(1200);
    expect(modes.slice(0, firstBinned).every((m) => m === 'raw')).toBe(true);
    // ...then the whole window raw once it wouldn't, which comes back
    // decimated, so the same window is asked for again binned.
    const overflow = calls[firstBinned - 1];
    expect(overflow).toMatchObject({ binning: undefined, maxPoints: 8000 });
    expect(spanOf(overflow)).toBe(1200);
    expect(calls[firstBinned]).toMatchObject({
      fromNs: overflow.fromNs,
      toNs: overflow.toNs,
      maxPoints: DEFAULT_OPTIMIZED_BINS,
    });
    // It stays binned as the window keeps moving.
    expect(modes.slice(firstBinned).every((m) => m === 'auto')).toBe(true);

    const entry = h.store.getSnapshot().get('t1')!;
    expect(entry).toMatchObject({ status: 'ready', mode: 'binned', decimated: false });
    expect(entry.band).toHaveLength(10);
    // The thinned raw answer is never put on screen, and the raw buffer never
    // goes past the budget.
    expect(thinnedShown).not.toContain(true);
    expect(maxBuffered).toBeLessThanOrEqual(8000);
    // 'loading' twice: the first fetch, and the switch from raw to bins.
    expect(h.published.t1.filter((st) => st === 'loading')).toHaveLength(2);
    expect(h.published.t1).not.toContain('error');
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
    // Every raw answer is decimated, so the store asks for bins (#122).
    const h = setup(decimatingFetch(0));
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
      archiver: 'test',
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

  it('a zoom back out before the finer bins land cancels their fetch', async () => {
    let resolveZoom!: () => void;
    const h: Harness = setup((_pv, params) => {
      if (h.fetchData.mock.calls.length !== 2) return Promise.resolve(binnedDto(params));
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
    await flush();
    ask(h, day); // restored while the zoom fetch is in flight
    resolveZoom();
    await flush();
    // Still the whole day, not 40 min of it.
    const entry = h.store.getSnapshot().get('t1')!;
    expect(entry.mean).toBe(coarse);
    expect(entry.coverFromNs).toBe(day.fromNs);
    expect(h.fetchData.mock.calls[1][2]?.aborted).toBe(true);
    expect(h.fetchData).toHaveBeenCalledTimes(2);
    expect(h.published.t1).toEqual(['loading', 'ready']);

    // The cancelled request doesn't count as fetched: the same zoom asks again.
    ask(h, zoom);
    await flush();
    expect(h.fetchData).toHaveBeenCalledTimes(3);
    expect(h.fetchData.mock.calls[2][1]).toMatchObject({ fromNs: zoom.fromNs, toNs: zoom.toNs });
  });

  // Day bins on screen, the first raw fetch (call 2) held until release().
  function rawZoomHeld() {
    let release!: () => void;
    const h: Harness = setup((_pv, params) => {
      const dto = params.binning ? binnedDto(params) : rawDto(params);
      if (h.fetchData.mock.calls.length !== 2) return Promise.resolve(dto);
      return new Promise((r) => {
        release = () => r(dto);
      });
    });
    return { h, release: () => release() };
  }

  it('a zoom back out before raw data lands fetches the new window, not day bins', async () => {
    const { h, release } = rawZoomHeld();
    const day = windowAt(h.now(), DAY_S);
    ask(h, day);
    await flush();
    ask(h, zoomTo(day, 10 * 60)); // raw: the day bins stay on screen meanwhile
    await flush();
    const out = zoomTo(day, 20 * 60);
    ask(h, out); // inside the day, but the day bins are too coarse for it
    await flush();
    expect(h.fetchData).toHaveBeenCalledTimes(3);
    expect(h.fetchData.mock.calls[1][2]?.aborted).toBe(true);
    expect(h.fetchData.mock.calls[2][1]).toMatchObject({ fromNs: out.fromNs, toNs: out.toNs });
    expect(h.fetchData.mock.calls[2][1].binning).toBeUndefined();
    // Not shown as ready on the day bins: 'ready' again only once the 20 min
    // answer is in.
    expect(h.published.t1).toEqual(['loading', 'ready', 'loading', 'loading', 'ready']);

    release(); // the cancelled 10 min answer doesn't land
    await flush();
    const entry = h.store.getSnapshot().get('t1')!;
    expect(entry.mode).toBe('raw');
    expect(entry.status).toBe('ready');
    expect(entry.coverFromNs).toBe(out.fromNs);
    ask(h, out);
    await flush();
    expect(h.fetchData).toHaveBeenCalledTimes(3);
  });

  it('a zoom further in before raw data lands waits for it', async () => {
    const { h, release } = rawZoomHeld();
    const day = windowAt(h.now(), DAY_S);
    ask(h, day);
    await flush();
    const zoom = zoomTo(day, 10 * 60);
    ask(h, zoom);
    await flush();
    const closer = zoomTo(day, 5 * 60);
    ask(h, closer); // the pending 10 min answer draws this too
    await flush();
    expect(h.fetchData).toHaveBeenCalledTimes(2);
    expect(h.fetchData.mock.calls[1][2]?.aborted).toBe(false);
    expect(h.store.getSnapshot().get('t1')!.status).toBe('loading');

    release();
    await flush();
    const entry = h.store.getSnapshot().get('t1')!;
    expect(entry.mode).toBe('raw');
    expect(entry.status).toBe('ready');
    expect(entry.coverFromNs).toBe(zoom.fromNs);
    ask(h, closer);
    await flush();
    expect(h.fetchData).toHaveBeenCalledTimes(2);
  });

  it('a zoom whose finer bins failed fetches them when it comes back', async () => {
    const h: Harness = setup(async (_pv, params) => {
      if (h.fetchData.mock.calls.length === 2) throw unavailable();
      return binnedDto(params);
    });
    const day = windowAt(h.now(), DAY_S);
    ask(h, day);
    await flush();
    const zoom = zoomTo(day, 40 * 60);
    ask(h, zoom);
    await flush();
    expect(h.store.getSnapshot().get('t1')!.status).toBe('error');
    ask(h, day); // back out: the coarse buffer covers it, the backoff is dropped
    await flush();
    expect(h.store.getSnapshot().get('t1')!.status).toBe('ready');

    ask(h, zoom);
    await flush();
    expect(h.fetchData).toHaveBeenCalledTimes(3);
    expect(h.fetchData.mock.calls[2][1]).toMatchObject({ fromNs: zoom.fromNs, toNs: zoom.toNs });
    expect(h.store.getSnapshot().get('t1')!.coverFromNs).toBe(zoom.fromNs);
  });
});

// A request back inside the buffer is a free render, but a fetch issued for
// the window in between may still be in flight. Its answer replaces the whole
// buffer, so it must not land unless it covers the window now on screen.
describe('archiveStore: back inside the buffer while a fetch is in flight', () => {
  const ask = (h: Harness, window: TimeWindowNs) =>
    h.store.request('t1', { pv: PV, archiver: undefined, window });

  // Answers every fetch at once except the second, which waits for release().
  function holdSecond() {
    let release!: () => void;
    const h: Harness = setup((_pv, params) => {
      if (h.fetchData.mock.calls.length !== 2) return Promise.resolve(rawDto(params));
      return new Promise((r) => {
        release = () => r(rawDto(params));
      });
    });
    return { h, release: () => release() };
  }

  // `win` moved by `byS` seconds (negative: into the past).
  const shift = (win: TimeWindowNs, byS: number): TimeWindowNs => ({
    fromNs: win.fromNs + byS * 1e9,
    toNs: win.toNs + byS * 1e9,
  });

  it('a pan back cancels the fetch for the window panned to', async () => {
    const { h, release } = holdSecond();
    const here = windowAt(h.now() - 3_600_000, 600);
    ask(h, here);
    await flush();
    const before = h.store.getSnapshot().get('t1')!.mean;

    ask(h, shift(here, -600));
    await flush();
    ask(h, here);
    release();
    await flush();
    const entry = h.store.getSnapshot().get('t1')!;
    expect(entry.mean).toBe(before);
    expect(entry.coverFromNs).toBe(here.fromNs);
    expect(h.fetchData.mock.calls[1][2]?.aborted).toBe(true);
    expect(h.fetchData).toHaveBeenCalledTimes(2);
  });

  it('keeps an in-flight fetch whose answer covers the window too', async () => {
    const { h, release } = holdSecond();
    const here = windowAt(h.now() - 3_600_000, 600);
    ask(h, here);
    await flush();

    const there = shift(here, -300);
    ask(h, there);
    await flush();
    // Zoom into the overlap: drawn from the buffer, and the pending answer
    // covers it as well.
    const overlap = { fromNs: here.fromNs + 60e9, toNs: there.toNs - 60e9 };
    ask(h, overlap);
    release();
    await flush();
    expect(h.fetchData.mock.calls[1][2]?.aborted).toBe(false);
    expect(h.store.getSnapshot().get('t1')!.coverFromNs).toBe(there.fromNs);
    ask(h, overlap);
    await flush();
    expect(h.fetchData).toHaveBeenCalledTimes(2);
  });
});
