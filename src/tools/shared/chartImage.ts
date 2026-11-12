// Image export of a context tool's chart (Correlation, Waveform) and the
// browser download both exports go through.
//
// Export PNG and Post to e-log compose the drawings over the chart through the
// multi-overlay composer: every `svg[data-annotation-layer]` in the plot box,
// each at its own offset. With drawings hidden (Hide all), or nothing to
// compose, the chart image is returned synchronously.

import { composeOverlayPng } from '../../plot/capture';
import type { PngSource, PngSourceOptions } from '../chartElogPost';

/** Offer `href` to the browser as a download. */
export function downloadHref(href: string, fileName: string): void {
  const a = document.createElement('a');
  a.href = href;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** What an image export needs of the ECharts instance. */
export interface ChartImage {
  getDataURL(opts: PngSourceOptions): string;
  getWidth?(): number;
  getHeight?(): number;
  /** The chart's own div; its parent is the plot box holding the drawing svgs. */
  getDom?(): HTMLElement | null | undefined;
}

/** Every drawing overlay svg inside `root` (one per grid). */
export function overlaySvgs(root: ParentNode | null | undefined): SVGSVGElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll('svg[data-annotation-layer]')).filter(
    (el): el is SVGSVGElement => el instanceof SVGSVGElement
  );
}

/**
 * The chart as a PNG source with its drawings composed on top. `root` is the
 * element holding the overlay svgs, by default the chart div's parent (the
 * plot box). Hidden drawings, no overlay, or a chart image that is not a
 * data URL yield the chart's own (sync) data URL; a failed compose resolves
 * to the chart image.
 */
export function chartPngSource(
  chart: ChartImage,
  drawingsHidden: boolean,
  root?: ParentNode | null
): PngSource {
  return {
    getDataURL(opts) {
      const dataUrl = chart.getDataURL(opts);
      if (drawingsHidden || !dataUrl?.startsWith('data:')) return dataUrl;
      const svgs = overlaySvgs(root ?? chart.getDom?.()?.parentElement);
      if (svgs.length === 0) return dataUrl;
      return composeOverlayPng(dataUrl, svgs, opts.backgroundColor, {
        width: chart.getWidth?.(),
        height: chart.getHeight?.(),
        pixelRatio: opts.pixelRatio,
      }).catch(() => dataUrl);
    },
  };
}
