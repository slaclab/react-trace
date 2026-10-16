// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { capturePlotPng } from './capturePlot';
import type { Plot } from './types';

// getInstanceByDom is replaced by a lookup into charts registered per host
// element; jsdom has no canvas for real ECharts instances.
const h = vi.hoisted(() => ({
  charts: new Map<Element, { getDataURL: (opts: unknown) => string }>(),
}));

vi.mock('echarts', () => ({
  getInstanceByDom: (el: Element) => h.charts.get(el),
}));

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

function plot(backgroundColor = '#161616'): Plot {
  return {
    id: 'p1',
    title: 'Plot 1',
    traces: [],
    axes: [],
    backgroundColor,
    showLegend: true,
    showXGridlines: true,
    showYGridlines: true,
    showCrosshair: true,
    gridStyle: 'solid',
    gridOpacity: 1,
    tickFontSize: 11,
    xAxis: { timeRange: '-1h' },
  };
}

// Mount a SinglePlot-shaped wrapper: [data-plot-id] > (chart host div).
function mountChart(opts: { fullscreen?: boolean; dataUrl?: string } = {}) {
  const wrap = document.createElement('div');
  wrap.dataset.plotId = 'p1';
  if (opts.fullscreen) wrap.dataset.fullscreen = 'true';
  const host = document.createElement('div');
  wrap.appendChild(host);
  document.body.appendChild(wrap);
  const getDataURL = vi.fn(() => opts.dataUrl ?? PNG);
  h.charts.set(host, { getDataURL });
  return getDataURL;
}

beforeEach(() => {
  h.charts.clear();
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('capturePlotPng', () => {
  it('returns null when the plot is not mounted in this document', () => {
    expect(capturePlotPng(plot(), 'dark')).toBeNull();
  });

  it('captures at pixel ratio 2 with the theme background for a default plot', () => {
    const getDataURL = mountChart();
    expect(capturePlotPng(plot(), 'dark')).toBe(PNG);
    expect(getDataURL).toHaveBeenLastCalledWith({
      type: 'png',
      pixelRatio: 2,
      backgroundColor: '#161616',
    });
    capturePlotPng(plot(), 'light');
    expect(getDataURL).toHaveBeenLastCalledWith(
      expect.objectContaining({ backgroundColor: '#f4f4f4' })
    );
  });

  it('keeps a user-chosen background', () => {
    const getDataURL = mountChart();
    capturePlotPng(plot('#123456'), 'light');
    expect(getDataURL).toHaveBeenLastCalledWith(
      expect.objectContaining({ backgroundColor: '#123456' })
    );
  });

  it('prefers the fullscreen copy when asked, the in-window one otherwise', () => {
    const inWindow = mountChart({ dataUrl: 'data:image/png;base64,aW4=' });
    const fullscreen = mountChart({ fullscreen: true, dataUrl: 'data:image/png;base64,ZnM=' });
    expect(capturePlotPng(plot(), 'dark', true)).toBe('data:image/png;base64,ZnM=');
    expect(fullscreen).toHaveBeenCalledTimes(1);
    expect(capturePlotPng(plot(), 'dark')).toBe('data:image/png;base64,aW4=');
    expect(inWindow).toHaveBeenCalledTimes(1);
  });

  it('returns null instead of throwing when the chart yields no image', () => {
    mountChart({ dataUrl: '' });
    expect(capturePlotPng(plot(), 'dark')).toBeNull();
  });
});
