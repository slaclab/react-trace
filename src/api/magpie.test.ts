import { describe, it, expect, vi, afterEach } from 'vitest';

import { saveConfig, getConfig, listConfigs, updateConfig, deleteConfig } from './magpie';
import { CanopyError } from './client';

// A real Response: the SDK's canopyFetch reads the body as text.
function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return new Response(JSON.stringify(body), { status, statusText: ok ? 'OK' : 'Error' });
}

// All paths are app-scoped to "trace"; BASE is empty in the test env.
const BASE = '/magpie/v1/configs/trace';

function spyFetch(body: unknown, ok = true, status = 200) {
  const captured: { url?: string; init?: RequestInit } = {};
  const mock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    captured.url = String(url);
    captured.init = init;
    return jsonResponse(body, ok, status);
  });
  return { mock, captured };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('saveConfig', () => {
  it('POSTs name/description/createdBy/data to the app-scoped collection', async () => {
    const { captured } = spyFetch({ id: '1', slug: 'abc' });
    const result = await saveConfig(
      { schemaVersion: 1 },
      { name: 'N', description: 'D', createdBy: 'me' }
    );

    expect(result).toEqual({ id: '1', slug: 'abc' });
    expect(captured.url).toBe(BASE);
    expect(captured.init?.method).toBe('POST');
    expect(JSON.parse(captured.init?.body as string)).toEqual({
      name: 'N',
      description: 'D',
      createdBy: 'me',
      data: { schemaVersion: 1 },
    });
  });

  it('defaults meta fields to undefined when omitted', async () => {
    const { captured } = spyFetch({ slug: 'x' });
    await saveConfig({ a: 1 });
    const sent = JSON.parse(captured.init?.body as string);
    expect(sent.data).toEqual({ a: 1 });
    expect(sent.name).toBeUndefined();
  });
});

describe('getConfig', () => {
  it('GETs a slug-addressed path and URL-encodes the slug', async () => {
    const { captured } = spyFetch({ slug: 'a/b' });
    await getConfig('a/b');
    expect(captured.url).toBe(`${BASE}/a%2Fb`);
    expect(captured.init?.method ?? 'GET').toBe('GET');
  });

  it('forwards an AbortSignal', async () => {
    const { captured } = spyFetch({ slug: 's' });
    const ac = new AbortController();
    await getConfig('s', ac.signal);
    expect(captured.init?.signal).toBe(ac.signal);
  });

  it('propagates a CanopyError on 404', async () => {
    spyFetch({ code: 'config_not_found', detail: 'nope' }, false, 404);
    await expect(getConfig('missing')).rejects.toBeInstanceOf(CanopyError);
    await expect(getConfig('missing')).rejects.toMatchObject({
      status: 404,
      code: 'config_not_found',
      detail: 'nope',
    });
  });
});

describe('listConfigs', () => {
  it('passes through only the set query params', async () => {
    const { captured } = spyFetch({ results: [], continuationToken: null, totalCount: 0 });
    await listConfigs({ pageSize: 200 });
    const url = new URL(captured.url as string, 'http://x');
    expect(url.pathname).toBe(BASE);
    expect(url.searchParams.get('pageSize')).toBe('200');
    // Undefined options are omitted entirely (buildQuery drops null/undefined).
    expect(url.searchParams.has('search')).toBe(false);
    expect(url.searchParams.has('continuationToken')).toBe(false);
  });

  it('includes search and continuationToken when provided', async () => {
    const { captured } = spyFetch({ results: [], continuationToken: null, totalCount: 0 });
    await listConfigs({ search: 'li22', continuationToken: 'tok' });
    const url = new URL(captured.url as string, 'http://x');
    expect(url.searchParams.get('search')).toBe('li22');
    expect(url.searchParams.get('continuationToken')).toBe('tok');
  });

  it('returns the paged envelope', async () => {
    spyFetch({ results: [{ slug: 'a' }], continuationToken: 'next', totalCount: 5 });
    const page = await listConfigs();
    expect(page.results).toHaveLength(1);
    expect(page.continuationToken).toBe('next');
    expect(page.totalCount).toBe(5);
  });
});

describe('updateConfig', () => {
  it('PUTs the patch to the slug-addressed path', async () => {
    const { captured } = spyFetch({ slug: 's', name: 'new' });
    await updateConfig('s', { name: 'new' });
    expect(captured.url).toBe(`${BASE}/s`);
    expect(captured.init?.method).toBe('PUT');
    expect(JSON.parse(captured.init?.body as string)).toEqual({ name: 'new' });
  });
});

describe('deleteConfig', () => {
  it('DELETEs the slug-addressed path and resolves void on bare true', async () => {
    const { captured } = spyFetch(true);
    await expect(deleteConfig('s')).resolves.toBeUndefined();
    expect(captured.url).toBe(`${BASE}/s`);
    expect(captured.init?.method).toBe('DELETE');
  });

  it('propagates a CanopyError on failure', async () => {
    spyFetch({ code: 'forbidden', detail: 'no' }, false, 403);
    await expect(deleteConfig('s')).rejects.toMatchObject({ status: 403, detail: 'no' });
  });
});
