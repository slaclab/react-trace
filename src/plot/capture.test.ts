// @vitest-environment jsdom
// PNG capture of the drawings. jsdom has no canvas: Image and the 2D context are stubbed, and the composed SVG is
// decoded from the data URL handed to the second Image.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const charts = vi.hoisted(() => new Map<Element, unknown>());
vi.mock('echarts', () => ({
  getInstanceByDom: (el: Element) => charts.get(el),
}));

import { composeOverlayPng } from './capture';
import { capturePlotPng } from '../capturePlot';
import { capturePlots } from '../io/exportPlotImage';
import { drawingThemeFor } from '../annotationTheme';
import type { Plot } from '../types';

const CHART_URL = 'data:image/png;base64,CHART';
const COMPOSED_URL = 'data:image/png;base64,COMPOSED';
const SVG_NS = 'http://www.w3.org/2000/svg';

class StubImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  width = 600;
  height = 400;
  private _src = '';
  get src() {
    return this._src;
  }
  set src(v: string) {
    this._src = v;
    queueMicrotask(() => this.onload?.());
  }
}

let drawImage: ReturnType<typeof vi.fn>;
let fillRect: ReturnType<typeof vi.fn>;
let canvases: HTMLCanvasElement[];

beforeEach(() => {
  vi.stubGlobal('Image', StubImage);
  drawImage = vi.fn();
  fillRect = vi.fn();
  canvases = [];
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
    this: HTMLCanvasElement
  ) {
    canvases.push(this);
    return { drawImage, fillRect, fillStyle: '' } as unknown as CanvasRenderingContext2D;
  } as unknown as HTMLCanvasElement['getContext']);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(COMPOSED_URL);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  charts.clear();
  document.body.innerHTML = '';
});

/** An overlay svg as AnnotationLayer renders it: at the grid origin, inline attributes. */
function overlay(left = 48, top = 12, id = 'ann-1'): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
  svg.setAttribute('data-annotation-layer', '');
  svg.setAttribute('width', '200');
  svg.setAttribute('height', '150');
  svg.style.position = 'absolute';
  svg.style.left = `${left}px`;
  svg.style.top = `${top}px`;
  const inner = document.createElementNS(SVG_NS, 'g');
  inner.setAttribute('transform', `translate(${-left} ${-top})`);
  const drawing = document.createElementNS(SVG_NS, 'g');
  drawing.setAttribute('data-annotation-id', id);
  const line = document.createElementNS(SVG_NS, 'line');
  line.setAttribute('stroke', drawingThemeFor('dark').annotation.palette[0]);
  const text = document.createElementNS(SVG_NS, 'text');
  text.setAttribute('font-size', '11');
  text.textContent = 'note';
  drawing.append(line, text);
  inner.append(drawing);
  svg.append(inner);
  return svg;
}

function decodeSvg(src: string): string {
  const prefix = 'data:image/svg+xml;charset=utf-8,';
  expect(src.startsWith(prefix)).toBe(true);
  return decodeURIComponent(src.slice(prefix.length));
}

describe('composeOverlayPng', () => {
  it('draws the chart, then the serialized overlay, on a chart x ratio canvas', async () => {
    const svg = overlay(48, 12);
    document.body.append(svg);
    const out = await composeOverlayPng(CHART_URL, svg, '#161616', {
      width: 300,
      height: 200,
      pixelRatio: 2,
    });
    expect(out).toBe(COMPOSED_URL);
    expect(drawImage).toHaveBeenCalledTimes(2);
    const [first, second] = drawImage.mock.calls.map((c) => c[0] as StubImage);
    expect(first.src).toBe(CHART_URL);
    const markup = decodeSvg(second.src);
    expect(markup).toContain('data-annotation-id="ann-1"');
    expect(markup).toContain(`stroke="${drawingThemeFor('dark').annotation.palette[0]}"`);
    expect(markup).toContain('translate(48, 12)');
    expect(markup).toMatch(/<text[^>]*font-family=/);
    expect(markup).not.toContain('position');
    expect(canvases[0].width).toBe(600);
    expect(canvases[0].height).toBe(400);
    // The background is painted before the chart.
    expect(fillRect).toHaveBeenCalledWith(0, 0, 600, 400);
  });

  it('composes two grids: each overlay in its own group at its own offset, one overlay image', async () => {
    const top = overlay(48, 12, 'ann-top');
    const bottom = overlay(48, 210, 'ann-bottom');
    document.body.append(top, bottom);
    const out = await composeOverlayPng(CHART_URL, [top, bottom], '#161616', {
      width: 300,
      height: 400,
      pixelRatio: 2,
    });
    expect(out).toBe(COMPOSED_URL);
    // Chart, then one composed overlay image holding both grids.
    expect(drawImage).toHaveBeenCalledTimes(2);
    const markup = decodeSvg((drawImage.mock.calls[1][0] as StubImage).src);
    const doc = new DOMParser().parseFromString(markup, 'image/svg+xml');
    const groups = Array.from(doc.documentElement.children);
    expect(groups.map((g) => g.getAttribute('transform'))).toEqual([
      'translate(48, 12)',
      'translate(48, 210)',
    ]);
    expect(groups[0].querySelector('[data-annotation-id="ann-top"]')).not.toBeNull();
    expect(groups[0].querySelector('[data-annotation-id="ann-bottom"]')).toBeNull();
    expect(groups[1].querySelector('[data-annotation-id="ann-bottom"]')).not.toBeNull();
    expect(doc.documentElement.getAttribute('viewBox')).toBe('0 0 300 400');
    expect(markup).not.toContain('position');
    expect(canvases[0].width).toBe(600);
    expect(canvases[0].height).toBe(800);
  });

  it('an empty overlay list draws only the chart', async () => {
    await composeOverlayPng(CHART_URL, [], '#161616', { width: 300, height: 200 });
    expect(drawImage).toHaveBeenCalledTimes(1);
    expect((drawImage.mock.calls[0][0] as StubImage).src).toBe(CHART_URL);
  });

  it('defaults the size to the chart image / pixel ratio', async () => {
    await composeOverlayPng(CHART_URL, overlay(), '#ffffff');
    expect(canvases[0].width).toBe(600);
    expect(canvases[0].height).toBe(400);
  });
});

function plot(id = 'p1'): Plot {
  return { id, title: 'Plot', traces: [] } as unknown as Plot;
}

/** A plot wrapper as SinglePlot renders it, with a rail div mounted first. */
function mountPlot(
  id: string,
  { fullscreen = false, withOverlay = true, dataUrl = CHART_URL, secondGrid = false } = {}
) {
  const wrap = document.createElement('div');
  wrap.setAttribute('data-plot-id', id);
  if (fullscreen) wrap.setAttribute('data-fullscreen', 'true');
  const rail = document.createElement('div');
  rail.setAttribute('data-drawing-rail', '');
  rail.append(document.createElement('div'));
  const hostWrap = document.createElement('div');
  hostWrap.setAttribute('data-chart-host', '');
  const host = document.createElement('div');
  hostWrap.append(host);
  wrap.append(rail, hostWrap);
  if (withOverlay) wrap.append(overlay());
  if (withOverlay && secondGrid) wrap.append(overlay(48, 110, 'ann-2'));
  document.body.append(wrap);
  const getDataURL = vi.fn(() => dataUrl);
  charts.set(host, { getDataURL, getWidth: () => 300, getHeight: () => 200 });
  return { getDataURL };
}

describe('capturePlotPng', () => {
  it('captures through [data-chart-host] even with a rail div first, composing the overlay', async () => {
    const { getDataURL } = mountPlot('p1');
    await expect(capturePlotPng(plot('p1'), 'dark')).resolves.toBe(COMPOSED_URL);
    expect(getDataURL).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'png',
        pixelRatio: 2,
        backgroundColor: drawingThemeFor('dark').bg,
      })
    );
    expect(drawImage).toHaveBeenCalledTimes(2);
    expect(canvases[0].width).toBe(600);
  });

  it('composes every overlay svg in the plot root (two grids)', async () => {
    mountPlot('p1', { secondGrid: true });
    await expect(capturePlotPng(plot('p1'), 'dark')).resolves.toBe(COMPOSED_URL);
    expect(drawImage).toHaveBeenCalledTimes(2);
    const markup = decodeSvg((drawImage.mock.calls[1][0] as StubImage).src);
    expect(markup).toContain('translate(48, 12)');
    expect(markup).toContain('translate(48, 110)');
    expect(markup).toContain('data-annotation-id="ann-1"');
    expect(markup).toContain('data-annotation-id="ann-2"');
  });

  it('hide-all yields the chart-only PNG', async () => {
    mountPlot('p1');
    await expect(capturePlotPng(plot('p1'), 'dark', false, true)).resolves.toBe(CHART_URL);
    expect(drawImage).not.toHaveBeenCalled();
  });

  it('a plot without an overlay svg yields the chart-only PNG', async () => {
    mountPlot('p1', { withOverlay: false });
    await expect(capturePlotPng(plot('p1'), 'light')).resolves.toBe(CHART_URL);
    expect(drawImage).not.toHaveBeenCalled();
  });

  it('prefers the fullscreen copy when asked', async () => {
    const inWindow = mountPlot('p1');
    const full = mountPlot('p1', { fullscreen: true });
    await capturePlotPng(plot('p1'), 'dark', true);
    expect(full.getDataURL).toHaveBeenCalled();
    expect(inWindow.getDataURL).not.toHaveBeenCalled();
  });

  it('resolves null when the plot is not mounted', async () => {
    await expect(capturePlotPng(plot('missing'), 'dark')).resolves.toBeNull();
  });
});

describe('capturePlots', () => {
  it('resolves with async sources', async () => {
    const captured = await capturePlots(
      [{ id: 'p1', title: 'Plot 1', instance: { getDataURL: async () => CHART_URL } }],
      '#161616'
    );
    expect(captured).toEqual([{ id: 'p1', title: 'Plot 1', dataUrl: CHART_URL }]);
  });
});
