// @vitest-environment jsdom
//
// R6: a live curve moved to another plot keeps its live samples. The live
// store is watched over every plot's curves by curve id (`useLiveSeries`),
// and a move keeps the id, so the target plot shows the buffer at once
// rather than starting empty, and the PV is not re-subscribed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { PVValueDTO } from '@slaclab/canopy-client';
import { captured, resetHarness } from '../test/traceAppHarness';
import { WithCanopy } from '../test/canopy';
import { TraceApp } from './TraceApp';

vi.mock('./PlotArea', async (importOriginal) =>
  (await import('../test/traceAppHarness')).mocks.PlotArea(await importOriginal())
);
vi.mock('../workbench/WorkbenchLayout', async (importOriginal) =>
  (await import('../test/traceAppHarness')).mocks.WorkbenchLayout(await importOriginal())
);
vi.mock(
  '../hooks/useElogConfig',
  async () => (await import('../test/traceAppHarness')).mocks.useElogConfig
);

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];
  readyState = 0;
  url: string;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.();
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  emit(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

beforeEach(() => {
  resetHarness();
  MockWebSocket.instances = [];
  vi.stubGlobal('WebSocket', MockWebSocket);
  window.history.replaceState(null, '', '/?pv=TEST:SINE&range=-1h');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

const flush = async (fn: () => void = () => {}) =>
  act(async () => {
    fn();
    // The store notifies in a microtask; a macrotask turn drains it and React.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

function sample(value: number, tsMs: number): PVValueDTO {
  return {
    pv: 'TEST:SINE',
    value,
    valueKind: 'scalar',
    severity: 'NO_ALARM',
    tsNs: tsMs * 1_000_000,
    connected: true,
    error: null,
  } as PVValueDTO;
}

describe('moving a live curve to another plot', () => {
  it('keeps its live samples: the target plot is not empty after the move', async () => {
    render(<TraceApp />, { wrapper: WithCanopy });
    const area = () => captured.plotArea!;
    const p1 = area().plots[0].id;
    const sine = area().plots[0].traces[0];
    expect(sine.pvName).toBe('TEST:SINE');
    act(() => area().onAddPlot());
    const p2 = area().plots[1].id;
    act(() => area().onSetActivePlot(p1));
    await flush();

    const ws = MockWebSocket.instances.at(-1)!;
    const now = Date.now();
    await flush(() => {
      ws.open();
      ws.emit({
        type: 'initial',
        data: { 'TEST:SINE': sample(1.5, now - 2000) },
        meta: {},
        count: 1,
      });
      ws.emit({ type: 'diff', data: { 'TEST:SINE': sample(2.5, now - 1000) }, count: 1 });
    });
    const before = area().liveResultsByPlot.get(p1)?.get(sine.id)?.points ?? [];
    expect(before.map((p) => p.value)).toEqual([1.5, 2.5]);
    const sockets = MockWebSocket.instances.length;
    const naming = () => ws.sent.filter((m) => m.includes('TEST:SINE')).length;
    const sentBefore = naming();

    await flush(() => captured.layout!.definition.binding.ops.drop!(sine.id, p2));

    expect(area().plots[1].traces.map((t) => t.id)).toEqual([sine.id]);
    expect(area().liveResultsByPlot.get(p2)?.get(sine.id)?.points).toEqual(before);
    expect(area().liveResultsByPlot.get(p1)?.get(sine.id)).toBeUndefined();
    // The same socket, and no new frame naming the PV (no re-subscribe).
    expect(MockWebSocket.instances).toHaveLength(sockets);
    expect(ws.readyState).toBe(MockWebSocket.OPEN);
    expect(naming()).toBe(sentBefore);
  });
});
