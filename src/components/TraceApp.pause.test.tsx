// @vitest-environment jsdom
//
// While the CANOPY workspace reports the Trace tab hidden, live Hare frames
// keep re-rendering TraceApp, but every plot's clock holds, so the fetch
// windows stay frozen: no archive or Data Insight refetch. On visible the
// clock re-anchors and the archive store's own coverage check decides: one
// fetch per archive trace when the window moved past its tolerance, then none.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { WithCanopy } from '../test/canopy';

const { fetchDataMock, fetchMetadataMock } = vi.hoisted(() => ({
  // Never settles: every request stays in flight, so the store's dedup and
  // coverage tolerance alone decide whether a moved window refetches.
  fetchDataMock: vi.fn(() => new Promise<never>(() => {})),
  fetchMetadataMock: vi.fn(() => new Promise<never>(() => {})),
}));

// The SDK calls take the connection first; the mocks see the rest.
vi.mock('@slaclab/canopy-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@slaclab/canopy-client')>()),
  fetchData: (_conn: unknown, ...args: unknown[]) =>
    fetchDataMock(...(args as Parameters<typeof fetchDataMock>)),
  fetchMetadata: (_conn: unknown, ...args: unknown[]) =>
    fetchMetadataMock(...(args as Parameters<typeof fetchMetadataMock>)),
}));

vi.mock('echarts-for-react', async () => {
  const React = await import('react');
  const fakeInstance = {
    getWidth: () => 800,
    getHeight: () => 400,
    isDisposed: () => false,
    getZr: () => ({ setCursorStyle: () => {}, on: () => {}, off: () => {} }),
    getModel: () => null,
    convertToPixel: () => 0,
    convertFromPixel: () => 0,
    getDataURL: () => '',
    resize: () => {},
    dispatchAction: () => {},
    on: () => {},
    off: () => {},
  };
  class MockECharts extends React.Component {
    getEchartsInstance() {
      return fakeInstance;
    }
    render() {
      return React.createElement('div');
    }
  }
  return { default: MockECharts };
});

const PVS = [
  'TEST:DIAG:BPM:01:POSITION:X',
  'TEST:DIAG:BPM:02:POSITION:X',
  'TEST:DIAG:BPM:03:POSITION:X',
];
const PV_QUERY = PVS.map((pv) => `pv=${encodeURIComponent(pv)}`).join('&');
const T0 = new Date('2026-06-05T12:00:00Z').getTime();

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];
  readyState = 0;
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }
  send() {}
  close() {
    this.readyState = 3;
  }
  addEventListener() {}
  removeEventListener() {}
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  emit(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

function sample(pv: string, value: number, tsMs: number) {
  return {
    pv,
    value,
    valueKind: 'scalar',
    severity: 'NO_ALARM',
    tsNs: tsMs * 1_000_000,
    connected: true,
    error: null,
  };
}

let uninstall: (() => void) | undefined;

// Bumped when a test ends. A test that hits its timeout keeps running in the
// background (vitest cannot cancel it), and its live-frame loop would otherwise
// keep driving fake timers and the next test's render; each loop captures the
// generation it started in and stops as soon as that test is over, so one
// timeout fails one test instead of cascading through the file.
let testGeneration = 0;

function assertSameTest(generation: number): void {
  if (generation !== testGeneration) throw new Error('test already ended');
}

// The first import of TraceApp transforms and evaluates its whole module
// graph (the workbench, Carbon, the stores): seconds on a loaded host. Do it
// once here, outside every test's budget; `mount` still re-evaluates fresh
// module instances per test via `vi.resetModules`, which reuses the transform.
beforeAll(async () => {
  await import('../embed/bridge');
  await import('./TraceApp');
}, 60_000);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  fetchDataMock.mockReset();
  fetchDataMock.mockImplementation(() => new Promise<never>(() => {}));
  fetchMetadataMock.mockClear();
  MockWebSocket.instances = [];
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise<Response>(() => {}))
  );
  vi.stubGlobal('WebSocket', MockWebSocket);
});

afterEach(() => {
  testGeneration += 1;
  cleanup();
  uninstall?.();
  uninstall = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

// TraceApp, the bridge and the live/archive stores all keep module-level state,
// so each test sets the URL and imports fresh copies.
async function mount(query: string): Promise<void> {
  const generation = testGeneration;
  window.history.replaceState(null, '', `/trace/?${query}&embedded=true`);
  vi.resetModules();
  const bridge = await import('../embed/bridge');
  const { TraceApp } = await import('./TraceApp');
  uninstall = bridge.installBridge();
  assertSameTest(generation);
  render(createElement(TraceApp), { wrapper: WithCanopy });
  await flush();
  assertSameTest(generation);
  const ws = MockWebSocket.instances[0];
  expect(ws).toBeDefined();
  await act(async () => {
    ws.open();
    ws.emit({
      type: 'initial',
      data: Object.fromEntries(PVS.map((pv) => [pv, sample(pv, 0, Date.now())])),
      meta: {},
      count: PVS.length,
    });
  });
  await flush();
}

async function flush(): Promise<void> {
  await act(async () => {});
}

function setVisible(visible: boolean): void {
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

// While hidden no clock timeout is scheduled, so how often React commits
// changes nothing the test drives: the frames are what re-render TraceApp, and
// each commit recomputes every window at the current time. One commit per
// frame made a hidden minute 60 full TraceApp renders, CPU work whose wall time
// grows with the host's load until it passes the test's budget.
const HIDDEN_SECONDS_PER_COMMIT = 10;

// Advance `seconds`, with every PV emitting a new value each second: each
// frame reaches the live store at its own second, which also keeps the
// socket's ping/pong liveness satisfied. React commits once per
// `secondsPerCommit` seconds (the store coalesces a burst into one render, as
// in the app). Visible, keep it at 1: a clock tick re-arms the next one only
// after its commit.
async function liveFor(seconds: number, secondsPerCommit = 1): Promise<void> {
  const generation = testGeneration;
  const ws = MockWebSocket.instances[0];
  for (let i = 0; i < seconds; i += secondsPerCommit) {
    assertSameTest(generation);
    await act(async () => {
      for (let s = i; s < Math.min(i + secondsPerCommit, seconds); s += 1) {
        vi.advanceTimersByTime(1000);
        const now = Date.now();
        ws.emit({
          type: 'diff',
          data: Object.fromEntries(PVS.map((pv) => [pv, sample(pv, Math.sin(now), now)])),
          count: PVS.length,
          timestamp: now,
        });
      }
    });
  }
}

/** `liveFor` while Trace is hidden. */
async function hiddenFor(seconds: number): Promise<void> {
  await liveFor(seconds, HIDDEN_SECONDS_PER_COMMIT);
}

function toDatetimeLocal(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

describe('TraceApp visibility pause', () => {
  it('makes no fetch while hidden with live data streaming', async () => {
    await mount(`${PV_QUERY}&range=-1h`);
    expect(fetchDataMock).toHaveBeenCalledTimes(PVS.length);
    fetchDataMock.mockClear();
    setVisible(false);
    await hiddenFor(60);
    expect(fetchDataMock).not.toHaveBeenCalled();
  });

  it('makes no fetch while hidden with the Data Insight Tool open', async () => {
    await mount(`${PV_QUERY}&range=-1h`);
    fireEvent.click(screen.getByRole('button', { name: /Data Insight/ }));
    await flush();
    // The DIT loaded its own window once.
    expect(fetchDataMock).toHaveBeenCalledTimes(PVS.length + 1);
    fetchDataMock.mockClear();
    setVisible(false);
    await hiddenFor(60);
    expect(fetchDataMock).not.toHaveBeenCalled();
  });

  it('fetches once per archive trace on visible, then not again within tolerance', async () => {
    // Requests answer here: the store lets an in-flight request finish rather
    // than refetch a window that only slid forward.
    fetchDataMock.mockImplementation(((pv: string, params: { fromNs: number; toNs: number }) =>
      Promise.resolve({
        mode: 'raw',
        pv,
        archiver: 'test',
        from: params.fromNs,
        to: params.toNs,
        decimated: false,
        samples: [],
      })) as unknown as () => Promise<never>);
    await mount(`${PV_QUERY}&range=-1h`);
    await flush();
    fetchDataMock.mockClear();
    setVisible(false);
    await hiddenFor(60);
    expect(fetchDataMock).not.toHaveBeenCalled();
    setVisible(true);
    // The clock's first timeout, due at once, re-anchors the plot at now.
    await act(async () => {
      vi.advanceTimersByTime(0);
    });
    await flush();
    expect(fetchDataMock).toHaveBeenCalledTimes(PVS.length);
    const fetched = fetchDataMock.mock.calls.map((c) => (c as unknown[])[0]).sort();
    expect(fetched).toEqual([...PVS].sort());
    fetchDataMock.mockClear();
    // Ticks and live frames slide the window less than 1% of the hour.
    await liveFor(20);
    expect(fetchDataMock).not.toHaveBeenCalled();
  });

  it('freezes a custom range without "to" while hidden', async () => {
    const from = toDatetimeLocal(T0 - 60 * 60 * 1000);
    await mount(`${PV_QUERY}&range=custom&from=${encodeURIComponent(from)}`);
    expect(fetchDataMock).toHaveBeenCalledTimes(PVS.length);
    fetchDataMock.mockClear();
    setVisible(false);
    await hiddenFor(60);
    expect(fetchDataMock).not.toHaveBeenCalled();
  });
});
