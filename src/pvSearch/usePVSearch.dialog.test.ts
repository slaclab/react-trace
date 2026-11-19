// @vitest-environment jsdom
//
// usePVSearch as the Search PVs dialog runs it: a `limit` (so a full result
// reads `truncated`), the previous matches kept listed while the next search
// on the same archiver is in flight, and a switch of archiver (a new
// `search`) dropping the old matches at once. Each PV is listed once. The
// default mode (the PV fields) is pinned in usePVSearch.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { type PvSearch } from './mole';
import { usePVSearch } from './usePVSearch';

interface SearchCall {
  archiver: string;
  pattern: string;
  resolve: (pvs: string[]) => void;
  reject: (err: Error) => void;
}

const calls: SearchCall[] = [];

// One search per archiver, as the dialog memoises Mole's on the archiver.
const searches = new Map<string, PvSearch>();
function searchOf(archiver: string): PvSearch {
  let search = searches.get(archiver);
  if (!search) {
    search = (pattern, signal) =>
      new Promise<string[]>((resolve, reject) => {
        calls.push({ archiver, pattern, resolve, reject });
        signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        );
      });
    searches.set(archiver, search);
  }
  return search;
}

const DIALOG = { limit: 3, keepPrevious: true };

beforeEach(() => {
  vi.useFakeTimers();
  calls.length = 0;
  searches.clear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// Let the debounce elapse.
async function settle() {
  await act(async () => {
    vi.advanceTimersByTime(300);
  });
}

async function resolve(index: number, pvs: string[]) {
  await act(async () => calls[index].resolve(pvs));
}

describe('usePVSearch for the Search PVs dialog', () => {
  it('debounces, then searches the trimmed pattern once and reports truncated: false', async () => {
    const { result } = renderHook(() => usePVSearch(' SIM ', searchOf('arch-a'), 300, DIALOG));
    expect(result.current).toEqual({ status: 'idle', pvs: [], truncated: false });
    expect(calls).toHaveLength(0);

    await settle();
    expect(result.current).toEqual({ status: 'loading', pvs: [], truncated: false });
    expect(calls.map((c) => c.pattern)).toEqual(['SIM']);

    await resolve(0, ['SIM:A', 'SIM:B']);
    expect(result.current).toEqual({ status: 'ready', pvs: ['SIM:A', 'SIM:B'], truncated: false });
  });

  it('lists a PV once even when the archiver repeats it, and flags a full result as truncated', async () => {
    const { result } = renderHook(() => usePVSearch('SIM', searchOf('arch-a'), 300, DIALOG));
    await settle();
    // Three names came back, the limit: there may be more, though two are left.
    await resolve(0, ['SIM:A', 'SIM:A', 'SIM:B']);
    expect(result.current).toEqual({ status: 'ready', pvs: ['SIM:A', 'SIM:B'], truncated: true });
  });

  it('keeps the previous matches listed while the next search is in flight', async () => {
    const { result, rerender } = renderHook(
      ({ pattern }) => usePVSearch(pattern, searchOf('arch-a'), 300, DIALOG),
      { initialProps: { pattern: 'SIM' } }
    );
    await settle();
    await resolve(0, ['SIM:A', 'SIM:B']);

    rerender({ pattern: 'SIM:A' });
    await settle();
    expect(result.current).toEqual({
      status: 'loading',
      pvs: ['SIM:A', 'SIM:B'],
      truncated: false,
    });

    await resolve(1, ['SIM:A']);
    expect(result.current).toEqual({ status: 'ready', pvs: ['SIM:A'], truncated: false });
  });

  it('drops the matches of another archiver as soon as the archiver changes', async () => {
    const { result, rerender } = renderHook(
      ({ archiver }) => usePVSearch('SIM', searchOf(archiver), 300, DIALOG),
      { initialProps: { archiver: 'arch-a' } }
    );
    await settle();
    await resolve(0, ['SIM:A']);

    // Before the debounce: nothing of arch-a is listed for arch-b.
    rerender({ archiver: 'arch-b' });
    expect(result.current).toEqual({ status: 'loading', pvs: [], truncated: false });
    await settle();
    expect(result.current).toEqual({ status: 'loading', pvs: [], truncated: false });
    expect(calls[1].archiver).toBe('arch-b');

    await resolve(1, ['SIM:F']);
    expect(result.current).toEqual({ status: 'ready', pvs: ['SIM:F'], truncated: false });
  });

  it('clears the matches at once when the pattern is emptied', async () => {
    const { result, rerender } = renderHook(
      ({ pattern }) => usePVSearch(pattern, searchOf('arch-a'), 300, DIALOG),
      { initialProps: { pattern: 'SIM' } }
    );
    await settle();
    await resolve(0, ['SIM:A']);

    rerender({ pattern: '  ' });
    expect(result.current).toEqual({ status: 'idle', pvs: [], truncated: false });
  });

  it('reports a failed search with no matches, through the shared error reader', async () => {
    const { result, rerender } = renderHook(
      ({ pattern }) => usePVSearch(pattern, searchOf('arch-a'), 300, DIALOG),
      { initialProps: { pattern: 'SIM' } }
    );
    await settle();
    await act(async () => calls[0].reject(new Error('boom')));
    expect(result.current).toEqual({
      status: 'error',
      pvs: [],
      truncated: false,
      error: { code: 'unknown_error', detail: 'boom' },
    });

    // A Canopy error keeps its code and detail.
    rerender({ pattern: 'SIM:' });
    await settle();
    await act(async () =>
      calls[1].reject(
        Object.assign(new Error('HTTP 503'), {
          code: 'archiver_unavailable',
          detail: 'arch-a is down',
        })
      )
    );
    expect(result.current.error).toEqual({
      code: 'archiver_unavailable',
      detail: 'arch-a is down',
    });
  });
});

describe('usePVSearch in its default mode (the PV fields)', () => {
  it('drops the matches of a replaced search at once too, and adds no truncated flag', async () => {
    const { result, rerender } = renderHook(
      ({ archiver }) => usePVSearch('SIM', searchOf(archiver)),
      {
        initialProps: { archiver: 'arch-a' },
      }
    );
    await settle();
    await resolve(0, ['SIM:A', 'SIM:A']);
    expect(result.current).toEqual({ status: 'ready', pvs: ['SIM:A'] });

    rerender({ archiver: 'arch-b' });
    expect(result.current).toEqual({ status: 'loading', pvs: [] });
  });
});
