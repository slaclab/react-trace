// @vitest-environment jsdom
//
// Loading the site defaults before the first render: the file and Canopy's
// settings in parallel, Canopy winning; either missing, failing or slower
// than the timeout counts as none, a late answer is ignored, and a quick
// answer holds the render no longer than it takes. The file is read next to
// the page, and a server's SPA fallback page counts as no file.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSiteSettings } from '../api/magpie';
import { BUILTIN_DEFAULTS } from './builtins';
import {
  fetchSiteFile,
  loadSiteDefaults,
  SITE_FETCH_TIMEOUT_MS,
  startPage,
  type SiteFetch,
} from './load';
import { resetSiteDefaults, siteDefaults } from './store';

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  resetSiteDefaults();
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

const answer =
  (value: unknown): SiteFetch =>
  async () =>
    value;
const never: SiteFetch = () => new Promise(() => {});

describe('loadSiteDefaults', () => {
  it('is the built-ins when neither source has settings', async () => {
    expect(await loadSiteDefaults({ file: answer(null), canopy: answer(null) })).toEqual(
      BUILTIN_DEFAULTS
    );
  });

  it('takes the file, then Canopy over it', async () => {
    const d = await loadSiteDefaults({
      file: answer({ header: { prefix: 'File', brand: true } }),
      canopy: answer({ header: { prefix: 'Canopy' } }),
    });
    expect(d.header.prefix).toBe('Canopy');
    expect(d.header.brand).toBe(true);
  });

  it('counts a failing source as none', async () => {
    const d = await loadSiteDefaults({
      file: () => Promise.reject(new Error('down')),
      canopy: answer({ trace: { plot: { showCrosshair: true } } }),
    });
    expect(d.trace.plot.showCrosshair).toBe(true);
  });

  it('starts with the file when Canopy is slower than the timeout, and ignores its late answer', async () => {
    vi.useFakeTimers();
    let late: (v: unknown) => void = () => {};
    let aborted = false;
    const canopy: SiteFetch = (signal) => {
      signal.addEventListener('abort', () => (aborted = true));
      return new Promise((resolve) => (late = resolve));
    };
    const loading = loadSiteDefaults({ file: answer({ header: { prefix: 'File' } }), canopy });
    await vi.advanceTimersByTimeAsync(SITE_FETCH_TIMEOUT_MS);
    const d = await loading;
    expect(d.header.prefix).toBe('File');
    expect(aborted).toBe(true);
    late({ header: { prefix: 'Late' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(d.header.prefix).toBe('File');
  });

  it('holds the render no longer than quick answers take', async () => {
    vi.useFakeTimers();
    let done = false;
    void loadSiteDefaults({ file: answer(null), canopy: answer(null) }).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(true);
  });

  it('gives up on a source that never answers at the timeout', async () => {
    vi.useFakeTimers();
    let done = false;
    void loadSiteDefaults({ file: never, canopy: never }).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(SITE_FETCH_TIMEOUT_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
  });
});

describe('startPage', () => {
  it('sets the loaded defaults, then renders', async () => {
    let seen = '';
    await startPage(() => (seen = siteDefaults().header.prefix), {
      file: answer({ header: { prefix: 'Lab' } }),
      canopy: answer(null),
    });
    expect(seen).toBe('Lab');
  });
});

function respond(body: string, init: ResponseInit & { type?: string } = {}) {
  const headers = init.type ? { 'content-type': init.type } : undefined;
  return vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(body, { status: init.status ?? 200, headers }));
}

describe('fetchSiteFile', () => {
  const signal = new AbortController().signal;

  it('reads config.json next to the page, uncached', async () => {
    window.history.replaceState(null, '', '/x/y/trace/correlation.html?x=A');
    const fetch = respond('{"version":1}', { type: 'application/json' });
    expect(await fetchSiteFile(signal)).toEqual({ version: 1 });
    expect(fetch.mock.calls[0][0]).toBe(`${window.location.origin}/x/y/trace/config.json`);
    expect(fetch.mock.calls[0][1]).toMatchObject({ cache: 'no-cache' });
  });

  it('is none for a missing file, quietly', async () => {
    respond('not found', { status: 404 });
    expect(await fetchSiteFile(signal)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('is none for a server’s SPA page in its place, quietly', async () => {
    respond('<!doctype html><html></html>', { type: 'text/html' });
    expect(await fetchSiteFile(signal)).toBeNull();
    respond('<!doctype html><html></html>');
    expect(await fetchSiteFile(signal)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('is none for a file that is not JSON, with a warning', async () => {
    respond('{ "version": 1, }', { type: 'application/json' });
    expect(await fetchSiteFile(signal)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('getSiteSettings', () => {
  it('reads the trace settings document', async () => {
    const fetch = respond('{"plot":{"wheel":"x"}}', { type: 'application/json' });
    expect(await getSiteSettings()).toEqual({ plot: { wheel: 'x' } });
    expect(String(fetch.mock.calls[0][0])).toBe('/magpie/v1/settings/trace');
  });

  it('is none, quietly, when a static server answers with its SPA page', async () => {
    respond('<!doctype html><html></html>', { type: 'text/html' });
    expect(await getSiteSettings()).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('is none while unset (404) and on any other failure', async () => {
    respond('{"detail":"not found"}', { status: 404, type: 'application/json' });
    expect(await getSiteSettings()).toBeNull();
    respond('oops', { status: 500 });
    expect(await getSiteSettings()).toBeNull();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('offline'));
    expect(await getSiteSettings()).toBeNull();
  });
});
