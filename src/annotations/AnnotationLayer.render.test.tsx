// @vitest-environment jsdom
// Annotation layer, render half: each kind at its projected coordinates,
// hidden / hide-all omitted, off-scale and hidden-axis skips, the draft opacity and the selection / lock visuals.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { ANNOTATION_INK, drawingThemeFor } from '../annotationTheme';
import { createProjectionStore, type Projection } from '../plot/geometry';
import { projectionOf } from '../plot/testUtils';
import type { Annotation } from './model';
import { AnnotationLayer, type AnnotationLayerProps } from './AnnotationLayer';
import { DRAFT_OPACITY } from './catalog/shapeKit';
import { DRAFT_ID } from './tools';
import { BUILTIN_CATALOG } from './catalog';
import { TIME_X_AXIS } from './catalog/xAxis';

const TRACE_LAYER = { catalog: BUILTIN_CATALOG, xAxis: TIME_X_AXIS };

afterEach(cleanup);

// Grid at (60, 20), 400 x 200. x = 60 + t/10; y on 'a' = 220 - v; on 'log',
// log10 with NaN for v <= 0 (as ECharts reports).
const GRID = { left: 60, top: 20, width: 400, height: 200 };
function fakeProjection(): Projection {
  return projectionOf({
    tToX: (t) => GRID.left + t / 10,
    xToT: (x) => (x - GRID.left) * 10,
    vToY: (v, axisId) =>
      axisId === 'a' ? 220 - v : axisId === 'log' ? (v > 0 ? 220 - 50 * Math.log10(v) : NaN) : NaN,
    yToV: (y, axisId) => (axisId === 'a' ? 220 - y : NaN),
    gridRect: GRID,
    axisIds: ['a', 'log'],
  });
}

function ann(over: Partial<Annotation> & Pick<Annotation, 'id' | 'kind' | 'points'>): Annotation {
  return { axisId: 'a', color: '#4589ff', width: 2, text: '', ...over };
}

function mount(props: Partial<AnnotationLayerProps> & { annotations: Annotation[] }) {
  const store = createProjectionStore(fakeProjection);
  const utils = render(
    <div style={{ position: 'relative' }}>
      <AnnotationLayer
        config={TRACE_LAYER}
        projectionStore={store}
        axes={[{ id: 'a' }, { id: 'log' }]}
        theme={drawingThemeFor('dark')}
        {...props}
      />
    </div>
  );
  act(() => store.bump());
  const q = (id: string) => utils.container.querySelector(`[data-annotation-id="${id}"]`);
  return { ...utils, store, q };
}

const firstPath = (el: Element | null) =>
  el?.querySelector('path[stroke]:not([stroke="transparent"])');

describe('AnnotationLayer render', () => {
  it('renders nothing before the projection is published', () => {
    const store = createProjectionStore(fakeProjection);
    const { container } = render(
      <AnnotationLayer
        config={TRACE_LAYER}
        projectionStore={store}
        annotations={[ann({ id: 'h', kind: 'hline', points: [{ t: 0, v: 100 }] })]}
        axes={[{ id: 'a' }]}
        theme={drawingThemeFor('dark')}
      />
    );
    expect(container.querySelector('svg')).toBeNull();
  });

  it('positions a pointer-transparent svg over the grid rect', () => {
    const { container } = mount({
      annotations: [ann({ id: 'h', kind: 'hline', points: [{ t: 0, v: 100 }] })],
    });
    const svg = container.querySelector('svg[data-annotation-layer]') as SVGSVGElement;
    expect(svg).not.toBeNull();
    expect(svg.style.position).toBe('absolute');
    expect(svg.style.left).toBe('60px');
    expect(svg.style.top).toBe('20px');
    expect(svg.style.width).toBe('400px');
    expect(svg.style.height).toBe('200px');
    expect(svg.style.pointerEvents).toBe('none');
    expect(svg.querySelector('g')?.getAttribute('transform')).toBe('translate(-60 -20)');
  });

  it('hline spans the grid width at the projected y', () => {
    const { q } = mount({
      annotations: [
        ann({ id: 'h', kind: 'hline', points: [{ t: 0, v: 100 }], text: 'lim', dash: true }),
      ],
    });
    const g = q('h');
    expect(g?.getAttribute('data-annotation-kind')).toBe('hline');
    const p = firstPath(g);
    expect(p?.getAttribute('d')).toBe('M60 120H460');
    expect(p?.getAttribute('stroke')).toBe('#4589ff');
    expect(p?.getAttribute('stroke-width')).toBe('2');
    expect(p?.getAttribute('stroke-dasharray')).toBe('2 2');
    expect(g?.querySelector('text')?.textContent).toBe('lim');
    const hit = g?.querySelector('path[stroke="transparent"]');
    expect(hit?.getAttribute('d')).toBe('M60 120H460');
    expect(hit?.getAttribute('pointer-events')).toBe('stroke');
  });

  it('vline covers the full grid height at the projected x', () => {
    const { q } = mount({
      annotations: [ann({ id: 'v', kind: 'vline', points: [{ t: 1000, v: 0 }] })],
    });
    expect(firstPath(q('v'))?.getAttribute('d')).toBe('M160 20V220');
  });

  it('trange shades the full height between both edges with a duration label', () => {
    const { q } = mount({
      annotations: [
        ann({
          id: 'r',
          kind: 'trange',
          points: [
            { t: 3000, v: 0 },
            { t: 1000, v: 0 },
          ],
        }),
      ],
    });
    const g = q('r');
    const shade = g?.querySelector('rect[fill-opacity]');
    expect(shade?.getAttribute('x')).toBe('160');
    expect(shade?.getAttribute('y')).toBe('20');
    expect(shade?.getAttribute('width')).toBe('200');
    expect(shade?.getAttribute('height')).toBe('200');
    expect(firstPath(g)?.getAttribute('d')).toBe('M160 20V220M360 20V220');
    expect(g?.querySelector('text')?.textContent).toBe('2 s');
    expect(g?.querySelector('rect[pointer-events="fill"]')).not.toBeNull();
  });

  it('trend draws p0 -> p1, extended right and both ways', () => {
    const pts = [
      { t: 0, v: 100 },
      { t: 1000, v: 100 },
    ];
    const { q } = mount({
      annotations: [
        ann({ id: 't', kind: 'trend', points: pts }),
        ann({ id: 'tr', kind: 'trend', points: pts, extend: 'right' }),
        ann({ id: 'tb', kind: 'trend', points: pts, extend: 'both' }),
      ],
    });
    expect(firstPath(q('t'))?.getAttribute('d')).toBe('M60 120L160 120');
    // k = 5000 / 100 = 50 -> extension dx * k = 5000.
    expect(firstPath(q('tr'))?.getAttribute('d')).toBe('M60 120L5160 120');
    expect(firstPath(q('tb'))?.getAttribute('d')).toBe('M-4940 120L5160 120');
  });

  it('box draws the unfilled normalized rect of its two corners', () => {
    const { q } = mount({
      annotations: [
        ann({
          id: 'b',
          kind: 'box',
          points: [
            { t: 2000, v: 50 },
            { t: 1000, v: 150 },
          ],
          text: 'zone',
        }),
      ],
    });
    const g = q('b');
    const r = g?.querySelector('rect[fill="none"]');
    expect([
      r?.getAttribute('x'),
      r?.getAttribute('y'),
      r?.getAttribute('width'),
      r?.getAttribute('height'),
    ]).toEqual(['160', '70', '100', '100']);
    expect(r?.getAttribute('stroke')).toBe('#4589ff');
    const text = g?.querySelector('text[data-annotation-label]');
    expect(text?.textContent).toBe('zone');
    expect([text?.getAttribute('x'), text?.getAttribute('y')]).toEqual(['260', '183']);
    expect(text?.getAttribute('text-anchor')).toBe('end');
  });

  it('note draws an anchor dot, a leader and its text, flipping left near the right edge', () => {
    const { q } = mount({
      annotations: [
        ann({ id: 'n', kind: 'note', points: [{ t: 1000, v: 100 }], text: 'hi' }),
        ann({ id: 'nr', kind: 'note', points: [{ t: 3900, v: 100 }], text: 'hi' }),
      ],
    });
    const g = q('n');
    const dot = g?.querySelector('circle[r="1.5"]');
    expect([dot?.getAttribute('cx'), dot?.getAttribute('cy')]).toEqual(['160', '120']);
    expect(dot?.getAttribute('fill')).toBe('#4589ff');
    expect(g?.querySelector('[data-annotation-callout]')).toBeNull();
    expect(firstPath(g)?.getAttribute('d')).toBe('M160 120L174 106');
    const text = g?.querySelector('text[data-annotation-label]');
    expect(text?.textContent).toBe('hi');
    expect([text?.getAttribute('x'), text?.getAttribute('y')]).toEqual(['176', '104']);
    expect(text?.getAttribute('text-anchor')).toBe('start');
    expect(text?.getAttribute('stroke')).toBe(drawingThemeFor('dark').bg);
    expect(g?.querySelector('rect[data-annotation-hit]')?.getAttribute('x')).toBe('174');
    // x = 450; 450 + 14 + 40 > 460 -> the text box sits at 450 - 14 - 40, the text ends at 434.
    const nr = q('nr');
    expect(firstPath(nr)?.getAttribute('d')).toBe('M450 120L436 106');
    expect(nr?.querySelector('text')?.getAttribute('x')).toBe('434');
    expect(nr?.querySelector('text')?.getAttribute('text-anchor')).toBe('end');
    expect(nr?.querySelector('rect[data-annotation-hit]')?.getAttribute('x')).toBe('396');
  });

  it('measure draws an unfilled box and a fine dashed diagonal in its own colour', () => {
    const { q } = mount({
      annotations: [
        ann({
          id: 'm',
          kind: 'measure',
          points: [
            { t: 1000, v: 50 },
            { t: 2000, v: 150 },
          ],
        }),
      ],
    });
    const g = q('m');
    const r = g?.querySelector('rect[fill="none"]');
    expect([
      r?.getAttribute('x'),
      r?.getAttribute('y'),
      r?.getAttribute('width'),
      r?.getAttribute('height'),
    ]).toEqual(['160', '70', '100', '100']);
    expect(r?.getAttribute('stroke')).toBe('#4589ff');
    expect(r?.getAttribute('stroke-width')).toBe('2');
    const diag = g?.querySelector('[data-annotation-diagonal]');
    expect(diag?.getAttribute('d')).toBe('M160 170L260 70');
    expect(diag?.getAttribute('stroke')).toBe('#4589ff');
    expect(diag?.getAttribute('stroke-width')).toBe('0.75');
    expect(diag?.getAttribute('stroke-dasharray')).toBe('2 2');
  });

  it('omits hidden drawings', () => {
    const { q } = mount({
      annotations: [
        ann({ id: 'shown', kind: 'hline', points: [{ t: 0, v: 100 }] }),
        ann({ id: 'gone', kind: 'hline', points: [{ t: 0, v: 50 }], hidden: true }),
      ],
    });
    expect(q('shown')).not.toBeNull();
    expect(q('gone')).toBeNull();
  });

  it('hide-all omits every drawing and the draft', () => {
    const { container } = mount({
      annotationsHidden: true,
      annotations: [
        ann({ id: 'h', kind: 'hline', points: [{ t: 0, v: 100 }] }),
        ann({ id: 'v', kind: 'vline', points: [{ t: 0, v: 0 }] }),
      ],
      draft: ann({ id: DRAFT_ID, kind: 'vline', points: [{ t: 500, v: 0 }] }),
    });
    expect(container.querySelectorAll('[data-annotation-id]')).toHaveLength(0);
  });

  it('skips a v-bearing drawing on a hidden axis but keeps time-only kinds', () => {
    const { q } = mount({
      axes: [{ id: 'a' }],
      annotations: [
        ann({ id: 'h', kind: 'hline', points: [{ t: 0, v: 100 }], axisId: 'off' }),
        ann({ id: 'v', kind: 'vline', points: [{ t: 500, v: 0 }], axisId: 'off' }),
        ann({
          id: 'r',
          kind: 'trange',
          points: [
            { t: 0, v: 0 },
            { t: 500, v: 0 },
          ],
          axisId: 'off',
        }),
      ],
    });
    expect(q('h')).toBeNull();
    expect(q('v')).not.toBeNull();
    expect(q('r')).not.toBeNull();
  });

  it('skips a log-axis drawing whose v <= 0 projects to a non-finite y', () => {
    const { q } = mount({
      annotations: [
        ann({ id: 'neg', kind: 'hline', points: [{ t: 0, v: -1 }], axisId: 'log' }),
        ann({
          id: 'zero',
          kind: 'box',
          points: [
            { t: 0, v: 0 },
            { t: 100, v: 10 },
          ],
          axisId: 'log',
        }),
        ann({ id: 'ok', kind: 'hline', points: [{ t: 0, v: 10 }], axisId: 'log' }),
      ],
    });
    expect(q('neg')).toBeNull();
    expect(q('zero')).toBeNull();
    expect(firstPath(q('ok'))?.getAttribute('d')).toBe('M60 170H460');
  });

  it('renders the draft at 0.8 opacity without hit targets', () => {
    const { q } = mount({
      annotations: [],
      draft: ann({ id: DRAFT_ID, kind: 'vline', points: [{ t: 1000, v: 0 }] }),
    });
    const g = q(DRAFT_ID);
    expect(g).not.toBeNull();
    expect(Number(g?.getAttribute('opacity'))).toBe(DRAFT_OPACITY);
    expect(DRAFT_OPACITY).toBe(0.8);
    expect(g?.querySelector('[pointer-events="stroke"]')).toBeNull();
  });

  it('a selected drawing gets an outline and one handle per point', () => {
    const { q } = mount({
      selectedId: 'b',
      annotations: [
        ann({
          id: 'b',
          kind: 'box',
          points: [
            { t: 1000, v: 50 },
            { t: 2000, v: 150 },
          ],
        }),
        ann({
          id: 'other',
          kind: 'box',
          points: [
            { t: 0, v: 0 },
            { t: 500, v: 10 },
          ],
        }),
      ],
    });
    const g = q('b');
    expect(g?.getAttribute('data-annotation-selected')).toBe('true');
    const outline = g?.querySelector('[data-annotation-selection]');
    expect(outline?.getAttribute('stroke')).toBe(drawingThemeFor('dark').annotation.selection);
    // A faint halo just wider than the drawing's own stroke (width 2).
    expect(outline?.getAttribute('stroke-width')).toBe('5');
    expect(outline?.getAttribute('stroke-opacity')).toBe('0.22');
    const handles = [...(g?.querySelectorAll('g[data-handle]') ?? [])];
    expect(handles.map((h) => h.getAttribute('data-handle'))).toEqual(['0', '1']);
    // Each handle: a small visible dot, and a larger transparent grab target over it.
    const [dot0, grab0] = [...handles[0].querySelectorAll('circle')];
    const [dot1] = [...handles[1].querySelectorAll('circle')];
    expect([dot0.getAttribute('cx'), dot0.getAttribute('cy')]).toEqual(['160', '170']);
    expect([dot1.getAttribute('cx'), dot1.getAttribute('cy')]).toEqual(['260', '70']);
    expect(dot0.getAttribute('r')).toBe('2.5');
    expect(dot0.getAttribute('fill')).toBe(drawingThemeFor('dark').annotation.handle);
    expect(dot0.getAttribute('stroke')).toBe('#4589ff');
    expect(dot0.getAttribute('stroke-width')).toBe('1');
    expect(dot0.getAttribute('pointer-events')).toBe('none');
    expect([grab0.getAttribute('cx'), grab0.getAttribute('cy')]).toEqual(['160', '170']);
    expect(grab0.getAttribute('r')).toBe('7');
    expect(grab0.getAttribute('fill')).toBe('transparent');
    expect(grab0.getAttribute('pointer-events')).toBe('all');
    expect(q('other')?.querySelector('[data-handle]')).toBeNull();
    expect(q('other')?.querySelector('[data-annotation-selection]')).toBeNull();
  });

  it('a locked drawing shows a lock glyph and no handles even when selected', () => {
    const { q } = mount({
      selectedId: 'h',
      annotations: [ann({ id: 'h', kind: 'hline', points: [{ t: 0, v: 100 }], locked: true })],
    });
    const g = q('h');
    expect(g?.getAttribute('data-annotation-locked')).toBe('true');
    expect(g?.querySelector('[data-annotation-lock]')).not.toBeNull();
    expect(g?.querySelector('[data-handle]')).toBeNull();
  });

  it('draws an ink drawing in the theme ink, in both themes', () => {
    const inked = ann({
      id: 'k',
      kind: 'hline',
      points: [{ t: 0, v: 100 }],
      color: ANNOTATION_INK,
    });
    for (const theme of [drawingThemeFor('dark'), drawingThemeFor('light')]) {
      const { q, unmount } = mount({ annotations: [inked], theme, selectedId: 'k' });
      const line = q('k')?.querySelector('path[stroke-width="2"]:not([stroke="transparent"])');
      expect(line?.getAttribute('stroke')).toBe(theme.annotation.ink);
      expect(q('k')?.querySelector('g[data-handle] circle')?.getAttribute('stroke')).toBe(
        theme.annotation.ink
      );
      unmount();
    }
    expect(drawingThemeFor('dark').annotation.ink).not.toBe(
      drawingThemeFor('light').annotation.ink
    );
  });

  it('offers a style chip on the selected, unlocked drawing when it can commit', () => {
    const box = ann({
      id: 'b',
      kind: 'box',
      points: [
        { t: 1000, v: 50 },
        { t: 2000, v: 150 },
      ],
    });
    const onCommit = vi.fn();
    const chip = (c: ParentNode) => c.querySelector('[data-drawing-style] [data-style-chip]');
    const sel = mount({ annotations: [box], selectedId: 'b', onCommit });
    const button = chip(sel.container) as HTMLButtonElement;
    expect(button).not.toBeNull();
    // The chip is HTML beside the svg layer, not part of a drawing.
    expect(button.closest('svg')).toBeNull();
    fireEvent.click(button);
    fireEvent.click(sel.container.querySelector('[data-style-width="1"]')!);
    expect(onCommit).toHaveBeenCalledTimes(1);
    const [fn, label] = onCommit.mock.calls[0];
    expect(label).toBe('Style Box');
    expect(fn([box])).toEqual([{ ...box, width: 1 }]);
    sel.unmount();

    const noWriter = mount({ annotations: [box], selectedId: 'b' });
    expect(chip(noWriter.container)).toBeNull();
    noWriter.unmount();
    const locked = mount({ annotations: [{ ...box, locked: true }], selectedId: 'b', onCommit });
    expect(chip(locked.container)).toBeNull();
    locked.unmount();
    const unselected = mount({ annotations: [box], onCommit });
    expect(chip(unselected.container)).toBeNull();
  });

  it('follows a projection bump', () => {
    let shift = 0;
    const store = createProjectionStore(() => {
      const p = fakeProjection();
      return projectionOf({ ...p.grids[0], tToX: (t: number) => p.tToX(t) + shift });
    });
    const { container } = render(
      <AnnotationLayer
        config={TRACE_LAYER}
        projectionStore={store}
        annotations={[ann({ id: 'v', kind: 'vline', points: [{ t: 0, v: 0 }] })]}
        axes={[{ id: 'a' }]}
        theme={drawingThemeFor('dark')}
      />
    );
    act(() => store.bump());
    const d = () =>
      firstPath(container.querySelector('[data-annotation-id="v"]'))?.getAttribute('d');
    expect(d()).toBe('M60 20V220');
    shift = 25;
    act(() => store.bump());
    expect(d()).toBe('M85 20V220');
  });
});
