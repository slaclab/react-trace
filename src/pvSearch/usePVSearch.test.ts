// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { usePVSearch } from './usePVSearch';

async function settle(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('usePVSearch', () => {
  it('is idle for a blank pattern and never calls the search', async () => {
    const search = vi.fn(async () => ['A']);
    const { result } = renderHook(() => usePVSearch('  ', search));
    await settle(500);
    expect(result.current).toEqual({ status: 'idle', pvs: [] });
    expect(search).not.toHaveBeenCalled();
  });

  it('searches the trimmed pattern once after the debounce', async () => {
    const search = vi.fn(async () => ['SIM:A', 'SIM:B']);
    const { result } = renderHook(() => usePVSearch(' SIM: ', search, 300));
    await settle(299);
    expect(search).not.toHaveBeenCalled();
    await settle(1);
    expect(search).toHaveBeenCalledWith('SIM:', expect.any(AbortSignal));
    expect(result.current).toEqual({ status: 'ready', pvs: ['SIM:A', 'SIM:B'] });
  });

  it('aborts the request of a pattern that changed in flight and keeps the latest', async () => {
    const seen: AbortSignal[] = [];
    const search = vi.fn(async (pattern: string, signal?: AbortSignal) => {
      seen.push(signal as AbortSignal);
      await new Promise((r) => setTimeout(r, 50));
      return [`${pattern}:HIT`];
    });
    const { result, rerender } = renderHook(({ p }) => usePVSearch(p, search), {
      initialProps: { p: 'one' },
    });
    await settle(300);
    expect(result.current.status).toBe('loading');
    rerender({ p: 'two' });
    expect(seen[0].aborted).toBe(true);
    await settle(300);
    await settle(50);
    expect(result.current).toEqual({ status: 'ready', pvs: ['two:HIT'] });
  });

  it('reports the backend code of a failed search, unknown_error without one', async () => {
    const coded = vi.fn(async () => {
      throw Object.assign(new Error('nope'), { code: 'archiver_unavailable', detail: 'down' });
    });
    const { result } = renderHook(() => usePVSearch('x', coded));
    await settle(300);
    expect(result.current).toEqual({
      status: 'error',
      pvs: [],
      error: { code: 'archiver_unavailable', detail: 'down' },
    });

    const plain = vi.fn(async () => {
      throw new Error('boom');
    });
    const other = renderHook(() => usePVSearch('x', plain));
    await settle(300);
    expect(other.result.current.error).toEqual({ code: 'unknown_error', detail: 'boom' });
  });
});
