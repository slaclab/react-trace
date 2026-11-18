// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { CanopyProvider } from '@slaclab/canopy-react';
import { createFakeFetch, jsonResponse } from '@slaclab/canopy-client/testing';
import type { FakeRoutes } from '@slaclab/canopy-client/testing';
import { usePVSearch } from './usePVSearch';

// The hook reads its connection from <CanopyProvider>, so a test can point it
// at a fake Canopy without touching globals.
function renderSearch(pattern: string, routes: FakeRoutes, archiver?: string) {
  const fetch = createFakeFetch(routes);
  const connection = { baseUrl: 'http://canopy.test', fetch };
  const wrapper = ({ children }: { children: ReactNode }) => (
    <CanopyProvider connection={connection}>{children}</CanopyProvider>
  );
  const hook = renderHook(() => usePVSearch(pattern, archiver, 0, 25), { wrapper });
  return { ...hook, fetch };
}

describe('usePVSearch', () => {
  it('searches Mole through the provider connection with a substring wildcard', async () => {
    const { result, fetch } = renderSearch(
      'BPM',
      {
        'GET /mole/v1/search': jsonResponse({
          archiver: 'slac',
          pattern: '.*(?:BPM).*',
          pvs: ['A:BPM'],
        }),
      },
      'slac'
    );

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.pvs).toEqual(['A:BPM']);
    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0].url.startsWith('http://canopy.test/mole/v1/search?')).toBe(true);
    expect(fetch.calls[0].query).toEqual({
      pattern: '.*(?:BPM).*',
      archiver: 'slac',
      limit: '25',
    });
  });

  it('keeps an explicit trailing .* without adding another', async () => {
    const { result, fetch } = renderSearch('A:.*', {
      'GET /mole/v1/search': jsonResponse({ archiver: 'slac', pattern: '.*(?:A:.*)', pvs: [] }),
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(fetch.calls[0].query.pattern).toBe('.*(?:A:.*)');
  });

  it('reports the Canopy error code and detail', async () => {
    const { result } = renderSearch('X', {
      'GET /mole/v1/search': jsonResponse(
        { code: 'archiver_unavailable', detail: 'slac is down' },
        { status: 503 }
      ),
    });
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toEqual({ code: 'archiver_unavailable', detail: 'slac is down' });
  });

  it('stays idle for an empty pattern', () => {
    const { result, fetch } = renderSearch('  ', {});
    expect(result.current.status).toBe('idle');
    expect(fetch.calls).toHaveLength(0);
  });
});
