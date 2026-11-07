import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeWebSocketFactory, type FakeWebSocket } from '@slaclab/canopy-client/testing';
import type { HareAlarmSeverity, PVValueDTO, WebSocketFactory } from '@slaclab/canopy-client';
import { LiveStore } from './liveStore';
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

  it('refcounts subscriptions across traces sharing one PV', () => {
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
    // Last subscriber gone -> unsubscribe.
    expect(ws.parsedSent()).toEqual([
      { type: 'subscribe', pvNames: ['FOO'] },
      { type: 'unsubscribe', pvNames: ['FOO'] },
    ]);
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

  it('keeps the socket open when a trace switches PV', () => {
    const store = newStore();
    store.watch('t1', 'OLD', 60_000);
    const ws = fake.instances[0];
    ws.open();

    store.watch('t1', 'NEW', 60_000);

    expect(fake.instances).toHaveLength(1);
    expect(ws.readyState).toBe(WS_OPEN);
    expect(ws.parsedSent()).toEqual([
      { type: 'subscribe', pvNames: ['OLD'] },
      { type: 'unsubscribe', pvNames: ['OLD'] },
      { type: 'subscribe', pvNames: ['NEW'] },
    ]);
  });
});
