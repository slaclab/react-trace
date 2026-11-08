import { describe, expect, it } from 'vitest';
import type { ProxyOptions } from 'vite';
import { canopyDevProxy } from '@slaclab/canopy-vite';
import { canopyProxyOptions, elogProxy } from './vite.config';

const base = { CANOPY_BASE_URL: 'http://canopy.test:9000', CANOPY_API_KEY: 'k' };

// The headers a route sets on the request it forwards for `req`: its
// configure() registers proxyReq handlers, which drop cookies and set the key.
function forwardedHeaders(
  route: ProxyOptions,
  path: string,
  req: { headers: Record<string, string> } = { headers: {} }
): Record<string, string> {
  const handlers: ((proxyReq: unknown, req: unknown) => void)[] = [];
  const proxy = {
    on: (event: string, handler: (proxyReq: unknown, req: unknown) => void) => {
      if (event === 'proxyReq') handlers.push(handler);
    },
  };
  (route.configure as (proxy: unknown, options: unknown) => void)(proxy, route);
  const set: Record<string, string> = {};
  const proxyReq = {
    path,
    removeHeader: (name: string) => delete set[name],
    setHeader: (name: string, value: string) => (set[name] = value),
  };
  for (const handler of handlers) handler(proxyReq, req);
  return set;
}

describe('canopyProxyOptions', () => {
  it('proxies the per-module paths when no Canopy base path is set', () => {
    const options = canopyProxyOptions(base);
    expect(options).toMatchObject({
      target: 'http://canopy.test:9000',
      apiKey: 'k',
      modules: ['/mole', '/hare', '/fox', '/magpie', '/vole'],
    });
    expect(options.basePath).toBeUndefined();
    const proxy = canopyDevProxy(options);
    expect(Object.keys(proxy)).toEqual([
      '^/mole(?=[/?#]|$)',
      '^/hare(?=[/?#]|$)',
      '^/fox(?=[/?#]|$)',
      '^/magpie(?=[/?#]|$)',
      '^/vole(?=[/?#]|$)',
    ]);
    expect(Object.values(proxy).every((route) => route.ws === true)).toBe(true);
    expect(forwardedHeaders(proxy['^/mole(?=[/?#]|$)'], '/mole/v1/archivers')).toEqual({
      'X-API-Key': 'k',
    });
  });

  it('switches to the single deployed prefix when VITE_CANOPY_BASE_PATH is set', () => {
    const options = canopyProxyOptions({ ...base, VITE_CANOPY_BASE_PATH: ' /trace/api/canopy ' });
    expect(options.basePath).toBe('/trace/api/canopy');
    expect(options.modules).toBeUndefined();
    expect(Object.keys(canopyDevProxy(options))).toEqual(['^/trace/api/canopy(?=[/?#]|$)']);
  });

  it('treats a root or blank base path as the per-module layout', () => {
    for (const raw of ['/', ' / ', '//', '   ']) {
      const env = { ...base, VITE_CANOPY_BASE_PATH: raw };
      const options = canopyProxyOptions(env);
      expect(options.basePath).toBeUndefined();
      expect(options.modules).toEqual(['/mole', '/hare', '/fox', '/magpie', '/vole']);
      // canopyDevProxy rejects a root prefix, so this would stop the dev server.
      expect(() => canopyDevProxy(options)).not.toThrow();
      expect(Object.keys(elogProxy(env))).toEqual(['^/elog/v1/apps/trace(?=[/?#]|$)']);
    }
  });

  it('drops trailing slashes from the deployed base path', () => {
    const options = canopyProxyOptions({ ...base, VITE_CANOPY_BASE_PATH: '/trace/api/canopy/' });
    expect(options.basePath).toBe('/trace/api/canopy');
  });

  it("doesn't let canopy-vite put an e-log key on all of /elog", () => {
    const previous = process.env.CANOPY_ELOG_API_KEY;
    process.env.CANOPY_ELOG_API_KEY = 'elog-key';
    try {
      const options = canopyProxyOptions({ ...base, VITE_CANOPY_BASE_PATH: '/trace/api/canopy' });
      expect(Object.keys(canopyDevProxy(options))).toEqual(['^/trace/api/canopy(?=[/?#]|$)']);
    } finally {
      if (previous === undefined) delete process.env.CANOPY_ELOG_API_KEY;
      else process.env.CANOPY_ELOG_API_KEY = previous;
    }
  });
});

describe('elogProxy', () => {
  const KEY = '^/elog/v1/apps/trace(?=[/?#]|$)';

  it("proxies only Trace's e-log app path, REST only", () => {
    const proxy = elogProxy(base);
    expect(Object.keys(proxy)).toEqual([KEY]);
    expect(proxy[KEY].target).toBe('http://canopy.test:9000');
    expect(proxy[KEY].ws).toBe(false);
    expect(proxy[KEY].rewrite).toBeUndefined();
  });

  it('sends CANOPY_ELOG_API_KEY, or CANOPY_API_KEY when it is unset', () => {
    const path = '/elog/v1/apps/trace/config';
    expect(forwardedHeaders(elogProxy({ ...base, CANOPY_ELOG_API_KEY: 'e' })[KEY], path)).toEqual({
      'X-API-Key': 'e',
    });
    expect(forwardedHeaders(elogProxy(base)[KEY], path)).toEqual({ 'X-API-Key': 'k' });
    expect(forwardedHeaders(elogProxy({ ...base, CANOPY_ELOG_API_KEY: '' })[KEY], path)).toEqual({
      'X-API-Key': 'k',
    });
  });

  it('drops the key when the path leaves the app path', () => {
    const route = elogProxy({ ...base, CANOPY_ELOG_API_KEY: 'e' })[KEY];
    expect(forwardedHeaders(route, '/elog/v1/apps/trace/../other/entries')).toEqual({});
    expect(forwardedHeaders(route, '/elog/v1/apps/trace/%2e%2e/other/entries')).toEqual({});
    expect(forwardedHeaders(route, '/elog/v1/apps/trace')).toEqual({ 'X-API-Key': 'e' });
    expect(forwardedHeaders(route, '/elog/v1/apps/trace?x=1')).toEqual({ 'X-API-Key': 'e' });
  });

  it('refuses cross-origin requests like the Canopy routes', () => {
    const route = elogProxy({ ...base, CANOPY_ELOG_API_KEY: 'e' })[KEY];
    const crossOrigin = { headers: { origin: 'http://evil.example', host: 'localhost:5173' } };
    expect(forwardedHeaders(route, '/elog/v1/apps/trace/config', crossOrigin)).toEqual({});
    const bypass = route.bypass as (req: unknown, res: unknown) => unknown;
    expect(bypass(crossOrigin, undefined)).toBe(false);
  });

  it('sits under VITE_CANOPY_BASE_PATH and strips it, like the Canopy route', () => {
    const proxy = elogProxy({ ...base, VITE_CANOPY_BASE_PATH: '/trace/api/canopy/' });
    const key = '^/trace/api/canopy/elog/v1/apps/trace(?=[/?#]|$)';
    expect(Object.keys(proxy)).toEqual([key]);
    expect(proxy[key].rewrite!('/trace/api/canopy/elog/v1/apps/trace/config')).toBe(
      '/elog/v1/apps/trace/config'
    );
  });
});
