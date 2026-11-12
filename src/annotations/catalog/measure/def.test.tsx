// @vitest-environment jsdom
// Measure tool: identity, text, geometry pinned against the base
// `AnnotationLayer` render, and the card delegating to the host's provider.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { drawingThemeFor } from '../../../annotationTheme';
import { MeasureIcon } from '../../icons';
import { createProjectionStore, type Projection } from '../../../plot/geometry';
import { projectionOf } from '../../../plot/testUtils';
import { type Annotation, objNameIn } from '../../model';
import { AnnotationLayer } from '../../AnnotationLayer';
import registry from '../../__fixtures__/registry.json';
import { TIME_X_AXIS, VALUE_X_AXIS } from '../xAxis';
import type { Axis } from '../../../types';
import type { GridProjection, MeasureProvider } from '../types';
import { MEASURE_TOOL as T } from './def';
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
    id: 'm',
    kind: 'measure',
    points: [
      { t: 2000, v: 50 },
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

describe('measure tool identity', () => {
  it('matches the registry pin', () => {
    const pin = registry.tools.find((t) => t.kind === 'measure')!;
    expect(T.kind).toBe('measure');
    expect(T.code).toBe(pin.code);
    expect(T.code).toBe(6);
    expect(T.key).toBe('m');
    expect(T.label).toEqual({ long: pin.label, short: pin.shortLabel });
    expect(T.icon).toBe(MeasureIcon);
    expect(T.arity).toBe(2);
    expect(T.axes).toBe('xy');
    expect(T.modifierGesture).toBe('shift');
    expect(T.codec).toEqual({ layout: 'tvtv' });
    expect(T.fields).toEqual([]);
    expect(T.menuAdd).toBeUndefined();
    expect(T.inlineText).toBeUndefined();
    expect(T.validate).toBeUndefined();
  });

  it('keeps both coordinates in shapePoint', () => {
    expect(T.shapePoint({ t: 5, v: 7 })).toEqual({ t: 5, v: 7 });
  });

  it('hints shift-drag to measure', () => {
    expect(T.hint({ xAxis: TIME_X_AXIS })).toBe('Measure: shift-drag to measure');
  });
});

describe('measure objName', () => {
  const axis: Axis = {
    id: 'a',
    name: 'Current',
    units: 'mA',
    orientation: 'left',
    autoScale: true,
    logScale: false,
    visible: true,
  };

  it('equals base objName on a time axis', () => {
    const a = ann({
      points: [
        { t: 0, v: 1 },
        { t: 70_000, v: 1.42 },
      ],
    });
    expect(T.objName(a, { axis, xAxis: TIME_X_AXIS })).toBe(
      objNameIn(BUILTIN_CATALOG, TIME_X_AXIS, a, [axis])
    );
    expect(T.objName(a, { axis, xAxis: TIME_X_AXIS, binned: true })).toBe(
      objNameIn(BUILTIN_CATALOG, TIME_X_AXIS, a, [axis], true)
    );
    expect(T.objName(a, { xAxis: TIME_X_AXIS })).toBe(
      objNameIn(BUILTIN_CATALOG, TIME_X_AXIS, a, [])
    );
  });

  it('prefers the unit override and formats the span through the descriptor', () => {
    const a = ann({
      points: [
        { t: 1, v: 1 },
        { t: 3.5, v: 3 },
      ],
    });
    expect(T.objName(a, { axis: { ...axis, unitLabel: 'uA' }, xAxis: VALUE_X_AXIS })).toBe(
      `Measure Δ2 uA / ${VALUE_X_AXIS.formatSpan(2.5)}`
    );
  });
});

describe('measure card', () => {
  it('delegates to the host measure provider', () => {
    const card = vi.fn<MeasureProvider['card']>(() => ['Δt 1 s', 'Δv 2']);
    const a = ann();
    const cctx = { xAxis: TIME_X_AXIS, binned: true, measure: { card } };
    expect(T.card!(a, cctx)).toEqual(['Δt 1 s', 'Δv 2']);
    expect(card).toHaveBeenCalledTimes(1);
    expect(card).toHaveBeenCalledWith(a, cctx);
  });
});

describe('measure geometry', () => {
  it('pins the unfilled box and the fine dashed diagonal in the drawing colour', () => {
    const g = T.geometry(ann(), grid, ctx)!;
    expect(g.outline).toEqual(['M160 70H260V170H160Z']);
    expect(g.handles).toEqual([
      [260, 170],
      [160, 70],
    ]);
    expect(g.lockAt).toEqual([260, 70]);

    const body = svg(<T.Shape annotation={ann()} geometry={g} />);
    const rect = body.querySelector('rect')!;
    expect(rect.getAttribute('x')).toBe('160');
    expect(rect.getAttribute('y')).toBe('70');
    expect(rect.getAttribute('width')).toBe('100');
    expect(rect.getAttribute('height')).toBe('100');
    expect(rect.getAttribute('fill')).toBe('none');
    expect(rect.hasAttribute('fill-opacity')).toBe(false);
    expect(rect.getAttribute('stroke')).toBe('#4589ff');
    expect(rect.getAttribute('stroke-width')).toBe('2');
    expect(rect.hasAttribute('stroke-dasharray')).toBe(false);
    const diag = body.querySelector('path[data-annotation-diagonal]')!;
    expect(diag.getAttribute('d')).toBe('M260 170L160 70');
    expect(diag.getAttribute('stroke')).toBe('#4589ff');
    // The diagonal is never wider than 0.75 px, and always dashed.
    expect(diag.getAttribute('stroke-width')).toBe('0.75');
    expect(diag.getAttribute('stroke-dasharray')).toBe('2 2');
    const thin = T.geometry(ann({ width: 0.5 }), grid, ctx)!;
    expect(
      svg(<>{thin.body}</>)
        .querySelector('path[data-annotation-diagonal]')!
        .getAttribute('stroke-width')
    ).toBe('0.5');

    const hits = svg(<>{g.hits}</>);
    expect(hits.querySelectorAll('[data-annotation-hit]')).toHaveLength(1);
  });

  it('returns null off the grid axes, for missing points, or a non-finite coordinate', () => {
    expect(T.geometry(ann({ axisId: 'gone' }), grid, ctx)).toBeNull();
    expect(T.geometry(ann(), { ...grid, axisIds: [] }, ctx)).toBeNull();
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
            { t: 1, v: NaN },
          ],
        }),
        grid,
        ctx
      )
    ).toBeNull();
  });

  it('renders the same body as the base layer', () => {
    const a = ann();
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
    const el = base.container.querySelector('[data-annotation-id="m"]')!;
    const g = T.geometry(a, grid, ctx)!;
    const mine = svg(<T.Shape annotation={a} geometry={g} />).querySelector('svg')!;

    expect(mine.querySelector('rect')!.outerHTML).toBe(
      el.querySelector('rect[fill="none"]')!.outerHTML
    );
    expect(mine.querySelector('path[data-annotation-diagonal]')!.outerHTML).toBe(
      el.querySelector('path[data-annotation-diagonal]')!.outerHTML
    );
  });
});
