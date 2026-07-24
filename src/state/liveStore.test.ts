import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveStore } from './liveStore';
import { CanopyError } from '../api/client';
import type { PVValueDTO, VoleSeriesDTO } from '../api/types';

vi.mock('../api/vole', () => ({
  fetchBackfill: vi.fn(),
  subscribeVoleBuffer: vi.fn(),
}));

import { fetchBackfill, subscribeVoleBuffer } from '../api/vole';
const mockFetchBackfill = vi.mocked(fetchBackfill);
const mockSubscribeVole = vi.mocked(subscribeVoleBuffer);

// Minimal hand-rolled WebSocket mock. We avoid pulling in a dep; the live
// store only uses readyState, send, close, and the four event handlers.
class MockWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  url: string;
  readyState = 0;
  sent: string[] = [];
  onopen: ((this: MockWebSocket) => void) | null = null;
  onmessage: ((this: MockWebSocket, ev: { data: string }) => void) | null = null;
  onclose: ((this: MockWebSocket) => void) | null = null;
  onerror: ((this: MockWebSocket) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === MockWebSocket.CLOSED) return;
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.call(this);
  }

  // Test helpers ---------------------------------------------------------
  open(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.call(this);
  }

  emit(frame: unknown): void {
    this.onmessage?.call(this, { data: JSON.stringify(frame) });
  }

  parsedSent(): unknown[] {
    return this.sent.map((s) => JSON.parse(s));
  }
}

function pvValue(pv: string, value: number, tsMs: number): PVValueDTO {
  return {
    pv,
    value,
    severity: 'NO_ALARM',
    tsNs: tsMs * 1_000_000,
    connected: true,
    units: null,
    precision: null,
    error: null,
  };
}

const realWebSocket = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;

beforeEach(() => {
  MockWebSocket.instances = [];
  (globalThis as unknown as { WebSocket: typeof MockWebSocket }).WebSocket = MockWebSocket;
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-06-05T12:00:00Z'));
  mockFetchBackfill.mockResolvedValue({ pv: '', count: 0, samples: [] });
  mockSubscribeVole.mockResolvedValue({ subscribed: [] });
});

afterEach(() => {
  vi.useRealTimers();
  if (realWebSocket) {
    (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = realWebSocket;
  } else {
    delete (globalThis as { WebSocket?: unknown }).WebSocket;
  }
});

describe('LiveStore', () => {
  it('connects lazily and sends a subscribe frame after the socket opens', () => {
    const store = new LiveStore();
    store.watch('t1', 'TEST:SINE', 60_000);

    expect(MockWebSocket.instances).toHaveLength(1);
    const ws = MockWebSocket.instances[0];
    // Pre-open: no subscribes were sent (would have errored on a real socket).
    expect(ws.sent).toEqual([]);

    ws.open();

    expect(ws.parsedSent()).toEqual([{ type: 'subscribe', pvNames: ['TEST:SINE'] }]);
  });

  it('appends numeric samples and exposes them through the snapshot', () => {
    const store = new LiveStore();
    store.watch('t1', 'TEST:SINE', 60_000);
    const ws = MockWebSocket.instances[0];
    ws.open();

    const tsMs = Date.now();
    ws.emit({
      type: 'initial',
      data: { 'TEST:SINE': pvValue('TEST:SINE', 1.5, tsMs) },
      count: 1,
    });

    const entry = store.getSnapshot().get('t1');
    expect(entry).toBeDefined();
    expect(entry!.connected).toBe(true);
    expect(entry!.severity).toBe('NO_ALARM');
    expect(entry!.points).toEqual([{ time: tsMs, value: 1.5, severity: 'NO_ALARM' }]);

    ws.emit({
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
    const store = new LiveStore();
    store.watch('t1', 'SEV', 60_000);
    const ws = MockWebSocket.instances[0];
    ws.open();

    const tsMs = Date.now();
    ws.emit({
      type: 'initial',
      data: { SEV: { ...pvValue('SEV', 1, tsMs), severity: 'MINOR' } },
      count: 1,
    });
    ws.emit({
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
    const store = new LiveStore();
    store.watch('t1', 'FOO', 60_000);
    store.watch('t2', 'FOO', 60_000);
    const ws = MockWebSocket.instances[0];
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
    const store = new LiveStore();
    store.watch('t1', 'BAR', 1_000); // 1s retention
    const ws = MockWebSocket.instances[0];
    ws.open();

    const t0 = Date.now();
    // Push a batch of stale samples all timestamped at t0. Eviction is batched
    // (deferred until the buffer overshoots the window by a slack margin), so
    // we push well past that margin to force a trim pass.
    const STALE = 300;
    for (let i = 0; i < STALE; i++) {
      ws.emit({
        type: 'diff',
        data: { BAR: pvValue('BAR', i, t0) },
        count: 1,
        timestamp: t0,
      });
    }
    expect(store.getSnapshot().get('t1')!.points).toHaveLength(STALE);

    // Advance past the retention window, then push enough fresh samples to
    // cross the slack threshold and trigger eviction of the stale batch.
    vi.setSystemTime(new Date(t0 + 1_500));
    const FRESH = 300;
    for (let i = 0; i < FRESH; i++) {
      ws.emit({
        type: 'diff',
        data: { BAR: pvValue('BAR', 1000 + i, t0 + 1_500) },
        count: 1,
        timestamp: t0 + 1_500,
      });
    }
    const points = store.getSnapshot().get('t1')!.points;
    // The t0 batch is older than 1s and has been evicted; only the fresh
    // samples (all at t0 + 1_500) remain.
    expect(points).toHaveLength(FRESH);
    expect(points.every((p) => p.time === t0 + 1_500)).toBe(true);
  });

  it('marks PVs disconnected on socket close and re-subscribes on reopen', () => {
    const store = new LiveStore();
    store.watch('t1', 'BAZ', 60_000);
    const ws = MockWebSocket.instances[0];
    ws.open();
    ws.emit({
      type: 'initial',
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
    expect(MockWebSocket.instances).toHaveLength(2);
    const ws2 = MockWebSocket.instances[1];
    ws2.open();

    // On reopen the store re-subscribes everything currently watched.
    expect(ws2.parsedSent()).toEqual([{ type: 'subscribe', pvNames: ['BAZ'] }]);
  });

  it('skips non-numeric values for the points buffer but updates `latest`', () => {
    const store = new LiveStore();
    store.watch('t1', 'STR', 60_000);
    const ws = MockWebSocket.instances[0];
    ws.open();
    ws.emit({
      type: 'initial',
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
    const store = new LiveStore();
    store.watch('t1', 'ERR', 60_000);
    const ws = MockWebSocket.instances[0];
    ws.open();
    expect(store.getSnapshot().get('t1')!.error).toBeNull();

    ws.emit({ type: 'error', code: 'BACKEND_DOWN', message: 'archiver unreachable' });
    expect(store.getSnapshot().get('t1')!.error).toEqual({
      code: 'BACKEND_DOWN',
      message: 'archiver unreachable',
    });

    // A clean reconnect clears the error.
    ws.close();
    vi.advanceTimersByTime(1_000);
    const ws2 = MockWebSocket.instances[1];
    ws2.open();
    expect(store.getSnapshot().get('t1')!.error).toBeNull();
  });

  it('reuses the same entry reference when a PV is unchanged between frames', () => {
    const store = new LiveStore();
    store.watch('t1', 'AAA', 60_000);
    store.watch('t2', 'BBB', 60_000);
    const ws = MockWebSocket.instances[0];
    ws.open();

    const t0 = Date.now();
    ws.emit({
      type: 'initial',
      data: { AAA: pvValue('AAA', 1, t0), BBB: pvValue('BBB', 1, t0) },
      count: 2,
    });
    const first = store.getSnapshot();
    const aBefore = first.get('t1')!;
    const bBefore = first.get('t2')!;

    // A frame touching only AAA should leave BBB's entry object identical, so
    // downstream React.memo / shallow checks for the BBB trace short-circuit.
    ws.emit({
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
    const store = new LiveStore();
    store.watch('t1', 'AAA', 60_000);
    store.watch('t2', 'BBB', 60_000);
    const ws = MockWebSocket.instances[0];
    ws.open();

    const t0 = Date.now();
    ws.emit({
      type: 'initial',
      data: { AAA: pvValue('AAA', 1, t0), BBB: pvValue('BBB', 1, t0) },
      count: 2,
    });

    const bBefore = store.getEntrySnapshot('t2');
    expect(bBefore?.pv).toBe('BBB');

    // A frame touching only AAA leaves t2's entry reference identical, so a
    // consumer subscribed via getEntrySnapshot('t2') can bail its re-render.
    ws.emit({
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

    const store = new LiveStore();
    store.watch('t1', 'PV:A', 60_000);
    const ws = MockWebSocket.instances[0];
    ws.open();

    // Push a live sample that arrives while backfill is in flight.
    ws.emit({ type: 'initial', data: { 'PV:A': pvValue('PV:A', 10, t0) }, count: 1 });

    // Let the backfill promise resolve.
    await vi.waitFor(() => {
      expect(store.getSnapshot().get('t1')!.points.length).toBe(4);
    });

    const points = store.getSnapshot().get('t1')!.points;
    expect(points[0]).toEqual({ time: t0 - 3000, value: 1 });
    expect(points[3]).toEqual({ time: t0, value: 10 });
  });

  it('deduplicates overlapping timestamps at the seam', async () => {
    const t0 = Date.now();
    mockFetchBackfill.mockResolvedValue(
      voleResponse('PV:B', [
        { tsNs: (t0 - 1000) * 1e6, value: 1 },
        { tsNs: t0 * 1e6, value: 2 },
      ])
    );

    const store = new LiveStore();
    store.watch('t1', 'PV:B', 60_000);
    const ws = MockWebSocket.instances[0];
    ws.open();

    // Live sample at the same timestamp as the last backfill sample.
    ws.emit({ type: 'initial', data: { 'PV:B': pvValue('PV:B', 2, t0) }, count: 1 });

    await vi.waitFor(() => {
      expect(store.getSnapshot().get('t1')!.points.length).toBe(2);
    });

    const points = store.getSnapshot().get('t1')!.points;
    // Only the earlier sample is prepended; the overlapping one is dropped.
    expect(points).toEqual([
      { time: t0 - 1000, value: 1 },
      { time: t0, value: 2 },
    ]);
  });

  it('handles 404 gracefully (PV not buffered)', async () => {
    mockFetchBackfill.mockRejectedValue(new CanopyError('pv_not_buffered', 404, 'not buffered'));

    const store = new LiveStore();
    store.watch('t1', 'PV:C', 60_000);
    const ws = MockWebSocket.instances[0];
    ws.open();

    ws.emit({ type: 'initial', data: { 'PV:C': pvValue('PV:C', 5, Date.now()) }, count: 1 });

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

    const store = new LiveStore();
    store.watch('t1', 'PV:D', 60_000);
    const ws = MockWebSocket.instances[0];
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

    const store = new LiveStore();
    store.watch('t1', 'PV:F', 60_000);
    const ws = MockWebSocket.instances[0];
    ws.open();

    ws.emit({ type: 'initial', data: { 'PV:F': pvValue('PV:F', 1, t0) }, count: 1 });
    await vi.advanceTimersByTimeAsync(0);

    // Disconnect and reconnect after 2s.
    ws.close();
    vi.advanceTimersByTime(2000);
    vi.setSystemTime(new Date(t0 + 2000));

    // Reconnect backfill covers the gap.
    mockFetchBackfill.mockResolvedValueOnce(
      voleResponse('PV:F', [{ tsNs: (t0 + 1000) * 1e6, value: 1.5 }])
    );

    const ws2 = MockWebSocket.instances[1];
    ws2.open();

    await vi.waitFor(() => {
      expect(store.getSnapshot().get('t1')!.points.length).toBe(2);
    });

    const points = store.getSnapshot().get('t1')!.points;
    expect(points[0]).toEqual({ time: t0, value: 1 });
    expect(points[1]).toEqual({ time: t0 + 1000, value: 1.5 });

    // The fromNs passed to the reconnect backfill should be the last point's timestamp.
    const reconnectCall = mockFetchBackfill.mock.calls[mockFetchBackfill.mock.calls.length - 1];
    expect(reconnectCall[1]).toBe(t0 * 1e6);
  });
});

describe('LiveStore vole subscribe', () => {
  it('calls subscribeVoleBuffer when backfill returns 404 (pv_not_buffered)', async () => {
    mockFetchBackfill.mockRejectedValue(new CanopyError('pv_not_buffered', 404, 'not buffered'));
    mockSubscribeVole.mockClear();

    const store = new LiveStore();
    store.watch('t1', 'PV:X', 60_000);
    const ws = MockWebSocket.instances[0];
    ws.open();

    await vi.advanceTimersByTimeAsync(0);

    expect(mockSubscribeVole).toHaveBeenCalledTimes(1);
    expect(mockSubscribeVole).toHaveBeenCalledWith(['PV:X']);
  });

  it('does not call subscribeVoleBuffer when backfill succeeds', async () => {
    mockFetchBackfill.mockResolvedValue({ pv: 'PV:Y', count: 0, samples: [] });
    mockSubscribeVole.mockClear();

    const store = new LiveStore();
    store.watch('t1', 'PV:Y', 60_000);
    const ws = MockWebSocket.instances[0];
    ws.open();

    await vi.advanceTimersByTimeAsync(0);

    expect(mockSubscribeVole).not.toHaveBeenCalled();
  });

  it('does not call subscribeVoleBuffer on a generic 404', async () => {
    mockFetchBackfill.mockRejectedValue(new CanopyError('not_found', 404, 'no such route'));
    mockSubscribeVole.mockClear();

    const store = new LiveStore();
    store.watch('t1', 'PV:W', 60_000);
    const ws = MockWebSocket.instances[0];
    ws.open();

    await vi.advanceTimersByTimeAsync(0);

    expect(mockSubscribeVole).not.toHaveBeenCalled();
  });

  it('swallows errors from subscribeVoleBuffer without crashing', async () => {
    mockFetchBackfill.mockRejectedValue(new CanopyError('pv_not_buffered', 404, 'not buffered'));
    mockSubscribeVole.mockRejectedValue(new Error('network down'));

    const store = new LiveStore();
    store.watch('t1', 'PV:Z', 60_000);
    const ws = MockWebSocket.instances[0];
    ws.open();

    await vi.advanceTimersByTimeAsync(0);

    // No crash — store operates normally.
    expect(store.getSnapshot().get('t1')).toBeDefined();
  });
});
