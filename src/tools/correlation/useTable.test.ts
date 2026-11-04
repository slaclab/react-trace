// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import {
  AlarmSeverity,
  DISCONNECTED_PV,
  FormulaEngineService,
  type FormulaEngineServiceOptions,
  type FormulaEngineSubscribeOptions,
  type FormulaSpec,
  type HareConnectionStatus,
  type PVData,
  type TableResultDTO,
  type WebSocketLike,
} from '@slaclab/canopy-client';
import resultTriggerRaw from './__fixtures__/table-result-trigger.json?raw';
import { parseCorrelationQuery, type CorrelationState } from './query';
import { buildTableSpec } from './spec';
import type { HealthPVSource } from './health';
import type { PvInfo, PvModel, PvStatus } from '../shared/pvTracker';

type UseTableModule = typeof import('./useTable');
type BridgeModule = typeof import('../../embed/bridge');

// ── A fake Formula Engine server behind the real SDK service ─────────────────────────

interface Sent {
  type: string;
  id?: string;
  spec?: FormulaSpec;
  t0Ns?: number;
}

class FakeSocket implements WebSocketLike {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev?: { code?: number; reason?: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: Sent[] = [];
  private readonly outbox: unknown[] = [];
  private readonly server: FakeFox;

  constructor(server: FakeFox) {
    this.server = server;
  }

  send(data: string): void {
    const msg = JSON.parse(data) as Sent;
    if (msg.type === 'ping') {
      this.reply({ type: 'pong', timestamp: 0 });
      return;
    }
    this.sent.push(msg);
    this.server.wire.push(msg);
    this.server.onSend(this, msg);
  }

  close(): void {
    this.readyState = 3;
    this.outbox.length = 0;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  /** The server or network drops the socket, with `code` if the server closed it. */
  drop(code?: number): void {
    this.readyState = 3;
    this.outbox.length = 0;
    this.onclose?.(code === undefined ? undefined : { code });
  }

  /**
   * A server reply to a sent message. A real socket never delivers a frame
   * inside `send()`, and the SDK records an in-flight subscribe (and arms the
   * pong deadline) only after `send()` returns, so the reply waits for the
   * next timer turn or the next frame the test pushes, whichever comes first.
   */
  reply(frame: unknown): void {
    this.outbox.push(frame);
    setTimeout(() => this.flush(), 0);
  }

  receive(frame: unknown): void {
    this.flush();
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  private flush(): void {
    while (this.outbox.length > 0) {
      this.onmessage?.({ data: JSON.stringify(this.outbox.shift()) });
    }
  }
}

class FakeFox {
  readonly sockets: FakeSocket[] = [];
  /** Every non-ping message the client sent, in order. */
  readonly wire: Sent[] = [];
  /** Answer each subscribe with `subscribed` at once. */
  autoAck = true;
  private next = 0;
  /** Server ids of live subscriptions on the current socket, oldest first. */
  live: string[] = [];

  factory = (): WebSocketLike => {
    const socket = new FakeSocket(this);
    this.sockets.push(socket);
    this.live = [];
    return socket;
  };

  get socket(): FakeSocket {
    return this.sockets[this.sockets.length - 1];
  }

  onSend(socket: FakeSocket, msg: Sent): void {
    if (msg.type === 'subscribe' && this.autoAck) {
      const id = `srv-${++this.next}`;
      this.live.push(id);
      socket.reply({ type: 'subscribed', id });
    } else if (msg.type === 'unsubscribe') {
      this.live = this.live.filter((id) => id !== msg.id);
    }
  }

  get newest(): string {
    return this.live[this.live.length - 1];
  }

  result(table: TableResultDTO, id = this.newest): void {
    this.socket.receive({ type: 'result', id, data: { kind: 'table', table } });
  }

  error(code: string, message: string, retryable: boolean, id = this.newest): void {
    this.socket.receive({ type: 'error', id, code, message, retryable });
  }

  count(type: string): number {
    return this.wire.filter((m) => m.type === type).length;
  }
}

// ── Inputs ────────────────────────────────────────────────────────────────

class FakeHare implements HealthPVSource {
  status: HareConnectionStatus = 'connected';
  readonly snaps = new Map<string, PVData>();

  getSnapshot(pv: string): PVData | undefined {
    return this.snaps.get(pv);
  }

  set(pv: string, over: Partial<PVData>): void {
    this.snaps.set(pv, {
      ...DISCONNECTED_PV,
      connected: true,
      severity: AlarmSeverity.NO_ALARM,
      ...over,
    });
  }
}

function modelFor(
  state: CorrelationState,
  statuses: Record<string, PvStatus> = {},
  decided = true
): PvModel {
  const info = (pv: string): PvInfo => ({ pv, status: statuses[pv] ?? 'ok', units: '' });
  const trig = state.trigger.mode === 'pv' ? state.trigger.pv : '';
  return {
    x: state.x === '' ? null : info(state.x),
    ys: state.ys.map(info),
    trig: trig === '' ? null : info(trig),
    axisUnit: null,
    decided,
  };
}

const OK = { history: 'seeded', status: 'ok', lateAfterFinal: false } as const;

function rows(tsNs: number[], totalRows = tsNs.length): TableResultDTO {
  return {
    tsNs,
    columns: { x: tsNs.map(() => 1), y: tsNs.map(() => 2) },
    inputs: { x: { ...OK }, y: { ...OK }, trig: { ...OK } },
    totalRows,
  };
}

let tsCounter = 0;
function fresh(): TableResultDTO {
  tsCounter += 1;
  return rows([1e18 + tsCounter * 1e8]);
}

// ── Harness ───────────────────────────────────────────────────────────────

const TRIGGERED = 'x=X&y=Y&trig=T';

interface Props {
  state: CorrelationState;
  model: PvModel;
  paused: boolean;
}

let engine: FakeFox;
let hare: FakeHare;
let services: FormulaEngineService[];
let connectOnStart: boolean;

async function load(search = ''): Promise<{ mod: UseTableModule; bridge: BridgeModule }> {
  window.history.replaceState(null, '', `/${search}`);
  vi.resetModules();
  const bridge = await import('../../embed/bridge');
  const mod = await import('./useTable');
  return { mod, bridge };
}

function createFormulaEngine(options: FormulaEngineServiceOptions) {
  const service = new FormulaEngineService({ ...options, webSocketFactory: engine.factory });
  services.push(service);
  if (!connectOnStart) {
    return {
      get status() {
        return service.status;
      },
      connect: () => {},
      dispose: () => service.dispose(),
      subscribe: (spec: FormulaSpec, opts: FormulaEngineSubscribeOptions) =>
        service.subscribe(spec, opts),
    };
  }
  return service;
}

function props(query: string, over: Partial<Props> = {}): Props {
  const state = parseCorrelationQuery(query);
  return { state, model: modelFor(state), paused: false, ...over };
}

function mount(mod: UseTableModule, initial: Props) {
  return renderHook((p: Props) => mod.useTable({ ...p, hare, createFormulaEngine }), {
    initialProps: initial,
  });
}

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

/** Mount standalone, open the socket and let the first spec settle. */
async function liveHook(query = TRIGGERED) {
  const { mod } = await load();
  const hook = mount(mod, props(query));
  act(() => engine.socket.open());
  advance(300);
  return hook;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  engine = new FakeFox();
  hare = new FakeHare();
  services = [];
  connectOnStart = true;
});

afterEach(() => {
  cleanup();
  for (const s of services) s.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

// ── Tests ─────────────────────────────────────────────────────────────────

describe('subscribing', () => {
  it('subscribes the built spec once after the debounce, with t0Ns < 0', async () => {
    const { mod } = await load();
    const hook = mount(mod, props(TRIGGERED));
    act(() => engine.socket.open());
    expect(engine.count('subscribe')).toBe(0);
    expect(hook.result.current.health.line).toBe('add an X and at least one Y');
    advance(299);
    expect(engine.count('subscribe')).toBe(0);
    advance(1);
    expect(engine.count('subscribe')).toBe(1);
    const sent = engine.wire[0];
    expect(sent.spec?.kind).toBe('table');
    expect(sent.t0Ns).toBe(-3_600_000_000_000);
    expect(hook.result.current.health.text).toBe('connecting…');
    act(() => engine.result(fresh()));
    expect(hook.result.current.health.text).toBe('ok');
    expect(hook.result.current.frame?.columnPvs).toEqual({ x: 'X', y: 'Y' });
  });

  it('SDK status idle shows "connecting…"', async () => {
    connectOnStart = false;
    const { mod } = await load();
    const hook = mount(mod, props(TRIGGERED));
    advance(300);
    expect(services[0].status).toBe('idle');
    expect(hook.result.current.health.text).toBe('connecting…');
  });

  it('a model update with the same spec does not restart the debounce', async () => {
    const { mod } = await load();
    const p = props(TRIGGERED);
    const hook = mount(mod, p);
    act(() => engine.socket.open());
    for (let i = 0; i < 5; i++) {
      advance(100);
      hook.rerender({ ...p, model: { ...p.model } });
    }
    expect(engine.count('subscribe')).toBe(1);
  });
});

describe('no buildable spec', () => {
  for (const [name, query, statuses] of [
    ['a blank + instance', '', {}],
    ['an X-only tab', 'x=X', {}],
    ['a tab whose Ys are all refused', 'x=X&y=Y1&y=Y2', { Y1: 'refused-kind', Y2: 'refused-unit' }],
  ] as Array<[string, string, Record<string, PvStatus>]>) {
    it(`${name} shows "add an X and at least one Y", never "connecting…"`, async () => {
      const { mod } = await load();
      const state = parseCorrelationQuery(query);
      // Before the decision point the Ys are pending.
      const hook = mount(mod, { state, model: modelFor(state, {}, false), paused: false });
      const seen = new Set<string>([hook.result.current.health.text]);
      act(() => engine.socket.open());
      seen.add(hook.result.current.health.text);
      for (let t = 0; t < 4000; t += 250) {
        if (t === 3000) hook.rerender({ state, model: modelFor(state, statuses), paused: false });
        advance(250);
        seen.add(hook.result.current.health.text);
      }
      expect([...seen]).toEqual(['add an X and at least one Y']);
      expect(engine.count('subscribe')).toBe(0);
    });
  }

  it('removing the last Y unsubscribes and shows "add an X…"', async () => {
    const hook = await liveHook();
    act(() => engine.result(fresh()));
    hook.rerender(props('x=X&trig=T'));
    advance(300);
    expect(engine.wire.map((m) => m.type)).toEqual(['subscribe', 'unsubscribe']);
    expect(hook.result.current.health.text).toBe('add an X and at least one Y');
  });
});

describe('Formula Engine socket', () => {
  it('Formula Engine down for 3 backoff cycles shows "connection lost" steadily', async () => {
    const hook = await liveHook();
    act(() => engine.result(fresh()));
    act(() => engine.socket.drop());
    const seen: string[] = [hook.result.current.health.text];
    for (const delay of [1000, 2000, 4000]) {
      for (let t = 0; t < delay; t += 250) {
        advance(250);
        seen.push(hook.result.current.health.text);
      }
      // the backoff attempt: a new socket, CONNECTING, then refused
      expect(services[0].status).toBe('connecting');
      seen.push(hook.result.current.health.text);
      act(() => engine.socket.drop());
      seen.push(hook.result.current.health.text);
    }
    expect(new Set(seen)).toEqual(new Set(['connection lost']));
    expect(engine.sockets).toHaveLength(4);
  });

  it('a socket CONNECTING for 10 s before it closes, after an earlier open, shows "connection lost" throughout', async () => {
    const hook = await liveHook();
    act(() => engine.result(fresh()));
    act(() => engine.socket.drop());
    advance(1000);
    expect(services[0].status).toBe('connecting');
    const seen = new Set<string>();
    for (let t = 0; t < 10_000; t += 500) {
      advance(500);
      seen.add(hook.result.current.health.text);
    }
    act(() => engine.socket.drop());
    seen.add(hook.result.current.health.text);
    expect([...seen]).toEqual(['connection lost']);
  });

  it('never reachable shows "cannot reach the Formula Engine"', async () => {
    const { mod } = await load();
    const hook = mount(mod, props(TRIGGERED));
    advance(300);
    expect(hook.result.current.health.text).toBe('connecting…');
    act(() => engine.socket.drop());
    expect(hook.result.current.health.text).toBe('cannot reach the Formula Engine');
    advance(1000);
    expect(hook.result.current.health.text).toBe('cannot reach the Formula Engine');
    act(() => engine.socket.drop());
    expect(hook.result.current.health.text).toBe('cannot reach the Formula Engine');
  });

  it('after a reconnect the tab is pending until a result', async () => {
    const hook = await liveHook();
    act(() => engine.result(fresh()));
    act(() => engine.socket.drop());
    advance(1000);
    act(() => engine.socket.open());
    expect(hook.result.current.health.text).toBe('connecting…');
    act(() => engine.result(fresh()));
    expect(hook.result.current.health.text).toBe('ok');
  });

  it('a 1008 close reconnects and re-subscribes like any drop', async () => {
    const hook = await liveHook();
    act(() => engine.result(fresh()));
    act(() => engine.socket.drop(1008));
    expect(hook.result.current.health.text).toBe('connection lost');
    advance(1000);
    expect(engine.sockets).toHaveLength(2);
    act(() => engine.socket.open());
    expect(engine.count('subscribe')).toBe(2);
    act(() => engine.result(fresh()));
    expect(hook.result.current.health.text).toBe('ok');
  });
});

describe('errors', () => {
  it('a retryable wait for 10 s then a result → exactly one subscribe', async () => {
    const hook = await liveHook();
    act(() => engine.error('formula_input_missing', 'seeding', true));
    for (let t = 0; t < 10_000; t += 1000) {
      advance(1000);
      expect(hook.result.current.health.text).toBe('waiting for data: seeding');
    }
    act(() => engine.result(fresh()));
    expect(hook.result.current.health.text).toBe('ok');
    expect(engine.count('subscribe')).toBe(1);
    expect(engine.count('unsubscribe')).toBe(0);
  });

  it('non-retryable → unsubscribed; Retry re-subscribes once', async () => {
    const hook = await liveHook();
    act(() => engine.error('invalid_spec', 'bad column', false));
    expect(hook.result.current.health.text).toBe('error: bad column');
    expect(hook.result.current.health.retry).toBe(true);
    expect(engine.wire.map((m) => m.type)).toEqual(['subscribe', 'unsubscribe']);
    act(() => hook.result.current.retry());
    act(() => hook.result.current.retry());
    expect(engine.count('subscribe')).toBe(2);
    expect(hook.result.current.health.text).toBe('connecting…');
    act(() => engine.result(fresh()));
    expect(hook.result.current.health.text).toBe('ok');
  });

  it('table_limit shows "error: …" with Retry', async () => {
    const hook = await liveHook();
    act(() => engine.error('table_limit', 'at most 8 tables per client', false));
    expect(hook.result.current.health.line).toBe('error: at most 8 tables per client');
    expect(hook.result.current.health.retry).toBe(true);
  });

  it('an id-less reject of the subscribe shows "error: …" with Retry', async () => {
    const { mod } = await load();
    engine.autoAck = false;
    const hook = mount(mod, props(TRIGGERED));
    act(() => engine.socket.open());
    advance(300);
    act(() => engine.socket.receive({ type: 'error', code: 'table_limit', message: 'limit' }));
    expect(hook.result.current.health.text).toBe('error: limit');
    expect(hook.result.current.health.retry).toBe(true);
  });

  it('a non-retryable error, then a socket close and reopen, still shows "error: …"', async () => {
    const hook = await liveHook();
    act(() => engine.error('invalid_spec', 'bad', false));
    act(() => engine.socket.drop());
    expect(hook.result.current.health.text).toBe('error: bad');
    advance(1000);
    act(() => engine.socket.open());
    advance(5000);
    expect(hook.result.current.health.text).toBe('error: bad');
    expect(hook.result.current.health.retry).toBe(true);
    // The SDK does not re-send it: the controller unsubscribed it.
    expect(engine.count('subscribe')).toBe(1);
  });
});

describe('spec changes', () => {
  it('a role edit shows "connecting…" until the new id’s first result; unsubscribe then subscribe in one tick', async () => {
    const hook = await liveHook();
    const first = fresh();
    act(() => engine.result(first));
    const oldFrame = hook.result.current.frame;
    hook.rerender(props('x=X&y=Y2&trig=T'));
    advance(299);
    expect(engine.wire.map((m) => m.type)).toEqual(['subscribe']);
    expect(hook.result.current.health.text).toBe('ok');
    const before = engine.wire.length;
    advance(1);
    expect(engine.wire.slice(before).map((m) => m.type)).toEqual(['unsubscribe', 'subscribe']);
    expect(hook.result.current.health.text).toBe('connecting…');
    // the old frame stays, with its own column→PV map
    expect(hook.result.current.frame).toBe(oldFrame);
    expect(hook.result.current.frame?.columnPvs).toEqual({ x: 'X', y: 'Y' });
    advance(3000);
    expect(hook.result.current.health.text).toBe('connecting…');
    act(() => engine.result(fresh()));
    expect(hook.result.current.health.text).toBe('ok');
    expect(hook.result.current.frame?.columnPvs).toEqual({ x: 'X', y: 'Y2' });
  });

  it('a seed wait of 15 s keeps "waiting for data" and the old frame', async () => {
    const hook = await liveHook();
    act(() => engine.result(fresh()));
    const oldFrame = hook.result.current.frame;
    hook.rerender(props('x=X&y=Y&trig=T&n=5000'));
    advance(300);
    act(() => engine.error('formula_input_missing', 'seeding history', true));
    for (let t = 0; t < 15_000; t += 1000) {
      advance(1000);
      expect(hook.result.current.health.text).toBe('waiting for data: seeding history');
      expect(hook.result.current.frame).toBe(oldFrame);
    }
  });

  it('rapid edits swap once, to the last spec', async () => {
    const hook = await liveHook();
    for (const n of [10, 20, 30]) {
      hook.rerender(props(`${TRIGGERED}&n=${n}`));
      advance(100);
    }
    advance(300);
    expect(engine.wire.map((m) => m.type)).toEqual(['subscribe', 'unsubscribe', 'subscribe']);
    expect(engine.wire[2].spec?.maxPoints).toBe(30);
  });

  it('a view edit changes nothing on the wire', async () => {
    const hook = await liveHook('x=X&y=Y');
    hook.rerender(props('x=X&y=Y&view=density'));
    advance(1000);
    expect(engine.count('subscribe')).toBe(1);
    expect(engine.count('unsubscribe')).toBe(0);
  });
});

describe('superseded ids (controller)', () => {
  it('callbacks of an old id change neither health nor the frame', async () => {
    const { mod } = await load();
    const calls: FormulaEngineSubscribeOptions[] = [];
    const service = {
      status: 'connected' as const,
      connect: () => {},
      dispose: () => {},
      subscribe: (_spec: FormulaSpec, opts: FormulaEngineSubscribeOptions) => {
        calls.push(opts);
        return () => {};
      },
    };
    const c = new mod.TableController();
    c.attach(service);
    c.setWanted(true);
    const spec = (q: string) => {
      const state = parseCorrelationQuery(q);
      return buildTableSpec(state, modelFor(state));
    };
    c.setSpec(spec(TRIGGERED));
    vi.advanceTimersByTime(300);
    calls[0].onResult({
      kind: 'table',
      scalar: null,
      timeseries: null,
      waveform: null,
      table: fresh(),
    });
    const frame = c.getSnapshot().frame;
    c.setSpec(spec('x=X&y=Y2&trig=T'));
    vi.advanceTimersByTime(300);
    expect(calls).toHaveLength(2);
    const pendingHealth = c.getSnapshot().health;
    expect(pendingHealth.sub).toBe('pending');
    calls[0].onResult({
      kind: 'table',
      scalar: null,
      timeseries: null,
      waveform: null,
      table: fresh(),
    });
    calls[0].onError?.({ code: 'seed', message: 'old wait', retryable: true });
    calls[0].onError?.({ code: 'bad', message: 'old error', retryable: false });
    expect(c.getSnapshot().health).toBe(pendingHealth);
    expect(c.getSnapshot().frame).toBe(frame);

    calls[1].onError?.({ code: 'bad', message: 'new error', retryable: false });
    const errored = c.getSnapshot().health;
    expect(errored.sub).toBe('errored');
    calls[1].onResult({
      kind: 'table',
      scalar: null,
      timeseries: null,
      waveform: null,
      table: fresh(),
    });
    calls[0].onResult({
      kind: 'table',
      scalar: null,
      timeseries: null,
      waveform: null,
      table: fresh(),
    });
    expect(c.getSnapshot().health).toBe(errored);
    c.dispose();
  });
});

describe('Pause', () => {
  it('sends nothing; Resume shows the latest received frame and state at once', async () => {
    const hook = await liveHook();
    act(() => engine.result(fresh()));
    const frozen = hook.result.current.frame;
    const wire = engine.wire.length;
    hook.rerender(props(TRIGGERED, { paused: true }));
    expect(hook.result.current.health.text).toBe('paused');
    act(() => engine.socket.drop());
    advance(1000);
    act(() => engine.socket.open());
    const newest = fresh();
    act(() => engine.result(newest));
    advance(5000);
    expect(hook.result.current.frame).toBe(frozen);
    expect(hook.result.current.health.text).toBe('paused');
    // only the SDK's own re-subscribe on reconnect; Pause sent nothing
    expect(engine.wire.slice(wire).map((m) => m.type)).toEqual(['subscribe']);
    hook.rerender(props(TRIGGERED));
    expect(hook.result.current.frame?.table).toEqual(newest);
    expect(hook.result.current.health.text).not.toBe('connecting…');
    expect(hook.result.current.health.text).toBe('ok');
  });
});

describe('visibility', () => {
  async function embedded() {
    const loaded = await load('?embedded=true');
    vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {});
    loaded.bridge.installBridge();
    return loaded;
  }

  function host(visible: boolean): void {
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'canopy:trace-visibility', visible },
          origin: location.origin,
          source: window.parent,
        })
      );
    });
  }

  it('a hidden-mounted instance makes no subscribe until visible (trace-ready reply visible:false)', async () => {
    const { mod } = await embedded();
    mount(mod, props(TRIGGERED));
    act(() => engine.socket.open());
    host(false);
    advance(15_000);
    expect(engine.count('subscribe')).toBe(0);
    host(true);
    expect(engine.count('subscribe')).toBe(1);
  });

  it('an instance the host never messages makes no subscribe', async () => {
    const { mod } = await embedded();
    mount(mod, props(TRIGGERED));
    act(() => engine.socket.open());
    advance(5_000);
    expect(engine.count('subscribe')).toBe(0);
  });

  it('a visible-mounted instance subscribes on the host’s first message', async () => {
    const { mod } = await embedded();
    mount(mod, props(TRIGGERED));
    act(() => engine.socket.open());
    advance(300);
    host(true);
    expect(engine.count('subscribe')).toBe(1);
  });

  it('standalone subscribes at once', async () => {
    await liveHook();
    expect(engine.count('subscribe')).toBe(1);
  });

  it('hidden 9 s keeps the subscription, 11 s unsubscribes, shown again re-subscribes', async () => {
    const { mod } = await embedded();
    const hook = mount(mod, props(TRIGGERED));
    act(() => engine.socket.open());
    host(true);
    advance(300);
    act(() => engine.result(fresh()));
    host(false);
    advance(9_000);
    expect(engine.count('unsubscribe')).toBe(0);
    host(true);
    advance(1_000);
    host(false);
    advance(11_000);
    expect(engine.wire.map((m) => m.type)).toEqual(['subscribe', 'unsubscribe']);
    const frame = hook.result.current.frame;
    host(true);
    expect(engine.wire.map((m) => m.type)).toEqual(['subscribe', 'unsubscribe', 'subscribe']);
    expect(hook.result.current.frame).toBe(frame);
  });
});

describe('Hare and per-PV status', () => {
  it('a disconnected PV shows while Hare is up; a Hare outage shows "PV status unavailable"', async () => {
    const hook = await liveHook();
    act(() => engine.result(fresh()));
    hare.set('Y', { connected: false });
    advance(1000);
    expect(hook.result.current.health.text).toBe('disconnected: Y');
    hare.status = 'disconnected';
    advance(1000);
    expect(hook.result.current.health.text).toBe('ok');
    expect(hook.result.current.health.suffixes).toEqual(['PV status unavailable']);
    hare.status = 'connected';
    hare.set('Y', { connected: true });
    advance(1000);
    expect(hook.result.current.health.line).toBe('ok');
  });
});

describe('timing', () => {
  it('Timer Δt = 0.1 s goes stale after 3 × 500 ms + 2 s', async () => {
    const hook = await liveHook('x=X&y=Y&dt=0.1');
    act(() => engine.result(fresh()));
    advance(3000);
    expect(hook.result.current.health.text).toBe('ok');
    advance(1000);
    expect(hook.result.current.health.text).toBe('stale');
    act(() => engine.result(fresh()));
    advance(1000);
    expect(hook.result.current.health.text).toBe('ok');
  });

  it('an empty first result ends pending and shows "trigger silent" after 10 s', async () => {
    const hook = await liveHook();
    act(() => engine.result(rows([])));
    expect(hook.result.current.health.text).toBe('ok');
    advance(9_000);
    expect(hook.result.current.health.text).toBe('ok');
    // The line is evaluated on a 1 s tick: within a second of the 10 s mark.
    advance(2_000);
    expect(hook.result.current.health.text).toBe('trigger silent');
  });

  it('a seeded first frame of 1000 rows with no further arrival shows "trigger silent" after 10 s', async () => {
    const hook = await liveHook();
    const seeded = rows(Array.from({ length: 1000 }, (_, i) => 1e18 + i * 1e8));
    act(() => engine.result(seeded));
    advance(5_000);
    act(() => engine.result(seeded));
    advance(4_000);
    expect(hook.result.current.health.text).toBe('ok');
    advance(2_000);
    expect(hook.result.current.health.text).toBe('trigger silent');
  });
});

describe('suffixes', () => {
  function fixtureTable(over: Partial<TableResultDTO> = {}): TableResultDTO {
    const t = (JSON.parse(resultTriggerRaw) as { data: { table: TableResultDTO } }).data.table;
    return { ...t, ...over };
  }

  it('each suffix of the result fixture appears and disappears with its field', async () => {
    const hook = await liveHook('x=X&y=Y1&y=Y2&trig=T');
    act(() => engine.result(fixtureTable()));
    expect(hook.result.current.health.suffixes).toEqual([
      'no archive history for T',
      'not archived: Y1',
      'history truncated for Y2',
      'late data for Y1',
    ]);
    act(() => engine.result(fixtureTable({ totalRows: 1500 })));
    expect(hook.result.current.health.suffixes).toContain('3 of 1500 rows shown');
    const clean = fixtureTable();
    clean.inputs = {
      x: { ...OK },
      y1: { ...OK },
      y2: { ...OK },
      trig: { ...OK },
    };
    act(() => engine.result(clean));
    expect(hook.result.current.health.suffixes).toEqual([]);
    expect(hook.result.current.health.line).toBe('ok');
  });
});
