// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  channelMatches,
  loadChannelCatalog,
  mergeSuggestions,
  pvNameSuggestions,
  resetChannelCatalog,
} from './catalog';

describe('channelMatches', () => {
  const catalog = ['SIM:BPM1:X', 'SIM:BPM1:Y', 'SIM:BPM2:X', 'SIM:MAG:QF1:CURRENT'];

  it('is empty for a blank query or no catalog', () => {
    expect(channelMatches('', catalog)).toEqual([]);
    expect(channelMatches('bpm', [])).toEqual([]);
    expect(channelMatches('bpm2', catalog)).toEqual(['SIM:BPM2:X']);
  });
});

describe('merging', () => {
  it('keeps order and the first occurrence of each name', () => {
    expect(mergeSuggestions(['SIM:A', 'SIM:B'], ['SIM:B', 'SIM:C', 'SIM:A'])).toEqual([
      'SIM:A',
      'SIM:B',
      'SIM:C',
    ]);
  });

  it('Trace: committed PV, then catalog matches, then Mole hits, once each', () => {
    expect(
      pvNameSuggestions('SIM:BPM1:X', ['SIM:BPM1:X', 'SIM:BPM2:X'], ['SIM:BPM2:X', 'SIM:OLD:Y'])
    ).toEqual(['SIM:BPM1:X', 'SIM:BPM2:X', 'SIM:OLD:Y']);
    expect(pvNameSuggestions('', ['SIM:BPM2:X'], ['SIM:OLD:Y'])).toEqual([
      'SIM:BPM2:X',
      'SIM:OLD:Y',
    ]);
  });
});

describe('loadChannelCatalog', () => {
  beforeEach(() => {
    resetChannelCatalog();
    window.history.replaceState(null, '', '/panel/canopy/trace/');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    resetChannelCatalog();
    window.history.replaceState(null, '', '/');
  });

  it('fetches <Canopy base>/channels once', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify(['SIM:BPM1:X']), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(loadChannelCatalog()).resolves.toEqual(['SIM:BPM1:X']);
    await expect(loadChannelCatalog()).resolves.toEqual(['SIM:BPM1:X']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(String((fetchMock.mock.calls[0] as unknown[])[0]));
    expect(url.pathname).toBe('/panel/canopy/channels');
  });

  it('a 404 means no catalog', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not found', { status: 404 }))
    );
    await expect(loadChannelCatalog()).resolves.toEqual([]);
  });

  it('a network error or a malformed body means no catalog', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('offline');
      })
    );
    await expect(loadChannelCatalog()).resolves.toEqual([]);
    resetChannelCatalog();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"a":1}', { status: 200 }))
    );
    await expect(loadChannelCatalog()).resolves.toEqual([]);
  });
});
