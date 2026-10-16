import { describe, expect, it } from 'vitest';
import { canopyDevProxy } from '@slaclab/canopy-vite';
import { canopyProxyOptions } from './vite.config';

const base = { CANOPY_BASE_URL: 'http://canopy.test:9000', CANOPY_API_KEY: 'k' };

describe('canopyProxyOptions', () => {
  it('proxies /mole, /hare and /fox when no Canopy base path is set', () => {
    const options = canopyProxyOptions({ ...base, ELOG_BASE_URL: '' });
    expect(options).toMatchObject({
      target: 'http://canopy.test:9000',
      apiKey: 'k',
      modules: ['/mole', '/hare', '/fox'],
    });
    expect(options.basePath).toBeUndefined();
    const proxy = canopyDevProxy({ ...options, elog: { ...options.elog, target: '' } });
    expect(Object.keys(proxy)).toEqual([
      '^/mole(?=[/?#]|$)',
      '^/hare(?=[/?#]|$)',
      '^/fox(?=[/?#]|$)',
    ]);
    expect(Object.values(proxy).every((route) => route.ws === true)).toBe(true);
  });

  it('switches to the single deployed prefix when VITE_CANOPY_BASE_PATH is set', () => {
    const options = canopyProxyOptions({ ...base, VITE_CANOPY_BASE_PATH: ' /trace/api/canopy ' });
    expect(options.basePath).toBe('/trace/api/canopy');
    expect(options.modules).toBeUndefined();
    const proxy = canopyDevProxy({ ...options, elog: { ...options.elog, target: '' } });
    expect(Object.keys(proxy)).toEqual(['^/trace/api/canopy(?=[/?#]|$)']);
  });

  it('adds the /elog route only when an e-log target is configured', () => {
    const withElog = canopyDevProxy(
      canopyProxyOptions({ ...base, ELOG_BASE_URL: 'http://elog.test', ELOG_API_KEY: 't' })
    );
    expect(Object.keys(withElog)).toContain('^/elog(?=[/?#]|$)');
    expect(withElog['^/elog(?=[/?#]|$)'].target).toBe('http://elog.test');
  });
});
