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
  const host =
    (preferFullscreen &&
      document.querySelector(`[data-plot-id="${plot.id}"][data-fullscreen] > div`)) ||
    document.querySelector(`[data-plot-id="${plot.id}"] > div`);
  if (!(host instanceof HTMLElement)) return null;
  return captureChartPng(getInstanceByDom(host), {
    background: effectiveBackground(plot.backgroundColor, chartThemeFor(colorMode)),
  });
}
