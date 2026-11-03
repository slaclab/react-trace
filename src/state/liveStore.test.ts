import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeWebSocketFactory } from '@slaclab/canopy-client/testing';
import type {
  HareAlarmSeverity,
  PVValueDTO,
  WebSocketFactory,
  WireAlarmSeverity,
} from '@slaclab/canopy-client';
import { LiveStore } from './liveStore';

const BASE_URL = 'http://canopy.test';
const HARE_URL = 'ws://canopy.test/hare/v1/ws/pvs';
const WS_CLOSED = 3;

function setup(factory?: WebSocketFactory) {
  const fake = createFakeWebSocketFactory();
  const store = new LiveStore({
    connection: { baseUrl: BASE_URL },
    webSocketFactory: factory ?? fake.factory,
  });
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

// Hare sends per-PV metadata alongside the first values; trace doesn't use it.
function initial(data: Record<string, PVValueDTO>) {
  return { type: 'initial', data, meta: {}, count: Object.keys(data).length };
}

function diff(data: Record<string, PVValueDTO>, timestamp = Date.now()) {
  return { type: 'diff', data, count: Object.keys(data).length, timestamp };
}

function point(time: number, value: number, severity: WireAlarmSeverity = 'NO_ALARM') {
  return { time, value, severity };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-06-05T12:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('LiveStore', () => {
  it('connects lazily to Hare and subscribes once the socket opens', () => {
    const { store, instances } = setup();
    expect(instances).toHaveLength(0);

    store.watch('t1', 'TEST:SINE', 60_000);

    expect(instances).toHaveLength(1);
    const ws = instances[0];
    expect(ws.url).toBe(HARE_URL);
    // Pre-open: nothing sent (it would fail on a real socket).
    expect(ws.sent).toEqual([]);
    expect(store.getSnapshot().get('t1')!.status).toBe('connecting');

    ws.open();

    expect(ws.parsedSent()).toEqual([{ type: 'subscribe', pvNames: ['TEST:SINE'] }]);
    expect(store.getSnapshot().get('t1')!.status).toBe('connected');
  });

  it('appends numeric samples and exposes them through the snapshot', () => {
    const { store, instances } = setup();
    store.watch('t1', 'TEST:SINE', 60_000);
    const ws = instances[0];
    ws.open();

    const tsMs = Date.now();
    ws.message(initial({ 'TEST:SINE': pvValue('TEST:SINE', 1.5, tsMs) }));

    const entry = store.getSnapshot().get('t1');
    expect(entry).toBeDefined();
    expect(entry!.connected).toBe(true);
    expect(entry!.severity).toBe('NO_ALARM');
    expect(entry!.points).toEqual([point(tsMs, 1.5)]);

    ws.message(diff({ 'TEST:SINE': pvValue('TEST:SINE', 2.25, tsMs + 100) }, tsMs + 100));
    expect(store.getSnapshot().get('t1')!.points).toEqual([
      point(tsMs, 1.5),
      point(tsMs + 100, 2.25),
    ]);
  });

  it('retains per-sample severity on each buffered point', () => {
    const { store, instances } = setup();
    store.watch('t1', 'SEV', 60_000);
    const ws = instances[0];
    ws.open();

    const tsMs = Date.now();
    ws.message(initial({ SEV: pvValue('SEV', 1, tsMs, 'MINOR') }));
    ws.message(diff({ SEV: pvValue('SEV', 2, tsMs + 100, 'MAJOR') }));
    ws.message(diff({ SEV: pvValue('SEV', 3, tsMs + 200, 'INVALID') }));

    // Each point keeps the severity reported with it, not just the PV's latest.
    expect(store.getSnapshot().get('t1')!.points).toEqual([
      point(tsMs, 1, 'MINOR'),
      point(tsMs + 100, 2, 'MAJOR'),
      point(tsMs + 200, 3, 'INVALID'),
    ]);
    expect(store.getSnapshot().get('t1')!.severity).toBe('INVALID');
  });

  it('refcounts subscriptions across traces sharing one PV', async () => {
    const { store, instances } = setup();
    store.watch('t1', 'FOO', 60_000);
    store.watch('t2', 'FOO', 60_000);
    const ws = instances[0];
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

  it('delivers one sample per update to every trace on a shared PV', () => {
    const { store, instances } = setup();
    store.watch('t1', 'FOO', 60_000);
    store.watch('t2', 'FOO', 60_000);
    const ws = instances[0];
    ws.open();

    const tsMs = Date.now();
    ws.message(initial({ FOO: pvValue('FOO', 1, tsMs) }));

    const snap = store.getSnapshot();
    expect(snap.get('t1')!.points).toEqual([point(tsMs, 1)]);
    expect(snap.get('t2')!.points).toBe(snap.get('t1')!.points);
  });

  it('evicts samples older than the longest active retention once slack is exceeded', () => {
    const { store, instances } = setup();
    store.watch('t1', 'BAR', 1_000); // 1s retention
    const ws = instances[0];
    ws.open();

    const t0 = Date.now();
    // Push a batch of stale samples all timestamped at t0. Eviction is batched
    // (deferred until the buffer overshoots the window by a slack margin), so
    // we push well past that margin to force a trim pass.
    const STALE = 300;
    for (let i = 0; i < STALE; i++) {
      ws.message(diff({ BAR: pvValue('BAR', i, t0) }, t0));
    }
    expect(store.getSnapshot().get('t1')!.points).toHaveLength(STALE);

    // Advance past the retention window, then push enough fresh samples to
    // cross the slack threshold and trigger eviction of the stale batch.
    vi.setSystemTime(new Date(t0 + 1_500));
    const FRESH = 300;
    for (let i = 0; i < FRESH; i++) {
      ws.message(diff({ BAR: pvValue('BAR', 1000 + i, t0 + 1_500) }, t0 + 1_500));
    }
    const points = store.getSnapshot().get('t1')!.points;
    // The t0 batch is older than 1s and has been evicted; only the fresh
    // samples (all at t0 + 1_500) remain.
    expect(points).toHaveLength(FRESH);
    expect(points.every((p) => p.time === t0 + 1_500)).toBe(true);
  });

  it('marks PVs disconnected on socket close and re-subscribes on reopen', () => {
    const { store, instances } = setup();
    store.watch('t1', 'BAZ', 60_000);
    const ws = instances[0];
    ws.open();
    ws.message(initial({ BAZ: pvValue('BAZ', 7, Date.now(), 'MINOR') }));
    expect(store.getSnapshot().get('t1')!.connected).toBe(true);

    ws.close(1006);
    const entry = store.getSnapshot().get('t1')!;
    expect(entry.status).toBe('disconnected');
    expect(entry.connected).toBe(false);
    // Buffer is preserved so the chart doesn't blank during reconnect, and the
    // service's "disconnected" update with the stale value adds no sample.
    expect(entry.points).toEqual([point(Date.now(), 7, 'MINOR')]);
    expect(entry.severity).toBe('MINOR');

    // Backoff: first reconnect attempt fires after 1s.
    vi.advanceTimersByTime(999);
    expect(instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(instances).toHaveLength(2);
    const ws2 = instances[1];
    ws2.open();

    // On reopen the store re-subscribes everything currently watched.
    expect(ws2.parsedSent()).toEqual([{ type: 'subscribe', pvNames: ['BAZ'] }]);
  });

  it('adds no sample for a PV that Hare reports disconnected', () => {
    const { store, instances } = setup();
    store.watch('t1', 'GONE', 60_000);
    const ws = instances[0];
    ws.open();

    const tsMs = Date.now();
    ws.message(initial({ GONE: pvValue('GONE', 4, tsMs) }));
    // The IOC goes away: value null, connected false. The SDK hands that on
    // with value 0, which must not reach the chart.
    ws.message(
      diff({
        GONE: { ...pvValue('GONE', null, tsMs + 100, 'INVALID'), connected: false },
      })
    );

    const entry = store.getSnapshot().get('t1')!;
    expect(entry.connected).toBe(false);
    expect(entry.points).toEqual([point(tsMs, 4)]);
    expect(entry.status).toBe('connected');
  });

  it('skips non-numeric values for the points buffer but updates `latest`', () => {
    const { store, instances } = setup();
    store.watch('t1', 'STR', 60_000);
    const ws = instances[0];
    ws.open();
    ws.message(initial({ STR: pvValue('STR', 'OPERATIONAL', Date.now()) }));
    const entry = store.getSnapshot().get('t1')!;
    expect(entry.latest?.value).toBe('OPERATIONAL');
    expect(entry.connected).toBe(true);
    expect(entry.points).toEqual([]);
  });

  it('surfaces ws error frames on the entry and clears them on a clean reopen', () => {
    const { store, instances } = setup();
    store.watch('t1', 'ERR', 60_000);
    const ws = instances[0];
    ws.open();
    expect(store.getSnapshot().get('t1')!.error).toBeNull();

    ws.message({ type: 'error', code: 'BACKEND_DOWN', message: 'archiver unreachable' });
    expect(store.getSnapshot().get('t1')!.error).toEqual({
      code: 'BACKEND_DOWN',
      message: 'archiver unreachable',
    });

    // A clean reconnect clears the error.
    ws.close(1006);
    vi.advanceTimersByTime(1_000);
    const ws2 = instances[1];
    ws2.open();
    expect(store.getSnapshot().get('t1')!.error).toBeNull();
  });

  it('reports a socket that cannot be created and retries with backoff', () => {
    const fake = createFakeWebSocketFactory();
    let failNext = true;
    const { store } = setup((url) => {
      if (failNext) {
        failNext = false;
        throw new Error('blocked');
      }
      return fake.factory(url);
    });

    store.watch('t1', 'X', 60_000);
    const entry = store.getSnapshot().get('t1')!;
    expect(entry.status).toBe('disconnected');
    expect(entry.error).toEqual({
      code: 'ws_connect_failed',
      message: 'Could not open live connection: blocked',
    });

    vi.advanceTimersByTime(1_000);
    expect(fake.instances).toHaveLength(1);
    fake.instances[0].open();
    expect(store.getSnapshot().get('t1')!.error).toBeNull();
  });

  it('pings the server and reconnects when nothing comes back', () => {
    const { store, instances } = setup();
    store.watch('t1', 'PING', 60_000);
    const ws = instances[0];
    ws.open();
    ws.message(initial({ PING: pvValue('PING', 1, Date.now()) }));

    vi.advanceTimersByTime(15_000);
    expect(ws.parsedSent()).toContainEqual({ type: 'ping' });

    // No pong (or any frame) within 10s: the socket is treated as dead.
    vi.advanceTimersByTime(10_000);
    expect(ws.readyState).toBe(WS_CLOSED);
    expect(store.getSnapshot().get('t1')!.status).toBe('disconnected');

    vi.advanceTimersByTime(1_000);
    expect(instances).toHaveLength(2);
  });

  it('closes the socket when the last trace is released and reopens on the next watch', () => {
    const { store, instances } = setup();
    store.watch('t1', 'IDLE', 60_000);
    const ws = instances[0];
    ws.open();

    store.release('t1');
    expect(ws.readyState).toBe(WS_CLOSED);
    expect(store.getSnapshot().size).toBe(0);

    // Nothing is watched, so nothing reconnects.
    vi.advanceTimersByTime(60_000);
    expect(instances).toHaveLength(1);

    store.watch('t2', 'IDLE', 60_000);
    expect(instances).toHaveLength(2);
    instances[1].open();
    expect(instances[1].parsedSent()).toEqual([{ type: 'subscribe', pvNames: ['IDLE'] }]);
  });

  it('keeps the socket open when a trace switches PV', async () => {
    const { store, instances } = setup();
    store.watch('t1', 'OLD', 60_000);
    const ws = instances[0];
    ws.open();

    store.watch('t1', 'NEW', 60_000);
    // Subscribe/unsubscribe frames go out at the end of the tick.
    await Promise.resolve();

    expect(instances).toHaveLength(1);
    expect(ws.readyState).not.toBe(WS_CLOSED);
    expect(ws.parsedSent()).toEqual([
      { type: 'subscribe', pvNames: ['OLD'] },
      { type: 'unsubscribe', pvNames: ['OLD'] },
      { type: 'subscribe', pvNames: ['NEW'] },
    ]);
  });

  it('reuses the same entry reference when a PV is unchanged between frames', () => {
    const { store, instances } = setup();
    store.watch('t1', 'AAA', 60_000);
    store.watch('t2', 'BBB', 60_000);
    const ws = instances[0];
    ws.open();

    const t0 = Date.now();
    ws.message(initial({ AAA: pvValue('AAA', 1, t0), BBB: pvValue('BBB', 1, t0) }));
    const first = store.getSnapshot();
    const aBefore = first.get('t1')!;
    const bBefore = first.get('t2')!;

    // A frame touching only AAA should leave BBB's entry object identical, so
    // downstream React.memo / shallow checks for the BBB trace short-circuit.
    ws.message(diff({ AAA: pvValue('AAA', 2, t0 + 100) }, t0 + 100));
    const second = store.getSnapshot();
    expect(second.get('t1')).not.toBe(aBefore); // AAA changed -> new entry
    expect(second.get('t2')).toBe(bBefore); // BBB unchanged -> same entry
  });

  it('getEntrySnapshot returns one trace and stays ref-stable when unrelated traces change', () => {
    const { store, instances } = setup();
    store.watch('t1', 'AAA', 60_000);
    store.watch('t2', 'BBB', 60_000);
    const ws = instances[0];
    ws.open();

    const t0 = Date.now();
    ws.message(initial({ AAA: pvValue('AAA', 1, t0), BBB: pvValue('BBB', 1, t0) }));

    const bBefore = store.getEntrySnapshot('t2');
    expect(bBefore?.pv).toBe('BBB');

    // A frame touching only AAA leaves t2's entry reference identical, so a
    // consumer subscribed via getEntrySnapshot('t2') can bail its re-render.
    ws.message(diff({ AAA: pvValue('AAA', 2, t0 + 100) }, t0 + 100));
    expect(store.getEntrySnapshot('t2')).toBe(bBefore); // unchanged -> same ref
    expect(store.getEntrySnapshot('t1')).not.toBe(bBefore);
    expect(store.getEntrySnapshot('missing')).toBeUndefined();
  });
});
