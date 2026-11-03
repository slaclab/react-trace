// @vitest-environment jsdom
// Box tool: identity, text, and geometry pinned against the base
// `AnnotationLayer` render.
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { drawingThemeFor } from '../../../annotationTheme';
import { BoxIcon } from '../../icons';
import { createProjectionStore, type Projection } from '../../../plot/geometry';
import { projectionOf } from '../../../plot/testUtils';
import { type Annotation, objNameIn } from '../../model';
import { AnnotationLayer } from '../../AnnotationLayer';
import registry from '../../__fixtures__/registry.json';
import { TIME_X_AXIS } from '../xAxis';
import type { GridProjection } from '../types';
import { BOX_TOOL as T } from './def';
import { BUILTIN_CATALOG } from '..';

const TRACE_LAYER = { catalog: BUILTIN_CATALOG, xAxis: TIME_X_AXIS };

afterEach(cleanup);

// Grid at (60, 20), 400 x 200; x = 60 + t/10; y on 'a' = 220 - v.
const GRID = { left: 60, top: 20, width: 400, height: 200 };
const grid: GridProjection = {
  tToX: (t) => GRID.left + t / 10,
  xToT: (x) => (x - GRID.left) * 10,
  vToY: (v, axisId) => (axisId === 'a' ? 220 - v : NaN),
  yToV: (y, axisId) => (axisId === 'a' ? 220 - y : NaN),
  gridRect: GRID,
  axisIds: ['a'],
};
const ctx = { theme: drawingThemeFor('dark'), xAxis: TIME_X_AXIS };

// Points deliberately unsorted: p0 is right/bottom, p1 left/top.
function ann(over: Partial<Annotation> = {}): Annotation {
  return {
    id: 'b',
    kind: 'box',
    points: [
      { t: 3000, v: 50 },
      { t: 1000, v: 150 },
    ],
    axisId: 'a',
    color: '#4589ff',
    width: 2,
    text: '',
    ...over,
  };
}

const svg = (el: ReactElement) => render(<svg>{el}</svg>).container;

describe('box tool identity', () => {
  it('matches the registry pin', () => {
    const pin = registry.tools.find((t) => t.kind === 'box')!;
    expect(T.kind).toBe('box');
    expect(T.code).toBe(pin.code);
    expect(T.code).toBe(4);
    expect(T.key).toBe(pin.key);
    expect(T.key).toBe('b');
    expect(T.label).toEqual({ long: pin.label, short: pin.shortLabel });
    expect(T.icon).toBe(BoxIcon);
    expect(T.arity).toBe(2);
    expect(T.axes).toBe('xy');
    expect(T.codec).toEqual({ layout: 'tvtv' });
    expect(T.fields).toEqual([]);
    expect(T.menuAdd).toBeUndefined();
    expect(T.inlineText).toBeUndefined();
    expect(T.validate).toBeUndefined();
    expect(T.card).toBeUndefined();
    expect(T.modifierGesture).toBeUndefined();
  });

  it('keeps both coordinates in shapePoint', () => {
    expect(T.shapePoint({ t: 5, v: 7 })).toEqual({ t: 5, v: 7 });
  });

  it('hints as base', () => {
    expect(T.hint({ xAxis: TIME_X_AXIS })).toBe('Box: drag or click twice');
  });
});

describe('box objName', () => {
  it('names the axis when known, as base', () => {
    const a = ann();
    const axis = { id: 'a', name: 'Current', units: 'mA' };
    expect(T.objName(a, { axis, xAxis: TIME_X_AXIS })).toBe('Box (Current)');
    expect(T.objName(a, { axis, xAxis: TIME_X_AXIS })).toBe(
      objNameIn(BUILTIN_CATALOG, TIME_X_AXIS, a, [axis as never])
    );
  });

  it('is bare without an axis or with a nameless one', () => {
    expect(T.objName(ann(), { xAxis: TIME_X_AXIS })).toBe('Box');
    expect(T.objName(ann(), { xAxis: TIME_X_AXIS })).toBe(
      objNameIn(BUILTIN_CATALOG, TIME_X_AXIS, ann(), [])
    );
    expect(T.objName(ann(), { axis: { id: 'a', name: '' }, xAxis: TIME_X_AXIS })).toBe('Box');
  });
});

describe('box geometry', () => {
  it('pins the sorted rectangle, label, hits, raw handles and lock', () => {
    const a = ann({ text: 'region' });
    const g = T.geometry(a, grid, ctx)!;
    // x: 160..360, y: 70..170
    expect(g.outline).toEqual(['M160 70H360V170H160Z']);
    expect(g.handles).toEqual([
      [360, 170],
      [160, 70],
    ]);
    expect(g.lockAt).toEqual([360, 70]);

    const body = svg(<T.Shape annotation={a} geometry={g} />);
    const rect = body.querySelector('rect')!;
    expect(rect.getAttribute('x')).toBe('160');
    expect(rect.getAttribute('y')).toBe('70');
    expect(rect.getAttribute('width')).toBe('200');
    expect(rect.getAttribute('height')).toBe('100');
    expect(rect.getAttribute('stroke')).toBe('#4589ff');
    expect(rect.getAttribute('stroke-width')).toBe('2');
    expect(rect.getAttribute('fill')).toBe('none');
    expect(rect.hasAttribute('fill-opacity')).toBe(false);
    // The label sits under the box's bottom-right corner, right-aligned.
    const text = body.querySelector('text')!;
    expect(text.getAttribute('x')).toBe('360');
    expect(text.getAttribute('y')).toBe('183');
    expect(text.getAttribute('text-anchor')).toBe('end');
    expect(text.getAttribute('fill')).toBe('#4589ff');
    expect(text.getAttribute('stroke')).toBe(drawingThemeFor('dark').bg);
    expect(text.getAttribute('stroke-width')).toBe('3');
    expect(text.getAttribute('paint-order')).toBe('stroke');
    expect(text.getAttribute('font-style')).toBe('italic');
    expect(text.getAttribute('font-size')).toBe('11');
    expect(text.textContent).toBe('region');

    const hits = svg(<>{g.hits}</>);
    expect(hits.querySelectorAll('[data-annotation-hit]')).toHaveLength(2);
    const hr = hits.querySelector('rect')!;
    expect([
      hr.getAttribute('x'),
      hr.getAttribute('y'),
      hr.getAttribute('width'),
      hr.getAttribute('height'),
    ]).toEqual(['160', '70', '200', '100']);
    expect(hits.querySelector('path')!.getAttribute('d')).toBe('M160 70H360V170H160Z');
  });

  it('draws no label without text', () => {
    const g = T.geometry(ann(), grid, ctx)!;
    expect(svg(<>{g.body}</>).querySelector('text')).toBeNull();
  });

  it('dashes the stroke when dashed', () => {
    const g = T.geometry(ann({ dash: true }), grid, ctx)!;
    expect(
      svg(<>{g.body}</>)
        .querySelector('rect')!
        .getAttribute('stroke-dasharray')
    ).toBe('2 2');
  });

  it('returns null when the axis is not drawn in the grid', () => {
    expect(T.geometry(ann(), { ...grid, axisIds: [] }, ctx)).toBeNull();
    expect(T.geometry(ann({ axisId: 'gone' }), grid, ctx)).toBeNull();
  });

  it('returns null for missing points or non-finite coordinates', () => {
    expect(T.geometry(ann({ points: [] }), grid, ctx)).toBeNull();
    expect(
      T.geometry(
        ann({
          points: [
            { t: 0, v: 0 },
            { t: NaN, v: 0 },
          ],
        }),
        grid,
        ctx
      )
    ).toBeNull();
    expect(
      T.geometry(
        ann({
          points: [
            { t: 0, v: 0 },
            { t: 10, v: Infinity },
          ],
        }),
        grid,
        ctx
      )
    ).toBeNull();
  });

  it('renders the same body as the base layer', () => {
    const a = ann({ dash: true, text: 'region' });
    const store = createProjectionStore((): Projection => projectionOf(grid));
    const base = render(
      <div>
        <AnnotationLayer
          config={TRACE_LAYER}
          projectionStore={store}
          annotations={[a]}
          axes={[{ id: 'a' }]}
          theme={drawingThemeFor('dark')}
        />
      </div>
    );
    act(() => store.bump());
    const el = base.container.querySelector('[data-annotation-id="b"]')!;
    const g = T.geometry(a, grid, ctx)!;
    const mine = svg(<T.Shape annotation={a} geometry={g} />).querySelector('svg')!;

    expect(mine.querySelector('rect')!.outerHTML).toBe(
      el.querySelector('rect[fill="none"]')!.outerHTML
    );
    expect(mine.querySelector('text')!.outerHTML).toBe(
      el.querySelector('text[data-annotation-label]')!.outerHTML
    );
  });
});
