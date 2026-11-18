import { captureChartPng, chartThemeFor } from '@slaclab/canopy-charts';
import type { Plot } from './types';
import { effectiveBackground } from './plotBackground';
import { composeOverlayPng } from './plot/capture';

/** The pixel ratio of every plot capture (print, export, copy, e-log). */
export const PLOT_CAPTURE_PIXEL_RATIO = 2;

/** The part of an ECharts instance a capture reads. */
export interface CapturableChart {
  getDataURL(opts: { type: 'png'; pixelRatio: number; backgroundColor: string }): string;
  getWidth(): number;
  getHeight(): number;
}

// Each mounted plot's chart, keyed by its data-plot-id wrapper. SinglePlot
// registers a proxy over the instance CanopyChart reported ready, so capture
// never goes looking for an ECharts instance in the DOM.
const chartSources = new WeakMap<Element, CapturableChart>();

/**
 * Make `chart` the chart captured for the plot wrapper `wrapper` (the element
 * carrying data-plot-id). Returns the unregister function.
 */
export function registerPlotChart(wrapper: Element, chart: CapturableChart): () => void {
  chartSources.set(wrapper, chart);
  return () => {
    chartSources.delete(wrapper);
  };
}

/**
 * The chart as a PNG data URL with its drawings (every
 * `svg[data-annotation-layer]` overlay under `root`, one per grid) composed on
 * top, on `background`. The chart itself is captured by canopy-charts'
 * captureChartPng, so a disposed chart or an ECharts error yields '' rather
 * than throwing. With `drawingsHidden` no overlay is composed. A failed
 * compose (image decode, no 2D context) still yields the chart alone.
 */
export async function composePlotCapture(
  root: ParentNode,
  chart: CapturableChart,
  background: string,
  pixelRatio: number = PLOT_CAPTURE_PIXEL_RATIO,
  drawingsHidden = false
): Promise<string> {
  const dataUrl = captureChartPng(chart, { background, pixelRatio }) ?? '';
  if (drawingsHidden || dataUrl === '') return dataUrl;
  const svgs = Array.from(root.querySelectorAll('svg[data-annotation-layer]')).filter(
    (el): el is SVGSVGElement => el instanceof SVGSVGElement
  );
  if (svgs.length === 0) return dataUrl;
  try {
    return await composeOverlayPng(dataUrl, svgs.length === 1 ? svgs[0] : svgs, background, {
      width: chart.getWidth(),
      height: chart.getHeight(),
      pixelRatio,
    });
  } catch {
    return dataUrl;
  }
}

/**
 * Snapshot a mounted plot's chart as a PNG data URL, drawings composed on top
 * (`composePlotCapture`). The effective background (theme default or user
 * override) is baked into the image so the result is legible on paper in
 * both dark and light mode. Resolves null when the plot's chart isn't mounted
 * in this document (e.g. detached to its own window), or when canopy-charts'
 * captureChartPng can't get an image (chart not ready yet, disposed, ECharts
 * error).
 *
 * When `fullscreen` is set, only the popped-out copy is captured. Both copies
 * are mounted with the same `data-plot-id`, and the in-window copy comes first
 * in the DOM, so a plain query would grab the chart the user isn't looking at
 * (and in grid view it's a distorted tile). While the fullscreen copy isn't
 * mounted (e.g. its chart crashed and an error boundary replaced it), the
 * result is null rather than the in-window copy hidden behind the overlay.
 *
 * The chart is the one registered for the wrapper (`registerPlotChart`), not
 * one found in the DOM, so chrome mounted around the chart (a rail, badges)
 * cannot hide it, and a wrapper with nothing registered yields null. With
 * `annotationsHidden` (hide all) no overlay is composed.
 */
export async function capturePlotPng(
  plot: Plot,
  colorMode: 'dark' | 'light',
  fullscreen = false,
  annotationsHidden = false
): Promise<string | null> {
  const root = document.querySelector(
    fullscreen ? `[data-plot-id="${plot.id}"][data-fullscreen]` : `[data-plot-id="${plot.id}"]`
  );
  if (!root) return null;
  const chart = chartSources.get(root);
  if (!chart) return null;
  const background = effectiveBackground(plot.backgroundColor, chartThemeFor(colorMode));
  const dataUrl = await composePlotCapture(
    root,
    chart,
    background,
    PLOT_CAPTURE_PIXEL_RATIO,
    annotationsHidden
  );
  return dataUrl === '' ? null : dataUrl;
}
