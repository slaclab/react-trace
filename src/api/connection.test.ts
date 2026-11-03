// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canopyFetch, listArchivers } from '@slaclab/canopy-client';
import { canopyBaseUrl, canopyConnection } from './connection';

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function setBase(href: string | null) {
  document.head.querySelectorAll('base').forEach((b) => b.remove());
  if (href !== null) {
    const base = document.createElement('base');
    base.href = href;
    document.head.appendChild(base);
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  setBase(null);
  window.history.replaceState(null, '', '/');
});

describe('canopyBaseUrl', () => {
  it('defaults to same-origin per-module paths', () => {
    expect(canopyBaseUrl(undefined)).toBe('');
    expect(canopyBaseUrl('')).toBe('');
    expect(canopyBaseUrl('   ')).toBe('');
  });

  it('keeps a deployed prefix and drops trailing slashes and padding', () => {
    expect(canopyBaseUrl('/trace/api/canopy')).toBe('/trace/api/canopy');
    expect(canopyBaseUrl('/trace/api/canopy/')).toBe('/trace/api/canopy');
    expect(canopyBaseUrl(' /trace/api/canopy// ')).toBe('/trace/api/canopy');
  });

  it('is the parent of the document base when no prefix is configured', () => {
    expect(canopyBaseUrl(undefined, 'http://h/x/y/trace/')).toBe('/x/y');
    expect(canopyBaseUrl('', 'http://h/x/y/trace/index.html')).toBe('/x/y');
    expect(canopyBaseUrl(undefined, 'http://h/')).toBe('');
  });

  it('prefers the configured prefix over the derived one', () => {
    expect(canopyBaseUrl('/trace/api/canopy', 'http://h/x/y/trace/')).toBe('/trace/api/canopy');
  });

  it('stays same-origin for a page path that starts with //', () => {
    expect(canopyBaseUrl(undefined, 'http://h//evil.example/x/')).toBe('/evil.example');
  });
});

describe('canopyConnection', () => {
  it('routes requests through the page directory, read at request time', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => okResponse({}));
    window.history.replaceState(null, '', '/x/y/trace/');
    await canopyFetch(canopyConnection, '/mole/v1/pvs', { query: { q: 'TEST:*' } });
    expect(fetchMock.mock.calls[0][0]).toBe('/x/y/mole/v1/pvs?q=TEST%3A*');
    window.history.replaceState(null, '', '/');
    await listArchivers(canopyConnection);
    expect(fetchMock.mock.calls[1][0]).toMatch(/^\/mole\/v1\//);
  });

  it('routes requests through VITE_CANOPY_BASE_PATH when the build sets it', async () => {
    vi.stubEnv('VITE_CANOPY_BASE_PATH', '/trace/api/canopy');
    window.history.replaceState(null, '', '/trace/');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => okResponse({}));
    await canopyFetch(canopyConnection, '/mole/v1/pvs');
    expect(fetchMock.mock.calls[0][0]).toBe('/trace/api/canopy/mole/v1/pvs');
  });

  it('refuses a request that would leave the origin', async () => {
    vi.stubEnv('VITE_CANOPY_BASE_PATH', 'https://elsewhere.example/canopy');
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    await expect(canopyFetch(canopyConnection, '/mole/v1/pvs')).rejects.toMatchObject({
      code: 'network_error',
      detail: expect.stringContaining('Refused a request outside this origin'),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a request when a <base href> names another origin', async () => {
    setBase('https://elsewhere.example/x/trace/');
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    await expect(canopyFetch(canopyConnection, '/mole/v1/pvs')).rejects.toMatchObject({
      code: 'network_error',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
