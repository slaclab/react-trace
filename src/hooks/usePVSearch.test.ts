// @vitest-environment jsdom
//
// usePVSearch: the regex built from what the user typed (the Archiver
// Appliance matches it against the whole PV name, see toSearchRegex) and the
// matches kept listed while the next search is in flight.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { WithCanopy } from '../test/canopy';
import { toSearchRegex, usePVSearch } from './usePVSearch';

interface SearchCall {
  pattern: string;
  options: { archiver?: string; limit?: number };
  resolve: (pvs: string[]) => void;
  reject: (err: Error) => void;
}

const { searchCalls } = vi.hoisted(() => ({ searchCalls: [] as SearchCall[] }));

// Signature-agnostic (pattern, options, signal are the last three arguments),
// so it survives a leading connection argument.
vi.mock('@slaclab/canopy-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@slaclab/canopy-client')>()),
  searchPVs: (...args: unknown[]) => {
    const [pattern, options, signal] = args.slice(-3) as [
      string,
      SearchCall['options'],
      AbortSignal,
    ];
    return new Promise((resolve, reject) => {
      searchCalls.push({ pattern, options, resolve: (pvs) => resolve({ pvs }), reject });
      signal.addEventListener('abort', () =>
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      );
    });
  },
}));

describe('toSearchRegex', () => {
  it.each([
    ['KLYS', '.*(?:KLYS).*'],
    ['  KLYS  ', '.*(?:KLYS).*'],
    ['KLYS:LI2*:PDES', '.*(?:KLYS:LI2.*:PDES).*'],
    ['KLYS:LI2%:PDES', '.*(?:KLYS:LI2.*:PDES).*'],
    ['KLYS:LI2?:PDES', '.*(?:KLYS:LI2.:PDES).*'],
    ['KLYS.*', '.*(?:KLYS.*)'],
    ['^KLYS', '(?:^KLYS).*'],
    ['PDES$', '.*(?:PDES$)'],
    ['KLYS:LI2[0-9]:', '.*(?:KLYS:LI2[0-9]:).*'],
    ['KLYS|FOO', '.*(?:KLYS|FOO).*'],
    // Regex group prefixes survive; `?*` means one character then any.
    ['^KLYS(?:A|B).*$', '(?:^KLYS(?:A|B).*$)'],
    ['KLYS:LI2?*:PDES', '.*(?:KLYS:LI2..*:PDES).*'],
    // An escaped wildcard character stays literal.
    ['KLYS\\*', '.*(?:KLYS\\*).*'],
    ['KLYS\\?A', '.*(?:KLYS\\?A).*'],
    ['KLYS\\.*', '.*(?:KLYS\\..*)'],
    // An end of the text belongs to one branch of a top-level alternation, so
    // a wildcard or anchor there does not stand in for the wrap.
    ['KLYS|FOO*', '.*(?:KLYS|FOO.*).*'],
    ['*KLYS|FOO', '.*(?:.*KLYS|FOO).*'],
    ['^KLYS|FOO', '.*(?:^KLYS|FOO).*'],
    ['KLYS|FOO$', '.*(?:KLYS|FOO$).*'],
    // Not top level: inside a group, a character class, or escaped.
    ['^KLYS(A|B)$', '(?:^KLYS(A|B)$)'],
    ['^KLYS[|]A', '(?:^KLYS[|]A).*'],
    ['^KLYS\\|A', '(?:^KLYS\\|A).*'],
  ])('%j becomes %j', (text, regex) => {
    expect(toSearchRegex(text)).toBe(regex);
  });

  // The Appliance matches the regex against the whole PV name.
  it.each([
    ['KLYS|FOO*', 'KLYS:LI21:PDES'],
    ['KLYS|FOO*', 'FOO:LI21:PDES'],
    ['^KLYS|FOO', 'X:FOO:1'],
    ['^KLYS|FOO', 'KLYS:1'],
    ['KLYS|FOO$', 'KLYS:1'],
  ])('%j full-matches %j', (text, pv) => {
    expect(new RegExp(`^(?:${toSearchRegex(text)})$`).test(pv)).toBe(true);
  });
  it('keeps an anchor meaningful within its alternation branch', () => {
    expect(new RegExp(`^(?:${toSearchRegex('^KLYS|FOO')})$`).test('X:KLYS:1')).toBe(false);
  });
});

describe('usePVSearch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    searchCalls.length = 0;
  });
  afterEach(() => vi.useRealTimers());

  // Let the debounce elapse.
  async function settle() {
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
  }

  it('debounces, then searches with the converted regex, archiver and limit', async () => {
    const { result } = renderHook(() => usePVSearch('KLYS*', 'lcls', 300, 500), {
      wrapper: WithCanopy,
    });
    expect(result.current.status).toBe('idle');
    expect(searchCalls).toHaveLength(0);

    await settle();
    expect(result.current.status).toBe('loading');
    expect(searchCalls).toHaveLength(1);
    expect(searchCalls[0].pattern).toBe('.*(?:KLYS.*)');
    expect(searchCalls[0].options).toEqual({ archiver: 'lcls', limit: 500 });

    await act(async () => searchCalls[0].resolve(['KLYS:A', 'KLYS:B']));
    expect(result.current).toEqual({
      status: 'ready',
      truncated: false,
      pvs: ['KLYS:A', 'KLYS:B'],
    });
  });

  it('lists a PV once even when the archiver repeats it, and flags a truncated result', async () => {
    const { result } = renderHook(() => usePVSearch('KLYS', 'lcls', 300, 3), {
      wrapper: WithCanopy,
    });
    await settle();

    await act(async () => searchCalls[0].resolve(['KLYS:A', 'KLYS:A', 'KLYS:B']));
    expect(result.current).toEqual({
      status: 'ready',
      truncated: true,
      pvs: ['KLYS:A', 'KLYS:B'],
    });
  });

  it('keeps the previous matches listed while the next search is in flight', async () => {
    const { result, rerender } = renderHook(({ pattern }) => usePVSearch(pattern, undefined), {
      initialProps: { pattern: 'KLYS' },
      wrapper: WithCanopy,
    });
    await settle();
    await act(async () => searchCalls[0].resolve(['KLYS:A', 'KLYS:B']));

    rerender({ pattern: 'KLYS:A' });
    await settle();
    expect(result.current).toEqual({
      status: 'loading',
      truncated: false,
      pvs: ['KLYS:A', 'KLYS:B'],
    });

    await act(async () => searchCalls[1].resolve(['KLYS:A']));
    expect(result.current).toEqual({ status: 'ready', truncated: false, pvs: ['KLYS:A'] });
  });

  it('drops matches from another archiver as soon as the archiver changes', async () => {
    const { result, rerender } = renderHook(({ archiver }) => usePVSearch('KLYS', archiver), {
      initialProps: { archiver: 'lcls' },
      wrapper: WithCanopy,
    });
    await settle();
    await act(async () => searchCalls[0].resolve(['KLYS:A']));

    // Before the debounce: nothing of lcls is listed for facet.
    rerender({ archiver: 'facet' });
    expect(result.current).toEqual({ status: 'loading', truncated: false, pvs: [] });
    await settle();
    expect(result.current).toEqual({ status: 'loading', truncated: false, pvs: [] });
    expect(searchCalls[1].options.archiver).toBe('facet');

    await act(async () => searchCalls[1].resolve(['KLYS:F']));
    expect(result.current).toEqual({ status: 'ready', truncated: false, pvs: ['KLYS:F'] });
  });

  it('clears the matches when the pattern is emptied', async () => {
    const { result, rerender } = renderHook(({ pattern }) => usePVSearch(pattern, undefined), {
      initialProps: { pattern: 'KLYS' },
      wrapper: WithCanopy,
    });
    await settle();
    await act(async () => searchCalls[0].resolve(['KLYS:A']));

    rerender({ pattern: '  ' });
    expect(result.current).toEqual({ status: 'idle', truncated: false, pvs: [] });
  });

  it('reports a failed search with no matches', async () => {
    const { result } = renderHook(() => usePVSearch('KLYS', undefined), {
      wrapper: WithCanopy,
    });
    await settle();
    await act(async () => searchCalls[0].reject(new Error('boom')));
    expect(result.current).toEqual({
      status: 'error',
      truncated: false,
      pvs: [],
      error: { code: 'unknown_error', detail: 'boom' },
    });
  });
});
