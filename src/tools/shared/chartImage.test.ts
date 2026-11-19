// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { chartPngSource, overlaySvgs } from './chartImage';

// The composer is mocked: jsdom has no canvas, and what is pinned here is
// which overlays reach it and when it is skipped.
const compose = vi.hoisted(() => ({
  calls: [] as { url: string; svgs: readonly SVGSVGElement[]; bg: string; opts: unknown }[],
  result: Promise.resolve('data:image/png;base64,COMPOSED') as Promise<string>,
}));
vi.mock('../../plot/capture', () => ({
  composeOverlayPng: (url: string, svgs: readonly SVGSVGElement[], bg: string, opts: unknown) => {
    compose.calls.push({ url, svgs, bg, opts });
    return compose.result;
  },
}));

describe('Export image with drawings', () => {
  const CHART_URL = 'data:image/png;base64,CHART';
  const OPTS = { type: 'png' as const, pixelRatio: 2, backgroundColor: '#123456' };

  /** A plot box: the chart div plus `layers` drawing svgs (and one unrelated svg). */
  function plotBox(layers: number) {
    const box = document.createElement('div');
    const dom = document.createElement('div');
    box.appendChild(dom);
    for (let i = 0; i < layers; i++) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('data-annotation-layer', '');
      box.appendChild(svg);
    }
    box.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'svg'));
    const getDataURL = vi.fn(() => CHART_URL);
    const instance = { getDataURL, getWidth: () => 640, getHeight: () => 400, getDom: () => dom };
    return { box, instance, getDataURL };
  }

  beforeEach(() => {
    compose.calls = [];
    compose.result = Promise.resolve('data:image/png;base64,COMPOSED');
  });

  it('finds every drawing layer of the plot box, and nothing without a root', () => {
    const { box } = plotBox(2);
    expect(overlaySvgs(box)).toHaveLength(2);
    expect(overlaySvgs(null)).toEqual([]);
    expect(overlaySvgs(undefined)).toEqual([]);
  });

  it('composes every overlay over the chart at the chart size', async () => {
    const { instance, getDataURL } = plotBox(2);
    const result = chartPngSource(instance, false).getDataURL(OPTS);
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBe('data:image/png;base64,COMPOSED');
    expect(getDataURL).toHaveBeenCalledWith(OPTS);
    expect(compose.calls).toHaveLength(1);
    expect(compose.calls[0].url).toBe(CHART_URL);
    expect(compose.calls[0].svgs).toHaveLength(2);
    expect(compose.calls[0].bg).toBe('#123456');
    expect(compose.calls[0].opts).toEqual({ width: 640, height: 400, pixelRatio: 2 });
  });

  it('exports the chart alone, synchronously, when drawings are hidden', () => {
    const { instance } = plotBox(2);
    expect(chartPngSource(instance, true).getDataURL(OPTS)).toBe(CHART_URL);
    expect(compose.calls).toEqual([]);
  });

  it('stays synchronous with no overlay, no root, or a non-data chart URL', () => {
    expect(chartPngSource(plotBox(0).instance, false).getDataURL(OPTS)).toBe(CHART_URL);
    const noDom = { getDataURL: () => CHART_URL, getWidth: () => 640, getHeight: () => 400 };
    expect(chartPngSource(noDom, false).getDataURL(OPTS)).toBe(CHART_URL);
    const { instance } = plotBox(1);
    const blank = { ...instance, getDataURL: () => '' };
    expect(chartPngSource(blank, false).getDataURL(OPTS)).toBe('');
    expect(compose.calls).toEqual([]);
  });

  it('uses an explicit overlay root over the chart DOM parent', async () => {
    const { instance } = plotBox(0);
    const other = plotBox(3).box;
    await chartPngSource(instance, false, other).getDataURL(OPTS);
    expect(compose.calls[0].svgs).toHaveLength(3);
  });

  it('falls back to the chart image when composing fails', async () => {
    compose.result = Promise.reject(new Error('decode'));
    const { instance } = plotBox(1);
    await expect(chartPngSource(instance, false).getDataURL(OPTS)).resolves.toBe(CHART_URL);
  });
});
