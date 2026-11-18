// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { capturePlotPng, registerPlotChart } from './capturePlot';
import type { Plot } from './types';

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

// Mount a plot's data-plot-id wrapper and register a chart for it, as
// SinglePlot does. jsdom has no canvas for real ECharts instances, so the
// chart is a fake getDataURL; '' is what SinglePlot's source returns while its
// chart isn't ready.
function mountChart(opts: { fullscreen?: boolean; dataUrl?: string } = {}) {
  const wrap = document.createElement('div');
  wrap.dataset.plotId = 'p1';
  if (opts.fullscreen) wrap.dataset.fullscreen = 'true';
  document.body.appendChild(wrap);
  const getDataURL = vi.fn(() => opts.dataUrl ?? PNG);
  const unregister = registerPlotChart(wrap, { getDataURL });
  return { getDataURL, unregister };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('capturePlotPng', () => {
  it('returns null when the plot is not mounted in this document', () => {
    expect(capturePlotPng(plot(), 'dark')).toBeNull();
  });

  it('captures at pixel ratio 2 with the theme background for a default plot', () => {
    const { getDataURL } = mountChart();
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
    const { getDataURL } = mountChart();
    capturePlotPng(plot('#123456'), 'light');
    expect(getDataURL).toHaveBeenLastCalledWith(
      expect.objectContaining({ backgroundColor: '#123456' })
    );
  });

  it('captures the fullscreen copy when asked, the in-window one otherwise', () => {
    const inWindow = mountChart({ dataUrl: 'data:image/png;base64,aW4=' });
    const fullscreen = mountChart({ fullscreen: true, dataUrl: 'data:image/png;base64,ZnM=' });
    expect(capturePlotPng(plot(), 'dark', true)).toBe('data:image/png;base64,ZnM=');
    expect(fullscreen.getDataURL).toHaveBeenCalledTimes(1);
    expect(capturePlotPng(plot(), 'dark')).toBe('data:image/png;base64,aW4=');
    expect(inWindow.getDataURL).toHaveBeenCalledTimes(1);
  });

  it('returns null while the plot is mounted but its chart is not ready', () => {
    mountChart({ dataUrl: '' });
    expect(capturePlotPng(plot(), 'dark')).toBeNull();
  });

  it('returns null for a plot wrapper with no chart registered', () => {
    const wrap = document.createElement('div');
    wrap.dataset.plotId = 'p1';
    document.body.appendChild(wrap);
    expect(capturePlotPng(plot(), 'dark')).toBeNull();
  });

  it('returns null once the plot unregisters its chart', () => {
    const { getDataURL, unregister } = mountChart();
    unregister();
    expect(capturePlotPng(plot(), 'dark')).toBeNull();
    expect(getDataURL).not.toHaveBeenCalled();
  });

  it('does not fall back to the in-window copy while the fullscreen chart is not ready', () => {
    const inWindow = mountChart();
    mountChart({ fullscreen: true, dataUrl: '' });
    expect(capturePlotPng(plot(), 'dark', true)).toBeNull();
    expect(inWindow.getDataURL).not.toHaveBeenCalled();
  });

  it('does not fall back to the in-window copy while the fullscreen copy is not mounted', () => {
    const inWindow = mountChart();
    expect(capturePlotPng(plot(), 'dark', true)).toBeNull();
    expect(inWindow.getDataURL).not.toHaveBeenCalled();
  });

  it('returns null instead of throwing when the chart fails to render an image', () => {
    const { getDataURL } = mountChart();
    getDataURL.mockImplementation(() => {
      throw new Error('ECharts failed');
    });
    expect(capturePlotPng(plot(), 'dark')).toBeNull();
  });
});
