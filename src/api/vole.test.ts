import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchBackfill, subscribeVoleBuffer } from './vole';

const mockFetch = vi.fn();

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ pv: 'TEST:PV', count: 0, samples: [] }),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchBackfill', () => {
  it('constructs the correct URL with encoded PV name and query params', async () => {
    await fetchBackfill('TEST:SETPOINT', 1719388800000000000);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      '/vole/v1/pvs/TEST%3ASETPOINT?from=1719388800000000000&align=last&maxPoints=10000'
    );
  });

  it('includes `to` param when provided', async () => {
    await fetchBackfill('PV:A', 1000000000, { to: 2000000000 });

    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('to=2000000000');
  });

  it('allows overriding maxPoints', async () => {
    await fetchBackfill('PV:A', 1000000000, { maxPoints: 5000 });

    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('maxPoints=5000');
  });

  it('passes AbortSignal to fetch', async () => {
    const controller = new AbortController();
    await fetchBackfill('PV:A', 1000000000, { signal: controller.signal });

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBe(controller.signal);
  });
});

describe('subscribeVoleBuffer', () => {
  beforeEach(() => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ subscribed: ['PV:A', 'PV:B'] }),
    });
  });

  it('sends a POST to /vole/v1/pvs/subscribe with PV list in body', async () => {
    await subscribeVoleBuffer(['PV:A', 'PV:B']);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/vole/v1/pvs/subscribe');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual(expect.objectContaining({ 'Content-Type': 'application/json' }));
    expect(init.body).toBe(JSON.stringify({ pvs: ['PV:A', 'PV:B'] }));
  });

  it('passes AbortSignal to fetch', async () => {
    const controller = new AbortController();
    await subscribeVoleBuffer(['PV:A'], { signal: controller.signal });

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBe(controller.signal);
  });
});
