// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useLiveSeries } from './useLiveSeries';
import type { PVTrace } from '../types';

vi.mock('../api/vole', () => ({
  fetchBackfill: vi.fn().mockResolvedValue({ pv: '', count: 0, samples: [] }),
  subscribeVoleBuffer: vi.fn().mockResolvedValue({ subscribed: [] }),
}));

class MockWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor() {
    MockWebSocket.instances.push(this);
  }

  send(): void {}

  close(): void {
    if (this.readyState === MockWebSocket.CLOSED) return;
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }

  open(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  emit(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

function liveTrace(id: string, pvName: string): PVTrace {
  return { id, pvName, useLive: true } as PVTrace;
}

const realWebSocket = globalThis.WebSocket;

beforeEach(() => {
  MockWebSocket.instances = [];
  (globalThis as unknown as { WebSocket: typeof MockWebSocket }).WebSocket = MockWebSocket;
});

afterEach(() => {
  globalThis.WebSocket = realWebSocket;
});

describe('useLiveSeries', () => {
  it('keeps existing buffers and the socket when a trace is added', async () => {
    const a = liveTrace('a', 'PV:A');
    const { result, rerender, unmount } = renderHook(({ traces }) => useLiveSeries(traces), {
      initialProps: { traces: [a] },
    });
    const ws = MockWebSocket.instances[0];
    await act(async () => {
      ws.open();
      ws.emit({
        type: 'initial',
        data: {
          'PV:A': {
            pv: 'PV:A',
            value: 1,
            severity: 'NO_ALARM',
            tsNs: Date.now() * 1e6,
            connected: true,
            units: null,
            precision: null,
            error: null,
          },
        },
        count: 1,
      });
    });
    expect(result.current.get('a')!.points).toHaveLength(1);

    await act(async () => rerender({ traces: [a, liveTrace('b', 'PV:B')] }));

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(ws.readyState).toBe(MockWebSocket.OPEN);
    expect(result.current.get('a')!.points).toHaveLength(1);

    unmount();
    expect(ws.readyState).toBe(MockWebSocket.CLOSED);
  });
});
