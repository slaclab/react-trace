// @vitest-environment jsdom
// Time-range tool: identity, text, and geometry pinned against the
// base `AnnotationLayer` render.
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { drawingThemeFor } from '../../../annotationTheme';
import { TimeRangeIcon } from '../../icons';
import { createProjectionStore, type Projection } from '../../../plot/geometry';
import { projectionOf } from '../../../plot/testUtils';
import { type Annotation, objNameIn } from '../../model';
import { AnnotationLayer } from '../../AnnotationLayer';
import registry from '../../__fixtures__/registry.json';
import { TIME_X_AXIS, VALUE_X_AXIS } from '../xAxis';
import type { GridProjection } from '../types';
import { TRANGE_TOOL as T } from './def';
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

function ann(over: Partial<Annotation> = {}): Annotation {
  return {
    id: 'r',
    kind: 'trange',
    points: [
      { t: 2000, v: 0 },
      { t: 1000, v: 0 },
    ],
    axisId: 'a',
    color: '#4589ff',
    width: 2,
    text: '',
    ...over,
  };
}

const svg = (el: ReactElement) => render(<svg>{el}</svg>).container;

describe('trange tool identity', () => {
  it('matches the registry pin', () => {
    const pin = registry.tools.find((t) => t.kind === 'trange')!;
    expect(T.kind).toBe('trange');
    expect(T.code).toBe(pin.code);
    expect(T.code).toBe(2);
    expect(T.key).toBe('r');
    expect(T.label).toEqual({ long: pin.label, short: pin.shortLabel });
    expect(T.icon).toBe(TimeRangeIcon);
    expect(T.arity).toBe(2);
    expect(T.axes).toBe('x');
    expect(T.codec).toEqual({ layout: 'tt' });
    expect(T.fields).toEqual([]);
    expect(T.menuAdd).toBeUndefined();
    expect(T.inlineText).toBeUndefined();
    expect(T.validate).toBeUndefined();
  });

  it('zeroes v in shapePoint', () => {
    expect(T.shapePoint({ t: 5, v: 7 })).toEqual({ t: 5, v: 0 });
  });

  it('hints as base', () => {
    expect(T.hint({ xAxis: TIME_X_AXIS })).toBe('Time range: drag or click twice');
  });
});

describe('trange objName', () => {
  it('equals base objName on a time axis', () => {
    const a = ann({
      points: [
        { t: 0, v: 0 },
        { t: 750_000, v: 0 },
      ],
    });
    expect(T.objName(a, { xAxis: TIME_X_AXIS })).toBe(
      objNameIn(BUILTIN_CATALOG, TIME_X_AXIS, a, [])
    );
  });

  it('formats the span through the descriptor', () => {
    const a = ann({
      points: [
        { t: 1, v: 0 },
        { t: 3.5, v: 0 },
      ],
    });
    expect(T.objName(a, { xAxis: VALUE_X_AXIS })).toBe(`Range ${VALUE_X_AXIS.formatSpan(2.5)}`);
  });
});

describe('trange geometry', () => {
  it('pins the band between the sorted edges over the full grid height', () => {
    const g = T.geometry(ann(), grid, ctx)!;
    expect(g.outline).toEqual(['M160 20H260V220H160Z']);
    expect(g.handles).toEqual([
      [260, 120],
      [160, 120],
    ]);
    expect(g.lockAt).toEqual([160, 120]);

    const body = svg(<T.Shape annotation={ann()} geometry={g} />);
    const rect = body.querySelector('rect')!;
    expect(rect.getAttribute('x')).toBe('160');
    expect(rect.getAttribute('y')).toBe('20');
    expect(rect.getAttribute('width')).toBe('100');
    expect(rect.getAttribute('height')).toBe('200');
    expect(rect.getAttribute('fill')).toBe('#4589ff');
    expect(rect.getAttribute('fill-opacity')).toBe('0.05');
    const path = body.querySelector('path')!;
    expect(path.getAttribute('d')).toBe('M160 20V220M260 20V220');
    expect(path.getAttribute('stroke-width')).toBe('2');
    const text = body.querySelector('text')!;
    expect(text.getAttribute('x')).toBe('210');
    expect(text.getAttribute('y')).toBe('32');
    expect(text.getAttribute('text-anchor')).toBe('middle');
    expect(text.textContent).toBe(TIME_X_AXIS.formatSpan(-1000));

    const hits = svg(<>{g.hits}</>);
    expect(hits.querySelectorAll('[data-annotation-hit]')).toHaveLength(3);
    expect([...hits.querySelectorAll('path')].map((p) => p.getAttribute('d'))).toEqual([
      'M160 20V220',
      'M260 20V220',
    ]);
  });

  it('uses the drawing text over the default span label', () => {
    const g = T.geometry(ann({ text: 'beam dump' }), grid, ctx)!;
    expect(svg(<>{g.body}</>).querySelector('text')!.textContent).toBe('beam dump');
  });

  it('labels the span through the descriptor on a value axis', () => {
    const g = T.geometry(ann(), grid, { ...ctx, xAxis: VALUE_X_AXIS })!;
    expect(svg(<>{g.body}</>).querySelector('text')!.textContent).toBe(
      VALUE_X_AXIS.formatSpan(-1000)
    );
  });

  it('draws regardless of the y axes the grid shows', () => {
    expect(T.geometry(ann({ axisId: 'gone' }), { ...grid, axisIds: [] }, ctx)).not.toBeNull();
  });

  it('returns null for missing points or a non-finite x', () => {
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
  });

  it('renders the same body as the base layer', () => {
    const a = ann({ dash: true });
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
    const el = base.container.querySelector('[data-annotation-id="r"]')!;
    const g = T.geometry(a, grid, ctx)!;
    const mine = svg(<T.Shape annotation={a} geometry={g} />).querySelector('svg')!;

    const baseRect = el.querySelector('rect[fill-opacity]')!;
    expect(mine.querySelector('rect')!.outerHTML).toBe(baseRect.outerHTML);
    const basePath = [...el.querySelectorAll('path')].find(
      (p) =>
        p.getAttribute('d') === 'M160 20V220M260 20V220' && p.getAttribute('stroke') === '#4589ff'
    )!;
    expect(mine.querySelector('path')!.outerHTML).toBe(basePath.outerHTML);
    expect(mine.querySelector('text')!.outerHTML).toBe(
      el.querySelector('text[data-annotation-label]')!.outerHTML
    );
  });
});
