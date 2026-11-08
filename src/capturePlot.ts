import { getInstanceByDom } from 'echarts';
import { captureChartPng, chartThemeFor } from '@slaclab/canopy-charts';
import type { Plot } from './types';
import { effectiveBackground } from './plotBackground';

/**
 * Snapshot a mounted plot's chart as a PNG data URL. The effective background
 * (theme default or user override) is baked into the image so the result is
 * legible on paper in both dark and light mode. Returns null when the plot's
 * chart isn't mounted in this document (e.g. detached to its own window), or
 * when canopy-charts' captureChartPng can't get an image (disposed chart,
 * ECharts error).
 *
 * When `preferFullscreen` is set, the popped-out copy is captured instead of
 * the in-window one. Both are mounted with the same `data-plot-id`, and the
 * in-window copy comes first in the DOM, so a plain query would grab the chart
 * the user isn't looking at (and in grid view it's a distorted tile).
 */
export function capturePlotPng(
  plot: Plot,
  colorMode: 'dark' | 'light',
  preferFullscreen = false
): string | null {
  const root =
    (preferFullscreen && document.querySelector(`[data-plot-id="${plot.id}"][data-fullscreen]`)) ||
    document.querySelector(`[data-plot-id="${plot.id}"]`);
  if (!root) return null;
  return captureChartPng(chartUnder(root), {
    background: effectiveBackground(plot.backgroundColor, chartThemeFor(colorMode)),
  });
}

/**
 * The ECharts instance mounted below a plot's `data-plot-id` wrapper. The
 * chart's host div isn't a fixed number of levels down (the chart component
 * may add wrappers of its own), so walk the wrapper's divs in document order
 * and take the first one ECharts was initialized on.
 */
function chartUnder(root: Element) {
  for (const el of root.querySelectorAll('div')) {
    const chart = getInstanceByDom(el);
    if (chart) return chart;
  }
  return undefined;
}
