import { describe, expect, it } from 'vitest';
import { createChartRegistry } from './chartRegistry';
import type { PngSource } from './exportPlotImage';

function source(name: string): PngSource {
  return { getDataURL: () => `data:image/png;base64,${name}` };
}

describe('createChartRegistry', () => {
  it('falls back to the in-window copy when the fullscreen copy unmounts', () => {
    const registry = createChartRegistry();
    const inWindow = source('in-window');
    const fullscreen = source('fullscreen');

    registry.register('plot-1', inWindow);
    registry.register('plot-1', fullscreen, true);
    expect(registry.get('plot-1')).toBe(fullscreen);

    registry.unregister('plot-1', fullscreen);
    expect(registry.get('plot-1')).toBe(inWindow);
  });

  it('prefers the fullscreen copy even if the in-window copy remounts after it', () => {
    const registry = createChartRegistry();
    const first = source('first');
    const fullscreen = source('fullscreen');
    const remounted = source('remounted');

    registry.register('plot-1', first);
    registry.register('plot-1', fullscreen, true);
    registry.unregister('plot-1', first);
    registry.register('plot-1', remounted);
    expect(registry.get('plot-1')).toBe(fullscreen);

    registry.unregister('plot-1', fullscreen);
    expect(registry.get('plot-1')).toBe(remounted);
  });

  it('uses the most recent copy when none is fullscreen', () => {
    const registry = createChartRegistry();
    const a = source('a');
    const b = source('b');

    registry.register('plot-1', a);
    registry.register('plot-1', b);
    expect(registry.get('plot-1')).toBe(b);

    registry.unregister('plot-1', b);
    expect(registry.get('plot-1')).toBe(a);
  });

  it('forgets a plot once every copy unmounts', () => {
    const registry = createChartRegistry();
    const inWindow = source('in-window');
    const fullscreen = source('fullscreen');

    registry.register('plot-1', inWindow);
    registry.register('plot-1', fullscreen, true);
    registry.unregister('plot-1', inWindow);
    registry.unregister('plot-1', fullscreen);
    expect(registry.get('plot-1')).toBeUndefined();
  });

  it('ignores unregistering a source that is not registered', () => {
    const registry = createChartRegistry();
    const live = source('live');

    registry.register('plot-1', live);
    registry.unregister('plot-1', source('stale'));
    registry.unregister('plot-2', live);
    expect(registry.get('plot-1')).toBe(live);
    expect(registry.get('plot-2')).toBeUndefined();
  });

  it('keeps plots separate', () => {
    const registry = createChartRegistry();
    const one = source('one');
    const two = source('two');

    registry.register('plot-1', one);
    registry.register('plot-2', two, true);
    expect(registry.get('plot-1')).toBe(one);
    expect(registry.get('plot-2')).toBe(two);
  });
});
