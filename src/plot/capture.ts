// PNG capture of the drawings: every overlay svg of a plot over its chart image.
//
// ECharts' getDataURL only sees its own canvas, so the annotation overlays
// (one absolutely positioned <svg data-annotation-layer> per grid, each at its
// own grid origin) are composed over the chart image here: each overlay is
// cloned, given an explicit `font-family` (resolved from getComputedStyle,
// since the serialized svg is rendered as an isolated image with no inherited
// CSS) and placed in its own <g> translated to its own offset, all inside one
// <svg> sized to the chart canvas. The chart image, then that one overlay
// image, are drawn onto a canvas of chart size x pixel ratio — so a single
// grid composes exactly as before.
//
// The overlay already carries its colours as inline attributes (hex from the
// chart theme / each drawing's stored colour), so nothing is restyled here.
// No colour literals (src/plot is literal-guarded): the background is
// the caller's.

const SVG_NS = 'http://www.w3.org/2000/svg';

export interface ComposeOptions {
  /** Chart CSS width in px; defaults to the chart image width / pixelRatio. */
  width?: number;
  /** Chart CSS height in px; defaults to the chart image height / pixelRatio. */
  height?: number;
  /** The pixel ratio the chart image was rendered at (default 2). */
  pixelRatio?: number;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load capture image'));
    img.src = src;
  });
}

function px(v: string | null | undefined): number {
  const n = parseFloat(v ?? '');
  return Number.isFinite(n) ? n : 0;
}

/** One overlay svg, or every overlay svg inside a plot root. */
export type OverlaySvgs = SVGSVGElement | readonly SVGSVGElement[];

function asList(svgs: OverlaySvgs): readonly SVGSVGElement[] {
  return Array.isArray(svgs) ? svgs : [svgs as SVGSVGElement];
}

function fontFamilyOf(svg: SVGSVGElement): string {
  const computed = typeof getComputedStyle === 'function' ? getComputedStyle(svg) : null;
  return computed?.fontFamily || 'sans-serif';
}

/**
 * Serialize the overlay `svgs` into one standalone SVG document `width` x
 * `height` (CSS px), each overlay in its own `<g>` translated to its own grid
 * origin (its `style.left` / `style.top`), in the given (DOM) order.
 */
export function overlaySvgMarkup(svgs: OverlaySvgs, width: number, height: number): string {
  const list = asList(svgs);
  const doc = document.implementation.createDocument(SVG_NS, 'svg', null);
  const root = doc.documentElement;
  root.setAttribute('width', String(width));
  root.setAttribute('height', String(height));
  root.setAttribute('viewBox', `0 0 ${width} ${height}`);
  root.setAttribute('font-family', list.length > 0 ? fontFamilyOf(list[0]) : 'sans-serif');

  for (const svg of list) {
    const left = px(svg.style.left);
    const top = px(svg.style.top);
    const fontFamily = fontFamilyOf(svg);
    const clone = svg.cloneNode(true) as SVGSVGElement;
    // Layout-only inline style (position, pointer-events) means nothing in an
    // isolated image; the width/height/viewBox attributes keep the clip.
    clone.removeAttribute('style');
    // Interactive bits (a readout's grip) are not part of the figure.
    for (const el of Array.from(clone.querySelectorAll('[data-capture-skip]'))) el.remove();
    clone.setAttribute('font-family', fontFamily);
    for (const t of Array.from(clone.querySelectorAll('text'))) {
      if (!t.getAttribute('font-family')) t.setAttribute('font-family', fontFamily);
    }
    const g = doc.createElementNS(SVG_NS, 'g');
    g.setAttribute('transform', `translate(${left}, ${top})`);
    g.appendChild(doc.importNode(clone, true));
    root.appendChild(g);
  }
  return new XMLSerializer().serializeToString(doc);
}

/**
 * Compose the annotation overlay(s) `svgs` — one svg, or every overlay svg of
 * a plot, each at its own offset — over the chart PNG `chartDataUrl`,
 * returning a PNG data URL of the chart's size x pixel ratio. An empty list
 * yields the chart over the background.
 */
export async function composeOverlayPng(
  chartDataUrl: string,
  svgs: OverlaySvgs,
  background: string,
  opts: ComposeOptions = {}
): Promise<string> {
  const ratio = opts.pixelRatio ?? 2;
  const chart = await loadImage(chartDataUrl);
  const width = opts.width ?? chart.width / ratio;
  const height = opts.height ?? chart.height / ratio;
  const list = asList(svgs);
  const overlay =
    list.length > 0
      ? await loadImage(
          `data:image/svg+xml;charset=utf-8,${encodeURIComponent(overlaySvgMarkup(list, width, height))}`
        )
      : null;

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(chart, 0, 0, canvas.width, canvas.height);
  if (overlay) ctx.drawImage(overlay, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/png');
}
