import { captureChartPng, chartThemeFor } from '@slaclab/canopy-charts';
import type { Plot } from './types';
import type { PngSource } from './io/exportPlotImage';
import { effectiveBackground } from './plotBackground';

// Each mounted plot's chart, keyed by its data-plot-id wrapper. SinglePlot
// registers the same source it publishes to the app, which reads the instance
// CanopyChart reported ready, so capture never goes looking for an ECharts
// instance in the DOM.
const chartSources = new WeakMap<Element, PngSource>();

/**
 * Make `source` the chart captured for the plot wrapper `wrapper` (the element
 * carrying data-plot-id). Returns the unregister function.
 */
export function registerPlotChart(wrapper: Element, source: PngSource): () => void {
  chartSources.set(wrapper, source);
  return () => {
    chartSources.delete(wrapper);
  };
}

/**
 * Snapshot a mounted plot's chart as a PNG data URL. The effective background
 * (theme default or user override) is baked into the image so the result is
 * legible on paper in both dark and light mode. Returns null when the plot's
 * chart isn't mounted in this document (e.g. detached to its own window), or
 * when canopy-charts' captureChartPng can't get an image (chart not ready yet,
 * disposed, ECharts error).
 *
 * When `fullscreen` is set, only the popped-out copy is captured. Both copies
 * are mounted with the same `data-plot-id`, and the in-window copy comes first
 * in the DOM, so a plain query would grab the chart the user isn't looking at
 * (and in grid view it's a distorted tile). While the fullscreen copy isn't
 * mounted (e.g. its chart crashed and the error boundary replaced it), the
 * result is null rather than the in-window copy hidden behind the overlay.
 */
export function capturePlotPng(
  plot: Plot,
  colorMode: 'dark' | 'light',
  fullscreen = false
): string | null {
  const selector = fullscreen
    ? `[data-plot-id="${plot.id}"][data-fullscreen]`
    : `[data-plot-id="${plot.id}"]`;
  const wrapper = document.querySelector(selector);
  if (!wrapper) return null;
  return captureChartPng(chartSources.get(wrapper), {
    background: effectiveBackground(plot.backgroundColor, chartThemeFor(colorMode)),
  });
}
