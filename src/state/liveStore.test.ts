import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveStore } from './liveStore';
import type { PVValueDTO } from '../api/types';

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
    expect(entry!.points).toEqual([{ time: tsMs, value: 1.5 }]);

    ws.emit({
      type: 'diff',
      data: { 'TEST:SINE': pvValue('TEST:SINE', 2.25, tsMs + 100) },
      count: 1,
      timestamp: tsMs + 100,
    });
    expect(store.getSnapshot().get('t1')!.points).toEqual([
      { time: tsMs, value: 1.5 },
      { time: tsMs + 100, value: 2.25 },
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
});
