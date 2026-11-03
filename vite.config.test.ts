import { describe, expect, it } from 'vitest';
import { canopyDevProxy } from '@slaclab/canopy-vite';
import { canopyProxyOptions, elogAppProxy } from './vite.config';

const base = { CANOPY_BASE_URL: 'http://canopy.test:9000', CANOPY_API_KEY: 'k' };

describe('canopyProxyOptions', () => {
  it('proxies /mole, /hare and /formula-engine when no Canopy base path is set', () => {
    const options = canopyProxyOptions(base);
    expect(options).toMatchObject({
      target: 'http://canopy.test:9000',
      apiKey: 'k',
      modules: ['/mole', '/hare', '/formula-engine'],
    });
    expect(options.basePath).toBeUndefined();
    const proxy = canopyDevProxy(options);
    expect(Object.keys(proxy)).toEqual([
      '^/mole(?=[/?#]|$)',
      '^/hare(?=[/?#]|$)',
      '^/formula-engine(?=[/?#]|$)',
    ]);
    expect(Object.values(proxy).every((route) => route.ws === true)).toBe(true);
  });

  it('switches to the single deployed prefix when VITE_CANOPY_BASE_PATH is set', () => {
    const options = canopyProxyOptions({ ...base, VITE_CANOPY_BASE_PATH: ' /trace/api/canopy ' });
    expect(options.basePath).toBe('/trace/api/canopy');
    expect(options.modules).toBeUndefined();
    const proxy = canopyDevProxy(options);
    expect(Object.keys(proxy)).toEqual(['^/trace/api/canopy(?=[/?#]|$)']);
  });

  // The X-API-Key the e-log route sets for a request path: its configure()
  // registers a proxyReq handler that injects the key on Trace's app path only.
  function elogKeyFor(env: Record<string, string>, path: string): string | undefined {
    const [route] = Object.values(elogAppProxy(env));
    let handler: ((proxyReq: unknown) => void) | undefined;
    const proxy = { on: (_event: string, h: (proxyReq: unknown) => void) => (handler = h) };
    (route.configure as (proxy: unknown, options: unknown) => void)(proxy, route);
    const set: Record<string, string> = {};
    handler!({ path, setHeader: (name: string, value: string) => (set[name] = value) });
    return set['X-API-Key'];
  }

  it("proxies only Trace's e-log app path, with the e-log key", () => {
    const env = { ...base, CANOPY_ELOG_API_KEY: 'e' };
    expect(Object.keys(elogAppProxy(env))).toEqual(['/elog/v1/apps/trace/']);
    expect(elogKeyFor(env, '/elog/v1/apps/trace/entries')).toBe('e');
    // A raw URL that matches the prefix but resolves elsewhere gets no key.
    expect(elogKeyFor(env, '/elog/v1/apps/trace/../other/entries')).toBeUndefined();
    expect(elogKeyFor(env, '/elog/v1/apps/trace/%2e%2e/other/entries')).toBeUndefined();
  });

  it('falls back to CANOPY_API_KEY when CANOPY_ELOG_API_KEY is unset', () => {
    expect(elogKeyFor(base, '/elog/v1/apps/trace/config')).toBe('k');
  });

  it('serves the e-log route under VITE_CANOPY_BASE_PATH, ahead of the Canopy prefix', () => {
    const env = { ...base, VITE_CANOPY_BASE_PATH: '/trace/api/canopy' };
    const routes = elogAppProxy(env);
    expect(Object.keys(routes)).toEqual(['/trace/api/canopy/elog/v1/apps/trace/']);
    const [route] = Object.values(routes);
    expect(route.rewrite!('/trace/api/canopy/elog/v1/apps/trace/config')).toBe(
      '/elog/v1/apps/trace/config'
    );
  });
});
