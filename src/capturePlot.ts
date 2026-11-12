import { getInstanceByDom } from 'echarts';
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
 * captureChartPng can't get an image (disposed chart, ECharts error).
 *
 * When `preferFullscreen` is set, the popped-out copy is captured instead of
 * the in-window one. Both are mounted with the same `data-plot-id`, and the
 * in-window copy comes first in the DOM, so a plain query would grab the chart
 * the user isn't looking at (and in grid view it's a distorted tile).
 *
 * The ECharts host is found through `[data-chart-host] > div`, not the
 * wrapper's first child, so chrome mounted ahead of the chart (a rail) does not
 * break capture. With `annotationsHidden` (hide all) no overlay is composed.
 */
export async function capturePlotPng(
  plot: Plot,
  colorMode: 'dark' | 'light',
  preferFullscreen = false,
  annotationsHidden = false
): Promise<string | null> {
  const root =
    (preferFullscreen && document.querySelector(`[data-plot-id="${plot.id}"][data-fullscreen]`)) ||
    document.querySelector(`[data-plot-id="${plot.id}"]`);
  if (!root) return null;
  const host = root.querySelector('[data-chart-host] > div');
  if (!(host instanceof HTMLElement)) return null;
  const chart = getInstanceByDom(host);
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
