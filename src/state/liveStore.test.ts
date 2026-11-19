import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { createFakeWebSocketFactory, type FakeWebSocket } from '@slaclab/canopy-client/testing';
import {
  AlarmSeverity,
  HarePVService,
  type HareAlarmSeverity,
  type PVData,
  type PVValueDTO,
  type WebSocketFactory,
} from '@slaclab/canopy-client';
import {
  LIVE_RETENTION_DEFAULT_MS,
  LIVE_RETENTION_MAX_MS,
  resolveLiveRetentionMs,
  LiveStore,
} from './liveStore';
import { CanopyError } from '../api/client';
import type { VoleSeriesDTO } from '../api/types';

vi.mock('../api/vole', () => ({
  fetchBackfill: vi.fn(),
  subscribeVoleBuffer: vi.fn(),
}));

import { fetchBackfill, subscribeVoleBuffer } from '../api/vole';
const mockFetchBackfill = vi.mocked(fetchBackfill);
const mockSubscribeVole = vi.mocked(subscribeVoleBuffer);

const BASE_URL = 'http://canopy.test';
const HARE_URL = 'ws://canopy.test/hare/v1/ws/pvs';
const WS_OPEN = 1;
const WS_CLOSED = 3;

// The store's sockets: the SDK's fake WebSocket, driven with open(),
// message(frame), close() and error().
let fake: ReturnType<typeof createFakeWebSocketFactory>;

function newStore(factory?: WebSocketFactory): LiveStore {
  return new LiveStore({
    connection: { baseUrl: BASE_URL },
    webSocketFactory: factory ?? fake.factory,
  });
}

// The stack's tests' form: a store on the shared fake socket factory.
function setup(factory?: WebSocketFactory) {
  const store = newStore(factory);
  return { store, instances: fake.instances, fakeFactory: fake.factory };
}

function pvValue(
  pv: string,
  value: PVValueDTO['value'],
  tsMs: number,
  severity: HareAlarmSeverity = 'NO_ALARM'
): PVValueDTO {
  return {
    pv,
    value,
    valueKind: typeof value === 'string' ? 'string' : 'scalar',
    severity,
    tsNs: tsMs * 1_000_000,
    connected: true,
    error: null,
  };
}

function initial(data: Record<string, PVValueDTO>) {
  return { type: 'initial', data, meta: {}, count: Object.keys(data).length };
}

function diff(data: Record<string, PVValueDTO>, timestamp = Date.now()) {
  return { type: 'diff', data, count: Object.keys(data).length, timestamp };
}

beforeEach(() => {
  fake = createFakeWebSocketFactory();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-06-05T12:00:00Z'));
  mockFetchBackfill.mockResolvedValue({ pv: '', count: 0, samples: [] });
  mockSubscribeVole.mockResolvedValue({ subscribed: [] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('LiveStore', () => {
  it('connects lazily and sends a subscribe frame after the socket opens', () => {
    const store = newStore();
    store.watch('t1', 'TEST:SINE', 60_000);

    expect(fake.instances).toHaveLength(1);
    const ws = fake.instances[0];
    // Pre-open: no subscribes were sent (would have errored on a real socket).
    expect(ws.sent).toEqual([]);

    ws.open();

    expect(ws.parsedSent()).toEqual([{ type: 'subscribe', pvNames: ['TEST:SINE'] }]);
  });

  it('appends numeric samples and exposes them through the snapshot', () => {
    const store = newStore();
    store.watch('t1', 'TEST:SINE', 60_000);
    const ws = fake.instances[0];
    ws.open();

    const tsMs = Date.now();
    ws.message({
      type: 'initial',
      meta: {},
      data: { 'TEST:SINE': pvValue('TEST:SINE', 1.5, tsMs) },
      count: 1,
    });

    const entry = store.getSnapshot().get('t1');
    expect(entry).toBeDefined();
    expect(entry!.connected).toBe(true);
    expect(entry!.severity).toBe('NO_ALARM');
    expect(entry!.points).toEqual([{ time: tsMs, value: 1.5, severity: 'NO_ALARM' }]);

    ws.message({
      type: 'diff',
      data: { 'TEST:SINE': pvValue('TEST:SINE', 2.25, tsMs + 100) },
      count: 1,
      timestamp: tsMs + 100,
    });
    expect(store.getSnapshot().get('t1')!.points).toEqual([
      { time: tsMs, value: 1.5, severity: 'NO_ALARM' },
      { time: tsMs + 100, value: 2.25, severity: 'NO_ALARM' },
    ]);
  });

  it('retains per-sample severity on each buffered point', () => {
    const store = newStore();
    store.watch('t1', 'SEV', 60_000);
    const ws = fake.instances[0];
    ws.open();

    const tsMs = Date.now();
    ws.message({
      type: 'initial',
      meta: {},
      data: { SEV: { ...pvValue('SEV', 1, tsMs), severity: 'MINOR' } },
      count: 1,
    });
    ws.message({
      type: 'diff',
      data: { SEV: { ...pvValue('SEV', 2, tsMs + 100), severity: 'MAJOR' } },
      count: 1,
      timestamp: tsMs + 100,
    });

    // Each point keeps the severity reported with it, not just the PV's latest.
    expect(store.getSnapshot().get('t1')!.points).toEqual([
      { time: tsMs, value: 1, severity: 'MINOR' },
      { time: tsMs + 100, value: 2, severity: 'MAJOR' },
    ]);
  });

  it('refcounts subscriptions across traces sharing one PV', async () => {
    const store = newStore();
    store.watch('t1', 'FOO', 60_000);
    store.watch('t2', 'FOO', 60_000);
    const ws = fake.instances[0];
    ws.open();

    // Only one outbound subscribe for FOO, even though two traces watch it.
    expect(ws.parsedSent()).toEqual([{ type: 'subscribe', pvNames: ['FOO'] }]);

    store.release('t1');
    // Still one subscriber left -> no unsubscribe yet.
    expect(ws.parsedSent()).toEqual([{ type: 'subscribe', pvNames: ['FOO'] }]);

    store.release('t2');
    // Last subscriber gone -> the socket closes, which drops the subscription
    // on Hare; the unsubscribe queued for this tick is never sent.
    await Promise.resolve();
    expect(ws.readyState).toBe(WS_CLOSED);
    expect(ws.parsedSent()).toEqual([{ type: 'subscribe', pvNames: ['FOO'] }]);
  });

  it('evicts samples older than the longest active retention once slack is exceeded', () => {
    const store = newStore();
    store.watch('t1', 'BAR', 1_000); // 1s retention
    const ws = fake.instances[0];
    ws.open();

    const t0 = Date.now();
    // Push a batch of stale samples starting at t0 (2ms apart, so ns -> ms
    // truncation never collapses neighbours). Eviction is batched
    // (deferred until the buffer overshoots the window by a slack margin), so
    // we push well past that margin to force a trim pass.
    const STALE = 300;
    for (let i = 0; i < STALE; i++) {
      ws.message({
        type: 'diff',
        data: { BAR: pvValue('BAR', i, t0 + 2 * i) },
        count: 1,
        timestamp: t0 + 2 * i,
      });
    }
    expect(store.getSnapshot().get('t1')!.points).toHaveLength(STALE);

    // Advance past the retention window, then push enough fresh samples to
    // cross the slack threshold and trigger eviction of the stale batch.
    const tFresh = t0 + 2_000;
    vi.setSystemTime(new Date(tFresh + 600));
    const FRESH = 300;
    for (let i = 0; i < FRESH; i++) {
      ws.message({
        type: 'diff',
        data: { BAR: pvValue('BAR', 1000 + i, tFresh + 2 * i) },
        count: 1,
        timestamp: tFresh + 2 * i,
      });
    }
    const points = store.getSnapshot().get('t1')!.points;
    // The stale batch is older than 1s and has been evicted; only the fresh
    // samples remain.
    expect(points).toHaveLength(FRESH);
    expect(points[0].time).toBe(tFresh);
  });

  it('marks PVs disconnected on socket close and re-subscribes on reopen', () => {
    const store = newStore();
    store.watch('t1', 'BAZ', 60_000);
    const ws = fake.instances[0];
    ws.open();
    ws.message({
      type: 'initial',
      meta: {},
      data: { BAZ: pvValue('BAZ', 7, Date.now()) },
      count: 1,
    });
    expect(store.getSnapshot().get('t1')!.connected).toBe(true);

    ws.close();
    expect(store.getSnapshot().get('t1')!.connected).toBe(false);
    // Buffer is preserved so the chart doesn't blank during reconnect.
    expect(store.getSnapshot().get('t1')!.points).toHaveLength(1);

    // Backoff: first reconnect attempt fires after 1s.
    vi.advanceTimersByTime(1_000);
    expect(fake.instances).toHaveLength(2);
    const ws2 = fake.instances[1];
    ws2.open();

    // On reopen the store re-subscribes everything currently watched.
    expect(ws2.parsedSent()).toEqual([{ type: 'subscribe', pvNames: ['BAZ'] }]);
  });

  it('skips non-numeric values for the points buffer but updates `latest`', () => {
    const store = newStore();
    store.watch('t1', 'STR', 60_000);
    const ws = fake.instances[0];
    ws.open();
    ws.message({
      type: 'initial',
      meta: {},
      data: {
        STR: { ...pvValue('STR', 0, Date.now()), value: 'OPERATIONAL' },
      },
      count: 1,
    });
    const entry = store.getSnapshot().get('t1')!;
    expect(entry.latest?.value).toBe('OPERATIONAL');
    expect(entry.points).toEqual([]);
  });

  it('surfaces ws error frames on the entry and clears them on a clean reopen', () => {
    const store = newStore();
    store.watch('t1', 'ERR', 60_000);
    const ws = fake.instances[0];
    ws.open();
    expect(store.getSnapshot().get('t1')!.error).toBeNull();

    ws.message({ type: 'error', code: 'BACKEND_DOWN', message: 'archiver unreachable' });
    expect(store.getSnapshot().get('t1')!.error).toEqual({
      code: 'BACKEND_DOWN',
      message: 'archiver unreachable',
    });

    // A clean reconnect clears the error.
    ws.close();
    vi.advanceTimersByTime(1_000);
    const ws2 = fake.instances[1];
    ws2.open();
    expect(store.getSnapshot().get('t1')!.error).toBeNull();
  });

  it('reuses the same entry reference when a PV is unchanged between frames', () => {
    const store = newStore();
    store.watch('t1', 'AAA', 60_000);
    store.watch('t2', 'BBB', 60_000);
    const ws = fake.instances[0];
    ws.open();

    const t0 = Date.now();
    ws.message({
      type: 'initial',
      meta: {},
      data: { AAA: pvValue('AAA', 1, t0), BBB: pvValue('BBB', 1, t0) },
      count: 2,
    });
    const first = store.getSnapshot();
    const aBefore = first.get('t1')!;
    const bBefore = first.get('t2')!;

    // A frame touching only AAA should leave BBB's entry object identical, so
    // downstream React.memo / shallow checks for the BBB trace short-circuit.
    ws.message({
      type: 'diff',
      data: { AAA: pvValue('AAA', 2, t0 + 100) },
      count: 1,
      timestamp: t0 + 100,
    });
    const second = store.getSnapshot();
    expect(second.get('t1')).not.toBe(aBefore); // AAA changed -> new entry
    expect(second.get('t2')).toBe(bBefore); // BBB unchanged -> same entry
  });

  it('getEntrySnapshot returns one trace and stays ref-stable when unrelated traces change', () => {
    const store = newStore();
    store.watch('t1', 'AAA', 60_000);
    store.watch('t2', 'BBB', 60_000);
    const ws = fake.instances[0];
    ws.open();

    const t0 = Date.now();
    ws.message({
      type: 'initial',
      meta: {},
      data: { AAA: pvValue('AAA', 1, t0), BBB: pvValue('BBB', 1, t0) },
      count: 2,
    });

    const bBefore = store.getEntrySnapshot('t2');
    expect(bBefore?.pv).toBe('BBB');

    // A frame touching only AAA leaves t2's entry reference identical, so a
    // consumer subscribed via getEntrySnapshot('t2') can bail its re-render.
    ws.message({
      type: 'diff',
      data: { AAA: pvValue('AAA', 2, t0 + 100) },
      count: 1,
      timestamp: t0 + 100,
    });
    expect(store.getEntrySnapshot('t2')).toBe(bBefore); // unchanged -> same ref
    expect(store.getEntrySnapshot('t1')).not.toBe(bBefore);
    expect(store.getEntrySnapshot('missing')).toBeUndefined();
  });
});

describe('LiveStore backfill', () => {
  function voleResponse(pv: string, samples: { tsNs: number; value: number }[]): VoleSeriesDTO {
    return {
      pv,
      count: samples.length,
      samples: samples.map((s) => ({ ...s, severity: 'NO_ALARM', source: 'live' as const })),
    };
  }

  it('fetches backfill on first watch and prepends samples to the buffer', async () => {
    const t0 = Date.now();
    mockFetchBackfill.mockResolvedValue(
      voleResponse('PV:A', [
        { tsNs: (t0 - 3000) * 1e6, value: 1 },
        { tsNs: (t0 - 2000) * 1e6, value: 2 },
        { tsNs: (t0 - 1000) * 1e6, value: 3 },
      ])
    );

    const store = newStore();
    store.watch('t1', 'PV:A', 60_000);
    const ws = fake.instances[0];
    ws.open();

    // Push a live sample that arrives while backfill is in flight.
    ws.message({ type: 'initial', meta: {}, data: { 'PV:A': pvValue('PV:A', 10, t0) }, count: 1 });

    // Let the backfill promise resolve.
    await vi.waitFor(() => {
      expect(store.getSnapshot().get('t1')!.points.length).toBe(4);
    });

    const points = store.getSnapshot().get('t1')!.points;
    expect(points[0]).toEqual({ time: t0 - 3000, value: 1, severity: 'NO_ALARM' });
    expect(points[3]).toEqual({ time: t0, value: 10, severity: 'NO_ALARM' });
  });

  it('deduplicates overlapping timestamps at the seam', async () => {
    const t0 = Date.now();
    mockFetchBackfill.mockResolvedValue(
      voleResponse('PV:B', [
        { tsNs: (t0 - 1000) * 1e6, value: 1 },
        { tsNs: t0 * 1e6, value: 2 },
      ])
    );

    const store = newStore();
    store.watch('t1', 'PV:B', 60_000);
    const ws = fake.instances[0];
    ws.open();

    // Live sample at the same timestamp as the last backfill sample.
    ws.message({ type: 'initial', meta: {}, data: { 'PV:B': pvValue('PV:B', 2, t0) }, count: 1 });

    await vi.waitFor(() => {
      expect(store.getSnapshot().get('t1')!.points.length).toBe(2);
    });

    const points = store.getSnapshot().get('t1')!.points;
    // Only the earlier sample is prepended; the overlapping one is dropped.
    expect(points).toEqual([
      { time: t0 - 1000, value: 1, severity: 'NO_ALARM' },
      { time: t0, value: 2, severity: 'NO_ALARM' },
    ]);
  });

  it('handles 404 gracefully (PV not buffered)', async () => {
    mockFetchBackfill.mockRejectedValue(new CanopyError('pv_not_buffered', 404, 'not buffered'));

    const store = newStore();
    store.watch('t1', 'PV:C', 60_000);
    const ws = fake.instances[0];
    ws.open();

    ws.message({
      type: 'initial',
      meta: {},
      data: { 'PV:C': pvValue('PV:C', 5, Date.now()) },
      count: 1,
    });

    // Allow the rejected promise to settle.
    await vi.advanceTimersByTimeAsync(0);

    // No crash, buffer only has the live sample.
    expect(store.getSnapshot().get('t1')!.points).toHaveLength(1);
  });

  it('aborts pending backfill on release', async () => {
    let resolveBackfill: (v: VoleSeriesDTO) => void;
    mockFetchBackfill.mockReturnValue(
      new Promise((r) => {
        resolveBackfill = r;
      })
    );

    const store = newStore();
    store.watch('t1', 'PV:D', 60_000);
    const ws = fake.instances[0];
    ws.open();

    const lastCall = mockFetchBackfill.mock.calls[mockFetchBackfill.mock.calls.length - 1];
    const signal = lastCall[2]?.signal as AbortSignal;
    expect(signal.aborted).toBe(false);

    store.release('t1');
    expect(signal.aborted).toBe(true);

    // Resolve after abort — should not crash or mutate state.
    resolveBackfill!(voleResponse('PV:D', [{ tsNs: Date.now() * 1e6, value: 99 }]));
    await vi.advanceTimersByTimeAsync(0);
  });

  it('backfills the gap on reconnect using the last known timestamp', async () => {
    const t0 = Date.now();
    // Initial backfill returns empty (PV just started).
    mockFetchBackfill.mockResolvedValueOnce(voleResponse('PV:F', []));

    const store = newStore();
    store.watch('t1', 'PV:F', 60_000);
    const ws = fake.instances[0];
    ws.open();

    ws.message({ type: 'initial', meta: {}, data: { 'PV:F': pvValue('PV:F', 1, t0) }, count: 1 });
    await vi.advanceTimersByTimeAsync(0);

    // Disconnect and reconnect after 2s.
    ws.close();
    vi.advanceTimersByTime(2000);
    vi.setSystemTime(new Date(t0 + 2000));

    // Reconnect backfill covers the gap.
    mockFetchBackfill.mockResolvedValueOnce(
      voleResponse('PV:F', [{ tsNs: (t0 + 1000) * 1e6, value: 1.5 }])
    );

    const ws2 = fake.instances[1];
    ws2.open();

    await vi.waitFor(() => {
      expect(store.getSnapshot().get('t1')!.points.length).toBe(2);
    });

    const points = store.getSnapshot().get('t1')!.points;
    expect(points[0]).toEqual({ time: t0, value: 1, severity: 'NO_ALARM' });
    expect(points[1]).toEqual({ time: t0 + 1000, value: 1.5, severity: 'NO_ALARM' });

    // The fromNs passed to the reconnect backfill should be the last point's timestamp.
    const reconnectCall = mockFetchBackfill.mock.calls[mockFetchBackfill.mock.calls.length - 1];
    expect(reconnectCall[1]).toBe(t0 * 1e6);
  });
  function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  // Connect, receive one live sample at t0, drop the socket, and advance to
  // the reconnect. Returns the second socket (not yet opened).
  function connectThenDrop(store: LiveStore, pv: string, t0: number): FakeWebSocket {
    store.watch('t1', pv, 60_000);
    const ws = fake.instances[0];
    ws.open();
    ws.message({ type: 'initial', meta: {}, data: { [pv]: pvValue(pv, 0, t0) }, count: 1 });
    ws.close();
    vi.setSystemTime(new Date(t0 + 4000));
    vi.advanceTimersByTime(1000);
    return fake.instances[1];
  }

  it('fills the reconnect gap when the Hare initial frame arrives before the Vole response', async () => {
    const t0 = Date.now();
    const store = newStore();
    await vi.advanceTimersByTimeAsync(0);
    const ws2 = connectThenDrop(store, 'PV:G', t0);

    const pending = deferred<VoleSeriesDTO>();
    mockFetchBackfill.mockReturnValueOnce(pending.promise);
    ws2.open();
    ws2.message({
      type: 'initial',
      meta: {},
      data: { 'PV:G': pvValue('PV:G', 4, t0 + 4000) },
      count: 1,
    });

    pending.resolve(
      voleResponse('PV:G', [
        { tsNs: t0 * 1e6, value: 0 },
        { tsNs: (t0 + 1000) * 1e6, value: 1 },
        { tsNs: (t0 + 2000) * 1e6, value: 2 },
        { tsNs: (t0 + 3000) * 1e6, value: 3 },
        { tsNs: (t0 + 4000) * 1e6, value: 4 },
      ])
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(
      store
        .getSnapshot()
        .get('t1')!
        .points.map((p) => [p.time, p.value])
    ).toEqual([
      [t0, 0],
      [t0 + 1000, 1],
      [t0 + 2000, 2],
      [t0 + 3000, 3],
      [t0 + 4000, 4],
    ]);
  });

  it('does not duplicate the latest sample when Vole resolves before Hare re-sends it', async () => {
    const t0 = Date.now();
    const store = newStore();
    await vi.advanceTimersByTimeAsync(0);
    const ws2 = connectThenDrop(store, 'PV:H', t0);

    mockFetchBackfill.mockResolvedValueOnce(
      voleResponse('PV:H', [
        { tsNs: (t0 + 2000) * 1e6, value: 2 },
        { tsNs: (t0 + 4000) * 1e6, value: 4 },
      ])
    );
    ws2.open();
    await vi.advanceTimersByTimeAsync(0);
    ws2.message({
      type: 'initial',
      meta: {},
      data: { 'PV:H': pvValue('PV:H', 4, t0 + 4000) },
      count: 1,
    });

    expect(
      store
        .getSnapshot()
        .get('t1')!
        .points.map((p) => [p.time, p.value])
    ).toEqual([
      [t0, 0],
      [t0 + 2000, 2],
      [t0 + 4000, 4],
    ]);
  });
});

describe('LiveStore backfill window', () => {
  it('asks for no more than the retention window after a long disconnect', async () => {
    const t0 = Date.now();
    const store = newStore();
    store.watch('t1', 'PV:A', 5 * 60_000);
    const ws = fake.instances[0];
    ws.open();
    ws.message({ type: 'initial', meta: {}, data: { 'PV:A': pvValue('PV:A', 1, t0) }, count: 1 });
    ws.close();

    // Two hours asleep, then the reconnect.
    await vi.advanceTimersByTimeAsync(1000);
    vi.setSystemTime(new Date(t0 + 2 * 3600_000));
    fake.instances[1].open();

    const reconnectCall = mockFetchBackfill.mock.calls[mockFetchBackfill.mock.calls.length - 1];
    // now - 5 min, not the last point two hours back.
    expect(reconnectCall[1]).toBe((t0 + 115 * 60_000) * 1e6);
  });
});

describe('LiveStore out-of-order samples', () => {
  function bufferOf(store: LiveStore) {
    return store
      .getSnapshot()
      .get('t1')!
      .points.map((p) => [p.time, p.value]);
  }

  it('keeps updating after a sample stamped ahead of the live stream', () => {
    const t0 = Date.now();
    const store = newStore();
    store.watch('t1', 'PV:A', 60_000);
    const ws = fake.instances[0];
    ws.open();
    // e.g. a backfill sample from a clock running 5 s ahead of Hare's.
    ws.message({ type: 'diff', data: { 'PV:A': pvValue('PV:A', 9, t0 + 5000) }, count: 1 });
    ws.message({ type: 'diff', data: { 'PV:A': pvValue('PV:A', 1, t0 + 1000) }, count: 1 });
    ws.message({ type: 'diff', data: { 'PV:A': pvValue('PV:A', 2, t0 + 2000) }, count: 1 });

    expect(bufferOf(store)).toEqual([
      [t0 + 1000, 1],
      [t0 + 2000, 2],
      [t0 + 5000, 9],
    ]);
  });

  it('keeps two different values in the same millisecond, but not a repeat', () => {
    const t0 = Date.now();
    const store = newStore();
    store.watch('t1', 'PV:A', 60_000);
    const ws = fake.instances[0];
    ws.open();
    ws.message({ type: 'diff', data: { 'PV:A': pvValue('PV:A', 1, t0) }, count: 1 });
    ws.message({ type: 'diff', data: { 'PV:A': pvValue('PV:A', 2, t0) }, count: 1 });
    ws.message({ type: 'diff', data: { 'PV:A': pvValue('PV:A', 2, t0) }, count: 1 });

    expect(bufferOf(store)).toEqual([
      [t0, 1],
      [t0, 2],
    ]);
  });
});

describe('LiveStore socket lifecycle', () => {
  it('closes the socket when the last trace is released', () => {
    const store = newStore();
    store.watch('t1', 'PV:A', 60_000);
    store.watch('t2', 'PV:B', 60_000);
    const ws = fake.instances[0];
    ws.open();

    store.release('t1');
    expect(ws.readyState).toBe(WS_OPEN);

    store.release('t2');
    expect(ws.readyState).toBe(WS_CLOSED);
    // No reconnect is scheduled for an intentional close.
    vi.advanceTimersByTime(30_000);
    expect(fake.instances).toHaveLength(1);
  });

  it('shows no connection error after closing a socket that is still connecting', () => {
    const store = newStore();
    store.watch('t1', 'PV:A', 60_000);
    const ws = fake.instances[0];
    store.release('t1');
    // A browser fires `error` when a connecting socket is closed.
    ws.error();

    store.watch('t2', 'PV:B', 60_000);
    expect(store.getSnapshot().get('t2')!.error).toBeNull();
  });

  it('opens a fresh socket and subscribes when watching again after a full release', () => {
    const store = newStore();
    store.watch('t1', 'PV:A', 60_000);
    fake.instances[0].open();
    store.release('t1');

    store.watch('t2', 'PV:B', 60_000);
    expect(fake.instances).toHaveLength(2);
    const ws2 = fake.instances[1];
    ws2.open();
    expect(ws2.parsedSent()).toEqual([{ type: 'subscribe', pvNames: ['PV:B'] }]);
    expect(store.getSnapshot().get('t2')!.status).toBe('connected');
  });
});

describe('LiveStore vole subscribe', () => {
  it('calls subscribeVoleBuffer when backfill returns 404 (pv_not_buffered)', async () => {
    mockFetchBackfill.mockRejectedValue(new CanopyError('pv_not_buffered', 404, 'not buffered'));
    mockSubscribeVole.mockClear();

    const store = newStore();
    store.watch('t1', 'PV:X', 60_000);
    const ws = fake.instances[0];
    ws.open();

    await vi.advanceTimersByTimeAsync(0);

    expect(mockSubscribeVole).toHaveBeenCalledTimes(1);
    expect(mockSubscribeVole.mock.calls[0][0]).toEqual(['PV:X']);
  });

  it("recognises pv_not_buffered from another copy of the SDK's CanopyError", async () => {
    // Same shape, different class: what a duplicate canopy-client would throw.
    mockFetchBackfill.mockRejectedValue(
      Object.assign(new Error('pv_not_buffered (404): not buffered'), {
        name: 'CanopyError',
        code: 'pv_not_buffered',
        status: 404,
        detail: 'not buffered',
      })
    );
    mockSubscribeVole.mockClear();

    const store = newStore();
    store.watch('t1', 'PV:X', 60_000);
    fake.instances[0].open();

    await vi.advanceTimersByTimeAsync(0);

    expect(mockSubscribeVole).toHaveBeenCalledTimes(1);
    expect(mockSubscribeVole.mock.calls[0][0]).toEqual(['PV:X']);
  });

  it('subscribes once per watch, not again on every reconnect', async () => {
    mockFetchBackfill.mockRejectedValue(new CanopyError('pv_not_buffered', 404, 'not buffered'));
    mockSubscribeVole.mockClear();

    const store = newStore();
    store.watch('t1', 'PV:X', 60_000);
    fake.instances[0].open();
    await vi.advanceTimersByTimeAsync(0);
    fake.instances[0].close();
    await vi.advanceTimersByTimeAsync(1000);
    fake.instances[1].open();
    await vi.advanceTimersByTimeAsync(0);

    expect(mockSubscribeVole).toHaveBeenCalledTimes(1);

    // A fresh watch after a full release asks again.
    store.release('t1');
    store.watch('t2', 'PV:X', 60_000);
    fake.instances[2].open();
    await vi.advanceTimersByTimeAsync(0);

    expect(mockSubscribeVole).toHaveBeenCalledTimes(2);
  });

  it('aborts the subscribe POST when the PV is released', async () => {
    mockFetchBackfill.mockRejectedValue(new CanopyError('pv_not_buffered', 404, 'not buffered'));
    mockSubscribeVole.mockClear();
    mockSubscribeVole.mockReturnValue(new Promise(() => {}));

    const store = newStore();
    store.watch('t1', 'PV:X', 60_000);
    fake.instances[0].open();
    await vi.advanceTimersByTimeAsync(0);
    const signal = mockSubscribeVole.mock.calls[0][1]!.signal!;
    expect(signal.aborted).toBe(false);

    store.release('t1');

    expect(signal.aborted).toBe(true);
  });

  it('does not call subscribeVoleBuffer when backfill succeeds', async () => {
    mockFetchBackfill.mockResolvedValue({ pv: 'PV:Y', count: 0, samples: [] });
    mockSubscribeVole.mockClear();

    const store = newStore();
    store.watch('t1', 'PV:Y', 60_000);
    const ws = fake.instances[0];
    ws.open();

    await vi.advanceTimersByTimeAsync(0);

    expect(mockSubscribeVole).not.toHaveBeenCalled();
  });

  it('does not call subscribeVoleBuffer on a generic 404', async () => {
    mockFetchBackfill.mockRejectedValue(new CanopyError('not_found', 404, 'no such route'));
    mockSubscribeVole.mockClear();

    const store = newStore();
    store.watch('t1', 'PV:W', 60_000);
    const ws = fake.instances[0];
    ws.open();

    await vi.advanceTimersByTimeAsync(0);

    expect(mockSubscribeVole).not.toHaveBeenCalled();
  });

  it('swallows errors from subscribeVoleBuffer without crashing', async () => {
    mockFetchBackfill.mockRejectedValue(new CanopyError('pv_not_buffered', 404, 'not buffered'));
    mockSubscribeVole.mockRejectedValue(new Error('network down'));

    const store = newStore();
    store.watch('t1', 'PV:Z', 60_000);
    const ws = fake.instances[0];
    ws.open();

    await vi.advanceTimersByTimeAsync(0);

    // No crash — store operates normally.
    expect(store.getSnapshot().get('t1')).toBeDefined();
  });
});

describe('LiveStore on HarePVService', () => {
  function initial(data: Record<string, PVValueDTO>) {
    return { type: 'initial', data, meta: {}, count: Object.keys(data).length };
  }

  function diff(data: Record<string, PVValueDTO>) {
    return { type: 'diff', data, count: Object.keys(data).length, timestamp: Date.now() };
  }

  it('opens the Hare socket lazily and reports connecting, then connected', () => {
    const store = newStore();
    expect(fake.instances).toHaveLength(0);

    store.watch('t1', 'TEST:SINE', 60_000);

    const ws = fake.instances[0];
    expect(ws.url).toBe(HARE_URL);
    expect(store.getSnapshot().get('t1')!.status).toBe('connecting');
    ws.open();
    expect(store.getSnapshot().get('t1')!.status).toBe('connected');
  });

  it('delivers one sample per update to every trace on a shared PV', () => {
    const store = newStore();
    store.watch('t1', 'FOO', 60_000);
    store.watch('t2', 'FOO', 60_000);
    const ws = fake.instances[0];
    ws.open();

    const tsMs = Date.now();
    ws.message(initial({ FOO: pvValue('FOO', 1, tsMs) }));

    const snap = store.getSnapshot();
    expect(snap.get('t1')!.points).toEqual([{ time: tsMs, value: 1, severity: 'NO_ALARM' }]);
    expect(snap.get('t2')!.points).toBe(snap.get('t1')!.points);
  });

  it('adds no sample for a PV that Hare reports disconnected, and keeps its severity', () => {
    const store = newStore();
    store.watch('t1', 'GONE', 60_000);
    const ws = fake.instances[0];
    ws.open();

    const tsMs = Date.now();
    ws.message(initial({ GONE: pvValue('GONE', 4, tsMs, 'MINOR') }));
    // The IOC goes away: value null, connected false. The SDK hands that on
    // with value 0, which must not reach the chart.
    ws.message(
      diff({ GONE: { ...pvValue('GONE', null, tsMs + 100, 'INVALID'), connected: false } })
    );

    const entry = store.getSnapshot().get('t1')!;
    expect(entry.connected).toBe(false);
    expect(entry.severity).toBe('MINOR');
    expect(entry.points).toEqual([{ time: tsMs, value: 4, severity: 'MINOR' }]);
    expect(entry.status).toBe('connected');
  });

  it('adds no sample for a null value from a connected PV', () => {
    const store = newStore();
    store.watch('t1', 'EMPTY', 60_000);
    const ws = fake.instances[0];
    ws.open();

    const tsMs = Date.now();
    ws.message(initial({ EMPTY: pvValue('EMPTY', null, tsMs) }));
    ws.message(diff({ EMPTY: pvValue('EMPTY', 0, tsMs + 100) }));

    const entry = store.getSnapshot().get('t1')!;
    expect(entry.connected).toBe(true);
    // The real 0 is a sample; the null before it isn't.
    expect(entry.points).toEqual([{ time: tsMs + 100, value: 0, severity: 'NO_ALARM' }]);
  });

  it("keeps an enum sample whose choice label is '---'", () => {
    const store = newStore();
    store.watch('t1', 'MODE', 60_000);
    const ws = fake.instances[0];
    ws.open();

    const tsMs = Date.now();
    ws.message({
      type: 'initial',
      data: { MODE: { ...pvValue('MODE', 0, tsMs), valueKind: 'enum' } },
      meta: {
        MODE: {
          pv: 'MODE',
          valueKind: 'enum',
          units: null,
          precision: null,
          enumChoices: ['---', 'ON'],
          displayLow: null,
          displayHigh: null,
        },
      },
      count: 1,
    });
    ws.message(diff({ MODE: { ...pvValue('MODE', 1, tsMs + 100), valueKind: 'enum' } }));

    const entry = store.getSnapshot().get('t1')!;
    expect(entry.latest!.displayValue).toBe('ON');
    expect(entry.points).toEqual([
      { time: tsMs, value: 0, severity: 'NO_ALARM' },
      { time: tsMs + 100, value: 1, severity: 'NO_ALARM' },
    ]);
  });

  describe('updates the socket frames cannot produce', () => {
    // HarePVService reports DISCONNECTED only with connected: false, and reads
    // an unknown wire severity as INVALID, but PVData allows either. These hand
    // the store an update through the listener it subscribed with.
    let deliver: (data: PVData) => void;
    let spy: MockInstance<HarePVService['subscribe']>;

    beforeEach(() => {
      const subscribe = HarePVService.prototype.subscribe;
      spy = vi.spyOn(HarePVService.prototype, 'subscribe').mockImplementation(function (
        this: HarePVService,
        pv,
        listener
      ) {
        deliver = listener;
        return subscribe.call(this, pv, listener);
      });
    });

    afterEach(() => {
      spy.mockRestore();
    });

    it('treats a DISCONNECTED severity as disconnected even when the update says connected', () => {
      const store = newStore();
      store.watch('t1', 'FLAP', 60_000);
      const ws = fake.instances[0];
      ws.open();

      const tsMs = Date.now();
      ws.message(initial({ FLAP: pvValue('FLAP', 4, tsMs, 'MINOR') }));
      deliver({
        ...store.getSnapshot().get('t1')!.latest!,
        value: 5,
        timestamp: tsMs + 100,
        connected: true,
        severity: AlarmSeverity.DISCONNECTED,
      });

      let entry = store.getSnapshot().get('t1')!;
      expect(entry.connected).toBe(false);
      expect(entry.severity).toBe('MINOR');
      expect(entry.points).toEqual([{ time: tsMs, value: 4, severity: 'MINOR' }]);

      // The next reading is a sample again.
      ws.message(diff({ FLAP: pvValue('FLAP', 6, tsMs + 200) }));
      entry = store.getSnapshot().get('t1')!;
      expect(entry.connected).toBe(true);
      expect(entry.severity).toBe('NO_ALARM');
      expect(entry.points).toEqual([
        { time: tsMs, value: 4, severity: 'MINOR' },
        { time: tsMs + 200, value: 6, severity: 'NO_ALARM' },
      ]);
    });

    it('reads a severity the SDK does not define as INVALID', () => {
      const store = newStore();
      store.watch('t1', 'ODD', 60_000);
      const ws = fake.instances[0];
      ws.open();

      const tsMs = Date.now();
      ws.message(initial({ ODD: pvValue('ODD', 4, tsMs) }));
      deliver({
        ...store.getSnapshot().get('t1')!.latest!,
        value: 5,
        timestamp: tsMs + 100,
        severity: 9 as AlarmSeverity,
      });

      const entry = store.getSnapshot().get('t1')!;
      expect(entry.connected).toBe(true);
      expect(entry.severity).toBe('INVALID');
      expect(entry.points).toEqual([
        { time: tsMs, value: 4, severity: 'NO_ALARM' },
        { time: tsMs + 100, value: 5, severity: 'INVALID' },
      ]);
    });
  });

  it('reports a socket that cannot be created and retries with backoff', () => {
    const later = createFakeWebSocketFactory();
    let failNext = true;
    const store = newStore((url) => {
      if (failNext) {
        failNext = false;
        throw new Error('blocked');
      }
      return later.factory(url);
    });

    store.watch('t1', 'X', 60_000);
    const entry = store.getSnapshot().get('t1')!;
    expect(entry.status).toBe('disconnected');
    expect(entry.error).toEqual({
      code: 'ws_connect_failed',
      message: 'Could not open live connection: blocked',
    });

    vi.advanceTimersByTime(1_000);
    expect(later.instances).toHaveLength(1);
    later.instances[0].open();
    expect(store.getSnapshot().get('t1')!.error).toBeNull();
  });

  it('pings the server and reconnects when nothing comes back', () => {
    const store = newStore();
    store.watch('t1', 'PING', 60_000);
    const ws = fake.instances[0];
    ws.open();
    ws.message(initial({ PING: pvValue('PING', 1, Date.now()) }));

    vi.advanceTimersByTime(15_000);
    expect(ws.parsedSent()).toContainEqual({ type: 'ping' });

    // No pong (or any frame) within 10s: the socket is treated as dead.
    vi.advanceTimersByTime(10_000);
    expect(ws.readyState).toBe(WS_CLOSED);
    expect(store.getSnapshot().get('t1')!.status).toBe('disconnected');

    vi.advanceTimersByTime(1_000);
    expect(fake.instances).toHaveLength(2);
  });

  it('keeps the socket open when a trace switches PV', async () => {
    const store = newStore();
    store.watch('t1', 'OLD', 60_000);
    const ws = fake.instances[0];
    ws.open();

    store.watch('t1', 'NEW', 60_000);
    // Subscribe/unsubscribe frames go out at the end of the tick.
    await Promise.resolve();

    expect(fake.instances).toHaveLength(1);
    expect(ws.readyState).toBe(WS_OPEN);
    expect(ws.parsedSent()).toEqual([
      { type: 'subscribe', pvNames: ['OLD'] },
      { type: 'unsubscribe', pvNames: ['OLD'] },
      { type: 'subscribe', pvNames: ['NEW'] },
    ]);
  });

  describe('connection error text', () => {
    const DROPPED = { code: 'ws_disconnected', message: 'Live connection error.' };

    it('shows an error while a dropped socket reconnects and clears it on reopen', () => {
      const store = newStore();
      store.watch('t1', 'DROP', 60_000);
      const ws = fake.instances[0];
      ws.open();
      expect(store.getSnapshot().get('t1')!.error).toBeNull();

      ws.close(1006);
      const entry = store.getSnapshot().get('t1')!;
      expect(entry.status).toBe('disconnected');
      expect(entry.error).toEqual(DROPPED);

      vi.advanceTimersByTime(1_000);
      fake.instances[1].open();
      expect(store.getSnapshot().get('t1')!.error).toBeNull();
    });

    it('shows an error when the socket never opens', () => {
      const store = newStore();
      store.watch('t1', 'REFUSED', 60_000);
      // A refused handshake (e.g. a rejected API key) closes before open.
      fake.instances[0].error();
      fake.instances[0].close(1006);
      expect(store.getSnapshot().get('t1')!.error).toEqual(DROPPED);
    });

    it("keeps the service's message for a terminal close", () => {
      const store = newStore();
      store.watch('t1', 'KEY', 60_000);
      const ws = fake.instances[0];
      ws.open();
      ws.close(1008, 'invalid_api_key');
      const error = store.getSnapshot().get('t1')!.error!;
      expect(error.code).toBe('ws_terminal_close');
      expect(error.message).toContain('1008');
    });

    it('shows no error after the last trace is released', () => {
      const store = newStore();
      store.watch('t1', 'GONE', 60_000);
      fake.instances[0].open();
      store.release('t1');

      store.watch('t2', 'NEXT', 60_000);
      expect(store.getSnapshot().get('t2')!.error).toBeNull();
    });
  });
});

describe('LiveStore Hare breaks', () => {
  function connectedStore() {
    const { store, instances } = setup();
    store.watch('t1', 'GAP', 600_000);
    const ws = instances[0];
    ws.open();
    return { store, ws, instances };
  }

  it('records one break per outage, at the disconnect: two connected=false updates give one', () => {
    const { store, ws } = connectedStore();
    const t0 = Date.now() - 5_000;
    ws.message(initial({ GAP: pvValue('GAP', 1, t0) }));
    expect(store.getSnapshot().get('t1')!.breaks).toEqual([]);

    const down = { ...pvValue('GAP', 1, t0), connected: false };
    ws.message(diff({ GAP: down }, t0));
    const tDown = Date.now();
    vi.setSystemTime(tDown + 1_000);
    ws.message(diff({ GAP: down }, t0));
    const entry = store.getSnapshot().get('t1')!;
    expect(entry.connected).toBe(false);
    // When the disconnect was seen, not the last sample + 1 ms.
    expect(entry.breaks).toEqual([tDown]);
    // A disconnected update never adds a point after the break.
    expect(entry.points.map((p) => p.time)).toEqual([t0]);

    // A socket close while the PV is already down adds no second break.
    ws.close(1006);
    expect(store.getSnapshot().get('t1')!.breaks).toEqual([tDown]);
  });

  it('breaks at the last sample + 1 ms when the clock is not later', () => {
    const { store, ws } = connectedStore();
    // The IOC's clock is ahead of this one.
    const t0 = Date.now() + 2_000;
    ws.message(initial({ GAP: pvValue('GAP', 1, t0) }));
    ws.close(1006);
    expect(store.getSnapshot().get('t1')!.breaks).toEqual([t0 + 1]);
  });

  it('socket close, reopen and an initial frame with an old tsNs: one break, no re-stamp', () => {
    const { store, ws, instances } = connectedStore();
    const t0 = Date.now() - 60_000;
    ws.message(initial({ GAP: pvValue('GAP', 7, t0) }));

    const tDrop = Date.now();
    ws.close(1006);
    expect(store.getSnapshot().get('t1')!.breaks).toEqual([tDrop]);

    vi.advanceTimersByTime(1_000);
    const ws2 = instances[1];
    ws2.open();
    // Hare replays the unchanged value with its original (pre-break) timestamp:
    // an exact repeat, so no second point. (The empty backfill covers nothing.)
    ws2.message(initial({ GAP: pvValue('GAP', 7, t0) }));

    const entry = store.getSnapshot().get('t1')!;
    expect(entry.connected).toBe(true);
    expect(entry.breaks).toEqual([tDrop]);
    expect(entry.points).toEqual([{ time: t0, value: 7, severity: 'NO_ALARM' }]);
  });

  it('lands a value that changed before the drop at its IOC time, before the break', () => {
    const { store, ws, instances } = connectedStore();
    const t0 = Date.now();
    ws.message(initial({ GAP: pvValue('GAP', 1, t0) }));
    vi.setSystemTime(t0 + 10_000);
    ws.close(1006);
    vi.advanceTimersByTime(1_000);
    const ws2 = instances[1];
    ws2.open();
    // The change at t0 + 4 s never arrived before the socket dropped.
    ws2.message(initial({ GAP: pvValue('GAP', 2, t0 + 4_000) }));
    const entry = store.getSnapshot().get('t1')!;
    expect(entry.points.map((p) => [p.time, p.value])).toEqual([
      [t0, 1],
      [t0 + 4_000, 2],
    ]);
    expect(entry.breaks).toEqual([t0 + 10_000]);
  });

  it('keeps a fresh post-break timestamp as is', () => {
    const { store, ws } = connectedStore();
    const t0 = Date.now() - 60_000;
    ws.message(initial({ GAP: pvValue('GAP', 1, t0) }));
    const tDown = Date.now();
    ws.message(diff({ GAP: { ...pvValue('GAP', 1, t0), connected: false } }, t0));
    vi.setSystemTime(tDown + 30_000);
    ws.message(diff({ GAP: pvValue('GAP', 2, tDown + 30_000) }));
    const entry = store.getSnapshot().get('t1')!;
    expect(entry.breaks).toEqual([tDown]);
    expect(entry.points.map((p) => p.time)).toEqual([t0, tDown + 30_000]);
  });

  it('records no break for a PV that never had a point', () => {
    const { store, ws } = connectedStore();
    ws.message(initial({ GAP: pvValue('GAP', 'text', Date.now()) }));
    ws.close(1006);
    expect(store.getSnapshot().get('t1')!.breaks).toEqual([]);
  });
});

// R2: a socket blip must not blank a slow PV back to its last change.
describe('LiveStore socket blips (R2)', () => {
  const MIN = 60_000;
  const PV = 'SLOW';

  function vole(samples: { tsNs: number; value: number }[]): VoleSeriesDTO {
    return {
      pv: PV,
      count: samples.length,
      samples: samples.map((s) => ({ ...s, severity: 'NO_ALARM', source: 'live' as const })),
    };
  }

  function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  // A slow PV that last changed 10 minutes before the socket drops, stamped
  // `subMsNs` into its millisecond. Returns the store, the PV's last change,
  // the disconnect time, and `reconnect()`, which waits out the backoff and
  // returns the next socket, not yet open.
  async function blip(retentionMs = 30 * MIN, subMsNs = 0) {
    const { store, instances } = setup();
    store.watch('t1', PV, retentionMs);
    const ws = instances[0];
    ws.open();
    const t0 = Date.now() - 10 * MIN;
    ws.message(initial({ [PV]: { ...pvValue(PV, 7, t0), tsNs: t0 * 1e6 + subMsNs } }));
    // The first backfill (empty) settles.
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(Date.now() + 5_000);
    const tDrop = Date.now();
    ws.close(1006);
    let next = 1;
    const reconnect = () => {
      vi.advanceTimersByTime(1_000);
      return instances[next++];
    };
    return { store, ws, t0, tDrop, reconnect };
  }

  const entryOf = (store: LiveStore) => store.getSnapshot().get('t1')!;
  // The `from` the latest backfill asked Vole for, in ns.
  const lastFromNs = () => mockFetchBackfill.mock.calls.at(-1)![1];
  // Vole's `align=last` answer when its buffer reaches back to `from`: its last
  // sample before `from`, pinned at `from`.
  const pinned = (value: number) => vole([{ tsNs: lastFromNs(), value }]);

  it('draws the held value up to the disconnect, not back to its last change', async () => {
    const { store, t0, tDrop } = await blip();
    const entry = entryOf(store);
    expect(entry.connected).toBe(false);
    expect(entry.points.map((p) => p.time)).toEqual([t0]);
    // The step line holds 7 from t0 up to the break: ten minutes, not 1 ms.
    expect(entry.breaks).toEqual([tDrop]);
    expect(tDrop - t0).toBe(10 * MIN + 5_000);
  });

  it('does not re-stamp the replay of an unchanged value', async () => {
    const { store, t0, tDrop, reconnect } = await blip();
    const ws2 = reconnect();
    ws2.open();
    ws2.message(initial({ [PV]: pvValue(PV, 7, t0) }));
    await vi.advanceTimersByTimeAsync(0);

    const entry = entryOf(store);
    expect(entry.connected).toBe(true);
    // An exact repeat: dropped, not moved to its receipt time.
    expect(entry.points).toEqual([{ time: t0, value: 7, severity: 'NO_ALARM' }]);
    // The empty backfill covers nothing, so the break stays.
    expect(entry.breaks).toEqual([tDrop]);
  });

  it('lands a value that changed during the outage at its IOC time', async () => {
    const { store, t0, tDrop, reconnect } = await blip();
    const ws2 = reconnect();
    ws2.open();
    ws2.message(initial({ [PV]: pvValue(PV, 8, tDrop + 500) }));
    await vi.advanceTimersByTimeAsync(0);

    const entry = entryOf(store);
    expect(entry.points.map((p) => [p.time, p.value])).toEqual([
      [t0, 7],
      [tDrop + 500, 8],
    ]);
    expect(entry.breaks).toEqual([tDrop]);
  });

  it('drops the break when the backfill covers the outage, Hare first', async () => {
    const { store, t0, reconnect } = await blip();
    const pending = deferred<VoleSeriesDTO>();
    mockFetchBackfill.mockReturnValueOnce(pending.promise);
    const ws2 = reconnect();
    ws2.open();
    // From the newest point.
    expect(lastFromNs()).toBe(t0 * 1e6);
    ws2.message(initial({ [PV]: pvValue(PV, 7, t0) }));
    pending.resolve(pinned(7));
    await vi.advanceTimersByTimeAsync(0);

    const entry = entryOf(store);
    expect(entry.breaks).toEqual([]);
    expect(entry.points).toEqual([{ time: t0, value: 7, severity: 'NO_ALARM' }]);
  });

  it('drops the break when the backfill covers the outage, Vole first', async () => {
    const { store, t0, tDrop, reconnect } = await blip();
    mockFetchBackfill.mockImplementationOnce(async (_pv, fromNs) =>
      vole([{ tsNs: fromNs, value: 7 }])
    );
    const ws2 = reconnect();
    ws2.open();
    await vi.advanceTimersByTimeAsync(0);
    // The cover waits for the PV's first update: it might still be down.
    expect(entryOf(store).breaks).toEqual([tDrop]);

    ws2.message(initial({ [PV]: pvValue(PV, 7, t0) }));
    expect(entryOf(store).breaks).toEqual([]);
  });

  it("drops the break when Vole's buffer starts at the newest point itself", async () => {
    // Real stamps carry sub-ms digits. The store keeps the floored ms, so
    // `from` falls before the sample's own stamp, and Vole, holding nothing
    // earlier, returns that sample as it is, without a pin.
    const tsNs = (Date.now() - 10 * MIN) * 1e6 + 456_789;
    const { store, t0, reconnect } = await blip(30 * MIN, 456_789);
    expect(entryOf(store).points.map((p) => p.time)).toEqual([t0]);
    mockFetchBackfill.mockResolvedValueOnce(vole([{ tsNs, value: 7 }]));
    const ws2 = reconnect();
    ws2.open();
    expect(lastFromNs()).toBeLessThan(tsNs);
    ws2.message(initial({ [PV]: { ...pvValue(PV, 7, t0), tsNs } }));
    await vi.advanceTimersByTimeAsync(0);

    const entry = entryOf(store);
    expect(entry.breaks).toEqual([]);
    expect(entry.points.map((p) => p.time)).toEqual([t0]);
  });

  it('drops the break when a backfill clamped to the retention window covers it', async () => {
    // Retention 5 min, last change 10 min back: `from` is now - 5 min, where
    // Vole pins the held value.
    const { store, t0, reconnect } = await blip(5 * MIN);
    const pending = deferred<VoleSeriesDTO>();
    mockFetchBackfill.mockReturnValueOnce(pending.promise);
    const ws2 = reconnect();
    ws2.open();
    const fromMs = Date.now() - 5 * MIN;
    expect(lastFromNs()).toBe(fromMs * 1e6);
    ws2.message(initial({ [PV]: pvValue(PV, 7, t0) }));
    pending.resolve(pinned(7));
    await vi.advanceTimersByTimeAsync(0);

    const entry = entryOf(store);
    expect(entry.breaks).toEqual([]);
    expect(entry.points.map((p) => [p.time, p.value])).toEqual([
      [t0, 7],
      [fromMs, 7],
    ]);
  });

  it.each([
    ['fails', () => mockFetchBackfill.mockRejectedValueOnce(new Error('network down'))],
    [
      'is refused (pv_not_buffered)',
      () =>
        mockFetchBackfill.mockRejectedValueOnce(
          new CanopyError('pv_not_buffered', 404, 'not buffered')
        ),
    ],
    ['is empty', () => mockFetchBackfill.mockResolvedValueOnce(vole([]))],
    [
      'starts after `from` (a buffer started since)',
      () =>
        mockFetchBackfill.mockImplementationOnce(async (_pv, fromNs) =>
          vole([{ tsNs: fromNs + 60_000 * 1e6, value: 7 }])
        ),
    ],
  ])('keeps the break when the backfill %s', async (_name, mockBackfill) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { store, t0, tDrop, reconnect } = await blip();
    mockBackfill();
    const ws2 = reconnect();
    ws2.open();
    ws2.message(initial({ [PV]: pvValue(PV, 7, t0) }));
    await vi.advanceTimersByTimeAsync(0);

    expect(entryOf(store).breaks).toEqual([tDrop]);
    warn.mockRestore();
  });

  it('keeps the break of an outage longer than the retention window', async () => {
    const { store, t0, tDrop, reconnect } = await blip(5 * MIN);
    // Two hours asleep: `from` (now - 5 min) is after the disconnect.
    vi.setSystemTime(tDrop + 2 * 60 * MIN);
    const ws2 = reconnect();
    mockFetchBackfill.mockImplementationOnce(async (_pv, fromNs) =>
      vole([{ tsNs: fromNs, value: 7 }])
    );
    ws2.open();
    ws2.message(initial({ [PV]: pvValue(PV, 7, t0) }));
    await vi.advanceTimersByTimeAsync(0);

    expect(entryOf(store).breaks).toEqual([tDrop]);
  });

  it('settles a break once: a later covering backfill drops only its own outage', async () => {
    const { store, t0, tDrop, reconnect } = await blip();
    const ws2 = reconnect();
    ws2.open(); // the default empty backfill covers nothing
    ws2.message(initial({ [PV]: pvValue(PV, 7, t0) }));
    await vi.advanceTimersByTimeAsync(0);

    vi.setSystemTime(Date.now() + 5_000);
    const tDrop2 = Date.now();
    ws2.close(1006);
    expect(entryOf(store).breaks).toEqual([tDrop, tDrop2]);

    mockFetchBackfill.mockImplementationOnce(async (_pv, fromNs) =>
      vole([{ tsNs: fromNs, value: 7 }])
    );
    const ws3 = reconnect();
    ws3.open();
    ws3.message(initial({ [PV]: pvValue(PV, 7, t0) }));
    await vi.advanceTimersByTimeAsync(0);

    // Its window (from t0) spans both, but the first was settled already.
    expect(entryOf(store).breaks).toEqual([tDrop]);
  });

  it('keeps the break of a PV that went down at the IOC, through a covering backfill', async () => {
    const { store, instances } = setup();
    store.watch('t1', PV, 30 * MIN);
    const ws = instances[0];
    ws.open();
    const t0 = Date.now() - 10 * MIN;
    ws.message(initial({ [PV]: pvValue(PV, 7, t0) }));
    await vi.advanceTimersByTimeAsync(0);

    // The IOC goes away on an open socket, then comes back unchanged.
    vi.setSystemTime(Date.now() + 5_000);
    const tDown = Date.now();
    ws.message(diff({ [PV]: { ...pvValue(PV, null, t0), connected: false } }));
    vi.setSystemTime(Date.now() + 5_000);
    ws.message(diff({ [PV]: pvValue(PV, 7, t0) }));

    // Then the socket blips, and Vole covers the whole window from t0.
    vi.setSystemTime(Date.now() + 5_000);
    const tDrop = Date.now();
    ws.close(1006);
    expect(entryOf(store).breaks).toEqual([tDown, tDrop]);
    mockFetchBackfill.mockImplementationOnce(async (_pv, fromNs) =>
      vole([{ tsNs: fromNs, value: 7 }])
    );
    vi.advanceTimersByTime(1_000);
    const ws2 = instances[1];
    ws2.open();
    expect(lastFromNs()).toBe(t0 * 1e6);
    ws2.message(initial({ [PV]: pvValue(PV, 7, t0) }));
    await vi.advanceTimersByTimeAsync(0);

    // Only the socket's break goes; Vole can't show the IOC outage.
    expect(entryOf(store).breaks).toEqual([tDown]);
  });

  describe('resumes', () => {
    it('records one per kept break: the first connected update, at its receipt time', async () => {
      const { store, t0, tDrop, reconnect } = await blip();
      const ws2 = reconnect();
      const tBack = Date.now();
      ws2.open();
      ws2.message(initial({ [PV]: pvValue(PV, 7, t0) }));
      await vi.advanceTimersByTimeAsync(0);
      // A later update records no second one.
      vi.setSystemTime(Date.now() + 5_000);
      ws2.message(diff({ [PV]: pvValue(PV, 7, t0) }));

      const entry = entryOf(store);
      expect(entry.resumes).toEqual([{ after: tDrop, time: tBack, value: 7 }]);
      // Not a sample.
      expect(entry.points).toEqual([{ time: t0, value: 7, severity: 'NO_ALARM' }]);
    });

    it('records none when the cover settles first (Vole before Hare)', async () => {
      const { store, t0, reconnect } = await blip();
      mockFetchBackfill.mockImplementationOnce(async (_pv, fromNs) =>
        vole([{ tsNs: fromNs, value: 7 }])
      );
      const ws2 = reconnect();
      ws2.open();
      await vi.advanceTimersByTimeAsync(0);
      ws2.message(initial({ [PV]: pvValue(PV, 7, t0) }));

      const entry = entryOf(store);
      expect(entry.breaks).toEqual([]);
      expect(entry.resumes).toEqual([]);
    });

    it('waits past an update with no value for the first one with a value', async () => {
      const { store, t0, tDrop, reconnect } = await blip();
      const ws2 = reconnect();
      ws2.open();
      // Hare reopened the monitor: first no value, then the unchanged one.
      ws2.message(initial({ [PV]: pvValue(PV, null, t0) }));
      await vi.advanceTimersByTimeAsync(0);
      expect(entryOf(store).resumes).toEqual([]);

      vi.setSystemTime(Date.now() + 2_000);
      const tValue = Date.now();
      ws2.message(diff({ [PV]: pvValue(PV, 7, t0) }));
      const entry = entryOf(store);
      expect(entry.breaks).toEqual([tDrop]);
      expect(entry.points.map((p) => p.time)).toEqual([t0]);
      expect(entry.resumes).toEqual([{ after: tDrop, time: tValue, value: 7 }]);
    });

    it('takes the value of a later sample stamped before the break', async () => {
      const { store, t0, tDrop, reconnect } = await blip();
      const ws2 = reconnect();
      const tBack = Date.now();
      ws2.open();
      ws2.message(initial({ [PV]: pvValue(PV, 7, t0) }));
      // An IOC clock behind: a change after the reconnect stamped before the break.
      ws2.message(diff({ [PV]: pvValue(PV, 8, tDrop - 1_000) }));
      expect(entryOf(store).resumes).toEqual([{ after: tDrop, time: tBack, value: 8 }]);

      // Once a sample lands after the break, the resume's value is left alone.
      vi.setSystemTime(Date.now() + 5_000);
      ws2.message(diff({ [PV]: pvValue(PV, 9, Date.now()) }));
      ws2.message(diff({ [PV]: pvValue(PV, 10, tDrop - 500) }));
      expect(entryOf(store).resumes).toEqual([{ after: tDrop, time: tBack, value: 8 }]);
    });

    it('resumes a PV still down at reconnect when it comes back', async () => {
      const { store, t0, tDrop, reconnect } = await blip();
      const ws2 = reconnect();
      ws2.open();
      ws2.message(initial({ [PV]: { ...pvValue(PV, null, t0), connected: false } }));
      await vi.advanceTimersByTimeAsync(0);
      expect(entryOf(store).resumes).toEqual([]);

      vi.setSystemTime(Date.now() + 20_000);
      const tUp = Date.now();
      ws2.message(diff({ [PV]: pvValue(PV, 7, t0) }));
      expect(entryOf(store).resumes).toEqual([{ after: tDrop, time: tUp, value: 7 }]);
    });

    it('goes with its break when retention trims it', async () => {
      const { store, t0, tDrop, reconnect } = await blip();
      const ws2 = reconnect();
      ws2.open();
      ws2.message(initial({ [PV]: pvValue(PV, 7, t0) }));
      await vi.advanceTimersByTimeAsync(0);
      vi.setSystemTime(Date.now() + 5_000);
      const t1 = Date.now();
      ws2.message(diff({ [PV]: pvValue(PV, 8, t1) }));
      expect(entryOf(store).resumes).toHaveLength(1);

      // 1 min retention: t0 goes, so the break before t1 has nothing to separate.
      store.watch('t1', PV, 60_000);
      const entry = entryOf(store);
      expect(entry.points.map((p) => p.time)).toEqual([t1]);
      expect(entry.breaks).toEqual([]);
      expect(entry.resumes).toEqual([]);
      expect(tDrop).toBeLessThan(t1);
    });
  });

  it.each([
    ['before', true],
    ['after', false],
  ])(
    'keeps the break of a PV still down when the socket comes back (Hare %s Vole)',
    async (_name, hareFirst) => {
      const { store, t0, tDrop, reconnect } = await blip();
      mockFetchBackfill.mockImplementationOnce(async (_pv, fromNs) =>
        vole([{ tsNs: fromNs, value: 7 }])
      );
      const ws2 = reconnect();
      ws2.open();
      const down = initial({ [PV]: { ...pvValue(PV, null, t0), connected: false } });
      if (hareFirst) ws2.message(down);
      await vi.advanceTimersByTimeAsync(0);
      if (!hareFirst) ws2.message(down);
      expect(entryOf(store).breaks).toEqual([tDrop]);

      // Back at the IOC later: the break still stands.
      vi.setSystemTime(Date.now() + 5_000);
      ws2.message(diff({ [PV]: pvValue(PV, 9, Date.now()) }));
      const entry = entryOf(store);
      expect(entry.breaks).toEqual([tDrop]);
      expect(entry.points.map((p) => p.value)).toEqual([7, 9]);
    }
  );
});

describe('LiveStore retention in place', () => {
  type Ws = ReturnType<typeof setup>['instances'][number];
  function fill(ws: Ws, pv: string, times: number[]): void {
    for (const [i, t] of times.entries()) ws.message(diff({ [pv]: pvValue(pv, i, t) }, t));
  }

  it('a retention change keeps the buffer and sends no frame', () => {
    const { store, instances } = setup();
    store.watch('t1', 'RET', 60_000);
    const ws = instances[0];
    ws.open();
    const t0 = Date.now();
    fill(ws, 'RET', [t0 - 30_000, t0 - 20_000, t0 - 10_000, t0]);
    const before = store.getSnapshot().get('t1')!.points;
    expect(before).toHaveLength(4);
    const sentBefore = ws.sent.length;

    store.watch('t1', 'RET', 600_000);
    expect(ws.sent).toHaveLength(sentBefore);
    expect(store.retentionOf('t1')).toBe(600_000);
    expect(store.getSnapshot().get('t1')!.points).toBe(before);
    expect(store.getSnapshot().get('t1')!.points).toHaveLength(4);
    // Samples keep arriving into the same buffer.
    fill(ws, 'RET', [t0 + 1]);
    expect(store.getSnapshot().get('t1')!.points).toHaveLength(5);
    expect(ws.sent).toHaveLength(sentBefore);
    expect(instances).toHaveLength(1);
  });

  it('an explicit lower value trims the buffer at once, without a frame', () => {
    const { store, instances } = setup();
    store.watch('t1', 'RET', 60_000);
    const ws = instances[0];
    ws.open();
    const t0 = Date.now();
    fill(ws, 'RET', [t0 - 50_000, t0 - 40_000, t0 - 5_000, t0]);
    const sentBefore = ws.sent.length;

    store.watch('t1', 'RET', resolveLiveRetentionMs(10_000, store.retentionOf('t1'), 3_600_000));
    expect(store.retentionOf('t1')).toBe(10_000);
    expect(
      store
        .getSnapshot()
        .get('t1')!
        .points.map((p) => p.time)
    ).toEqual([t0 - 5_000, t0]);
    expect(ws.sent).toHaveLength(sentBefore);
  });

  it('a lower retention on one trace does not trim a PV another trace keeps longer', () => {
    const { store, instances } = setup();
    store.watch('t1', 'RET', 60_000);
    store.watch('t2', 'RET', 60_000);
    const ws = instances[0];
    ws.open();
    const t0 = Date.now();
    fill(ws, 'RET', [t0 - 50_000, t0]);
    store.watch('t1', 'RET', 1_000);
    expect(store.getSnapshot().get('t2')!.points).toHaveLength(2);
  });

  it('a narrowed range keeps the previous automatic retention', () => {
    const { store, instances } = setup();
    store.watch('t1', 'RET', resolveLiveRetentionMs(undefined, store.retentionOf('t1'), 600_000));
    expect(store.retentionOf('t1')).toBe(600_000);
    const ws = instances[0];
    ws.open();
    const t0 = Date.now();
    fill(ws, 'RET', [t0 - 500_000, t0 - 100_000, t0]);
    const sentBefore = ws.sent.length;

    // The range narrows to 1 min: automatic retention stays at 10 min.
    store.watch('t1', 'RET', resolveLiveRetentionMs(undefined, store.retentionOf('t1'), 60_000));
    expect(store.retentionOf('t1')).toBe(600_000);
    expect(store.getSnapshot().get('t1')!.points).toHaveLength(3);
    // A wider range raises it, capped at the maximum.
    store.watch(
      't1',
      'RET',
      resolveLiveRetentionMs(undefined, store.retentionOf('t1'), 86_400_000)
    );
    expect(store.retentionOf('t1')).toBe(LIVE_RETENTION_MAX_MS);
    expect(ws.sent).toHaveLength(sentBefore);
  });

  it('re-adding the curve starts from the derived value', () => {
    const { store } = setup();
    store.watch('t1', 'RET', resolveLiveRetentionMs(undefined, undefined, 1_200_000));
    store.watch('t1', 'RET', resolveLiveRetentionMs(undefined, store.retentionOf('t1'), 60_000));
    expect(store.retentionOf('t1')).toBe(1_200_000);

    store.release('t1');
    expect(store.retentionOf('t1')).toBeUndefined();
    store.watch('t1', 'RET', resolveLiveRetentionMs(undefined, store.retentionOf('t1'), 60_000));
    expect(store.retentionOf('t1')).toBe(60_000);
  });
});

describe('resolveLiveRetentionMs', () => {
  it('derives from the range span, capped at the maximum', () => {
    expect(resolveLiveRetentionMs(undefined, undefined, 3_600_000)).toBe(LIVE_RETENTION_MAX_MS);
    expect(resolveLiveRetentionMs(undefined, undefined, 60_000)).toBe(60_000);
  });

  it('is non-decreasing: max(previous, derived)', () => {
    expect(resolveLiveRetentionMs(undefined, 600_000, 60_000)).toBe(600_000);
    expect(resolveLiveRetentionMs(undefined, 60_000, 600_000)).toBe(600_000);
  });

  it('an explicit value wins, lower or higher', () => {
    expect(resolveLiveRetentionMs(5_000, 600_000, 600_000)).toBe(5_000);
    expect(resolveLiveRetentionMs(900_000, 60_000, 60_000)).toBe(900_000);
  });

  it('derives the default when the span is unknown', () => {
    expect(resolveLiveRetentionMs(undefined, undefined, undefined)).toBe(LIVE_RETENTION_DEFAULT_MS);
    expect(resolveLiveRetentionMs(undefined, undefined, Number.NaN)).toBe(
      LIVE_RETENTION_DEFAULT_MS
    );
  });
});
