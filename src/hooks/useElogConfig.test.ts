import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: async () => body,
  } as Response;
}

// loadElogConfig caches at module scope; load a fresh copy per test.
async function freshLoad() {
  vi.resetModules();
  return (await import('./useElogConfig')).loadElogConfig;
}

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('loadElogConfig', () => {
  it('enables posting with the configured default logbook ids', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        enabled: true,
        provider: 'elog_plus',
        defaultLogbookIds: ['lb-1'],
        reason: null,
      })
    );
    const load = await freshLoad();
    expect(await load()).toEqual({ enabled: true, defaultLogbookIds: ['lb-1'] });
    // Shared by every caller: one fetch.
    await load();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/elog/v1/apps/trace/config', expect.anything());
  });

  it('stays disabled and logs the reason when Canopy says so', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        enabled: false,
        provider: null,
        defaultLogbookIds: [],
        reason: 'no elog-plus token for app trace',
      })
    );
    const load = await freshLoad();
    expect(await load()).toEqual({ enabled: false, defaultLogbookIds: [] });
    expect(console.info).toHaveBeenCalledWith(
      'E-log posting disabled: no elog-plus token for app trace'
    );
    // A definitive answer is cached.
    await load();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports disabled on a failed fetch and retries on the next call', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse({ code: 'invalid_app_name', detail: 'bad app' }, false, 400)
      )
      .mockResolvedValueOnce(
        jsonResponse({ enabled: true, provider: 'elog_plus', defaultLogbookIds: [], reason: null })
      );
    const load = await freshLoad();
    expect(await load()).toEqual({ enabled: false, defaultLogbookIds: [] });
    expect(console.warn).toHaveBeenCalledWith(
      "E-log posting unavailable: Canopy rejected Trace's e-log app name."
    );
    expect(await load()).toEqual({ enabled: true, defaultLogbookIds: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
