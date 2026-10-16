import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeFetch, jsonResponse } from '@slaclab/canopy-client/testing';
import type { FakeRoutes } from '@slaclab/canopy-client/testing';
import { fetchData, fetchMetadata, listArchivers, searchPVs } from './mole';
import { CanopyError } from './client';
import { canopyConnection } from './connection';

// The shim calls go through the shared connection, which has no injected fetch,
// so the SDK falls back to the global fetch: stub it with the SDK's route fake.
function stubFetch(routes: FakeRoutes) {
  const fetch = createFakeFetch(routes, { baseUrl: canopyConnection.baseUrl });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('mole shim over @slaclab/canopy-client', () => {
  it('fetchData encodes the PV and sends the window and fetch mode', async () => {
    const fetch = stubFetch({
      'GET /mole/v1/data/:pv': jsonResponse({
        mode: 'raw',
        pv: 'A:B/C',
        archiver: 'slac',
        from: 1,
        to: 2,
        decimated: false,
        samples: [],
      }),
    });

    const dto = await fetchData('A:B/C', {
      fromNs: 1_000,
      toNs: 2_000,
      archiver: 'slac',
      binning: 'auto',
      maxPoints: 500,
    });

    expect(dto.mode).toBe('raw');
    expect(fetch.calls).toHaveLength(1);
    const [call] = fetch.calls;
    expect(call.params.pv).toBe('A:B/C');
    expect(call.query).toEqual({
      from: '1000',
      to: '2000',
      archiver: 'slac',
      binning: 'auto',
      maxPoints: '500',
    });
  });

  it('routes metadata, search and archiver listing to their endpoints', async () => {
    const fetch = stubFetch({
      'GET /mole/v1/metadata/:pv': jsonResponse({ pv: 'X', units: 'mm' }),
      'GET /mole/v1/search': jsonResponse({ archiver: 'slac', pattern: '.*X.*', pvs: ['X'] }),
      'GET /mole/v1/archivers': jsonResponse({ default: 'slac', archivers: [] }),
    });

    expect((await fetchMetadata('X', 'slac')).units).toBe('mm');
    expect((await searchPVs('.*X.*', { limit: 5 })).pvs).toEqual(['X']);
    expect((await listArchivers()).default).toBe('slac');

    expect(fetch.calls.map((c) => c.path)).toEqual([
      '/mole/v1/metadata/X',
      '/mole/v1/search',
      '/mole/v1/archivers',
    ]);
    expect(fetch.calls[0].query).toEqual({ archiver: 'slac' });
    expect(fetch.calls[1].query).toEqual({ pattern: '.*X.*', limit: '5' });
  });

  it('turns a FastAPI 422 into a readable validation_error', async () => {
    stubFetch({
      'GET /mole/v1/data/:pv': jsonResponse(
        {
          detail: [
            { loc: ['query', 'from'], msg: 'Field required', type: 'missing' },
            { loc: ['query', 'maxPoints'], msg: 'Input should be > 0', type: 'greater_than' },
          ],
        },
        { status: 422 }
      ),
    });

    const err = await fetchData('X', { fromNs: 0 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CanopyError);
    expect(err).toMatchObject({
      code: 'validation_error',
      status: 422,
      detail: 'query.from: Field required; query.maxPoints: Input should be > 0',
    });
    expect((err as CanopyError).issues).toHaveLength(2);
  });

  it('keeps the Canopy error envelope', async () => {
    stubFetch({
      'GET /mole/v1/archivers': jsonResponse(
        { code: 'archiver_unavailable', detail: 'slac is down' },
        { status: 503 }
      ),
    });
    await expect(listArchivers()).rejects.toMatchObject({
      code: 'archiver_unavailable',
      status: 503,
      detail: 'slac is down',
    });
  });

  it('passes an abort through unchanged', async () => {
    stubFetch({ 'GET /mole/v1/archivers': jsonResponse({ default: 'slac', archivers: [] }) });
    const controller = new AbortController();
    controller.abort();
    const err = await listArchivers(controller.signal).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(CanopyError);
    expect((err as { name?: string }).name).toBe('AbortError');
  });
});
