// @vitest-environment jsdom
//
// The live path at its real call site: an opening stamps no live retention, so
// TraceApp must hand useLiveSeries each live trace's plot range span; a -1h
// open then watches every PV with min(span, MAX) = 30 min, not the 5-minute
// fallback.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

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
    getDom: () => document.createElement('div'),
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

import { TraceApp } from './TraceApp';
import { liveStore } from '../state/liveStore';
import { LIVE_RETENTION_MAX_MS } from '../hooks/useLiveSeries';
import { WithCanopy } from '../test/canopy';

class InertWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  url: string;
  constructor(url: string) {
    this.url = url;
  }
  send() {}
  close() {
    this.readyState = 3;
  }
  addEventListener() {}
  removeEventListener() {}
}

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
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
  vi.stubGlobal('WebSocket', InertWebSocket);
});

afterEach(() => {
  cleanup();
  // liveStore is a module singleton and retention is non-decreasing per
  // trace id; drop this test's traces so the next opening starts fresh.
  for (const id of ['trace-1', 'trace-2']) liveStore.release(id);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

describe('TraceApp live retention for automatic curves', () => {
  it('watches a -1h opening with min(span, MAX), not the 5-minute fallback', () => {
    const watch = vi.spyOn(liveStore, 'watch');
    window.history.replaceState(null, '', '/trace/?pv=A:B&pv=C:D&range=-1h');
    render(<TraceApp />, { wrapper: WithCanopy });
    expect(LIVE_RETENTION_MAX_MS).toBe(1_800_000);
    const calls = watch.mock.calls.filter(([, pv]) => pv === 'A:B' || pv === 'C:D');
    expect(calls.map(([, pv]) => pv).sort()).toEqual(['A:B', 'C:D']);
    for (const [, , retentionMs] of calls) expect(retentionMs).toBe(1_800_000);
  });

  it('keeps a short range span below the cap', () => {
    const watch = vi.spyOn(liveStore, 'watch');
    window.history.replaceState(null, '', '/trace/?pv=A:B&range=-10m');
    render(<TraceApp />, { wrapper: WithCanopy });
    const calls = watch.mock.calls.filter(([, pv]) => pv === 'A:B');
    expect(calls.length).toBeGreaterThan(0);
    for (const [, , retentionMs] of calls) expect(retentionMs).toBe(600_000);
  });
});
