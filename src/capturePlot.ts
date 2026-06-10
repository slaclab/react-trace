import { getInstanceByDom } from 'echarts';
import type { Plot } from './types';
import { DARK_CHART_THEME, LIGHT_CHART_THEME, effectiveBackground } from './chartTheme';

/**
 * Snapshot a mounted plot's chart as a PNG data URL. The effective background
 * (theme default or user override) is baked into the image so the result is
 * legible on paper in both dark and light mode. Returns null when the plot's
 * chart isn't mounted in this document (e.g. detached to its own window).
 */
export function capturePlotPng(plot: Plot, colorMode: 'dark' | 'light'): string | null {
  const host = document.querySelector(`[data-plot-id="${plot.id}"] > div`);
  if (!(host instanceof HTMLElement)) return null;
  const chart = getInstanceByDom(host);
  if (!chart) return null;
  const theme = colorMode === 'dark' ? DARK_CHART_THEME : LIGHT_CHART_THEME;
  return chart.getDataURL({
    type: 'png',
    pixelRatio: 2,
    backgroundColor: effectiveBackground(plot.backgroundColor, theme),
  });
}
