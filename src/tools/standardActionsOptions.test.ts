// @vitest-environment jsdom
//
// The host-bar flag is `embedded=true` AND `hostbar=1`. The flag without
// `embedded=true` is not, a standalone page is not, and the hook reads it once
// per mount. The workbench's reader (`workbench/embedding.ts`) is the one the
// tool side calls.
import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { isEmbedded } from '../embed/embedded';
import { embeddedPage, hostBarPage } from '../workbench/embedding';
import { useStandardActionsOptions } from './standardActionsOptions';

function at(search: string): void {
  window.history.replaceState(null, '', `/x/trace/trace.html${search}`);
}

afterEach(() => {
  window.history.replaceState(null, '', '/');
});

const cases: Array<{ search: string; embedded: boolean; bar: boolean; what: string }> = [
  { search: '?embedded=true&hostbar=1', embedded: true, bar: true, what: 'hostbar=1' },
  { search: '?hostbar=1&theme=dark&embedded=true', embedded: true, bar: true, what: 'any order' },
  { search: '?embedded=true', embedded: true, bar: false, what: 'embedded alone' },
  { search: '?hostbar=1', embedded: false, bar: false, what: 'hostbar=1 alone' },
  { search: '', embedded: false, bar: false, what: 'a standalone page' },
  { search: '?embedded=true&other=1', embedded: true, bar: false, what: 'an unknown flag' },
  { search: '?embedded=true&hostbar=0', embedded: true, bar: false, what: 'hostbar=0' },
  {
    search: '?embedded=true&hostbar=true',
    embedded: true,
    bar: false,
    what: 'hostbar=true (not 1)',
  },
  { search: '?embedded=false&hostbar=1', embedded: false, bar: false, what: 'embedded=false' },
];

describe('embeddedPage / hostBarPage', () => {
  it.each(cases)('$what -> embedded $embedded, bar $bar', ({ search, embedded, bar }) => {
    at(search);
    expect(isEmbedded()).toBe(embedded);
    expect(embeddedPage()).toBe(embedded);
    expect(hostBarPage()).toBe(bar);
  });

  it('reads the search string it is given', () => {
    expect(hostBarPage('?embedded=true&hostbar=1')).toBe(true);
    expect(hostBarPage('?hostbar=1')).toBe(false);
    expect(embeddedPage('?embedded=true')).toBe(true);
  });
});

describe('useStandardActionsOptions', () => {
  it('hostbar=1: embedded and hostBar true, no theme toggle', () => {
    at('?embedded=true&hostbar=1');
    const { result } = renderHook(() => useStandardActionsOptions('dark'));
    expect(result.current.embedded).toBe(true);
    expect(result.current.hostBar).toBe(true);
    expect(result.current.theme).toBeUndefined();
  });

  it('embedded=true alone: embedded but no host bar', () => {
    at('?embedded=true');
    const { result } = renderHook(() => useStandardActionsOptions('dark'));
    expect(result.current.embedded).toBe(true);
    expect(result.current.hostBar).toBe(false);
  });

  it('hostbar=1 alone: neither, and the theme toggle stays', () => {
    at('?hostbar=1');
    const { result } = renderHook(() => useStandardActionsOptions('light'));
    expect(result.current.embedded).toBe(false);
    expect(result.current.hostBar).toBe(false);
    expect(result.current.theme?.colorMode).toBe('light');
  });

  it('reads the flag once per mount: a later URL change does not flip it', () => {
    at('?embedded=true&hostbar=1');
    const { result, rerender } = renderHook(({ mode }) => useStandardActionsOptions(mode), {
      initialProps: { mode: 'dark' as 'dark' | 'light' },
    });
    expect(result.current.hostBar).toBe(true);
    at('');
    rerender({ mode: 'light' });
    expect(result.current.hostBar).toBe(true);
    expect(result.current.embedded).toBe(true);
  });
});
