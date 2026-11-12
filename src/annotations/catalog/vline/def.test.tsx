// @vitest-environment jsdom
// Pins the V-line tool: identity against the registry pin, placement,
// its full-grid-height geometry at the projected x, and that its Shape renders
// the same coordinates and attributes as today's AnnotationLayer.
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { drawingThemeFor } from '../../../annotationTheme';
import { VerticalLineIcon } from '../../icons';
import { createProjectionStore, type Projection } from '../../../plot/geometry';
import { projectionOf } from '../../../plot/testUtils';
import { AnnotationLayer } from '../../AnnotationLayer';
import type { Annotation } from '../../model';
import registry from '../../__fixtures__/registry.json';
import { TIME_X_AXIS, VALUE_X_AXIS } from '../xAxis';
import type { GeometryContext, GridProjection } from '../types';
import { VLINE_TOOL as VLINE } from './def';
import { BUILTIN_CATALOG } from '..';
import { objNameIn, arityIn } from '../../model';
import { toolHintIn } from '../../statusHints';

const TRACE_LAYER = { catalog: BUILTIN_CATALOG, xAxis: TIME_X_AXIS };

afterEach(cleanup);

// Grid at (60, 20), 400 x 200. x = 60 + t/10; y on 'a' = 220 - v.
const GRID = { left: 60, top: 20, width: 400, height: 200 };
const proj: GridProjection = {
  tToX: (t) => GRID.left + t / 10,
  xToT: (x) => (x - GRID.left) * 10,
  vToY: (v, axisId) => (axisId === 'a' ? 220 - v : NaN),
  yToV: (y, axisId) => (axisId === 'a' ? 220 - y : NaN),
  gridRect: GRID,
  axisIds: ['a'],
};
const ctx: GeometryContext = { theme: drawingThemeFor('dark'), xAxis: TIME_X_AXIS };

function ann(over: Partial<Annotation> = {}): Annotation {
  return {
    id: 'v',
    kind: 'vline',
    points: [{ t: 1000, v: 0 }],
    axisId: 'a',
    color: '#4589ff',
    width: 2,
    text: '',
    ...over,
  };
}

function renderShape(a: Annotation) {
  const geo = VLINE.geometry(a, proj, ctx);
  if (!geo) throw new Error('no geometry');
  const { Shape } = VLINE;
  return render(
    <svg>
      <Shape annotation={a} geometry={geo} />
    </svg>
  );
}

function renderBase(a: Annotation) {
  const store = createProjectionStore((): Projection => projectionOf(proj));
  const utils = render(
    <div style={{ position: 'relative' }}>
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
  return utils.container.querySelector(`[data-annotation-id="${a.id}"]`);
}

describe('VLINE_TOOL identity', () => {
  it('matches the registry pin', () => {
    const pin = registry.tools.find((t) => t.kind === 'vline')!;
    expect(VLINE.kind).toBe(pin.kind);
    expect(VLINE.code).toBe(pin.code);
    expect(VLINE.key).toBe(pin.key);
    expect(VLINE.label).toEqual({ long: pin.label, short: pin.shortLabel });
    expect(VLINE.icon).toBe(VerticalLineIcon);
  });

  it('places one x-only point, offered in the plot menu, with layout t', () => {
    expect(VLINE.arity).toBe(1);
    expect(VLINE.axes).toBe('x');
    expect(VLINE.menuAdd).toEqual({ label: 'Add vertical line here' });
    expect(VLINE.inlineText).toBeUndefined();
    expect(VLINE.modifierGesture).toBeUndefined();
    expect(VLINE.card).toBeUndefined();
    expect(VLINE.fields).toEqual([]);
    expect(VLINE.codec).toEqual({ layout: 't' });
    expect(arityIn(BUILTIN_CATALOG, 'vline')).toBe(1);
  });

  it('shapePoint zeroes v and keeps t', () => {
    expect(VLINE.shapePoint({ t: 123.5, v: 42 })).toEqual({ t: 123.5, v: 0 });
    expect(VLINE.shapePoint({ t: -7, v: 0 })).toEqual({ t: -7, v: 0 });
  });

  it('hints as today', () => {
    expect(VLINE.hint({ xAxis: TIME_X_AXIS })).toBe(
      toolHintIn(BUILTIN_CATALOG, 'vline', { xAxis: TIME_X_AXIS })
    );
    expect(VLINE.hint({ xAxis: TIME_X_AXIS })).toBe('Vertical line: click to place');
  });
});

describe('VLINE_TOOL objName', () => {
  it('formats x as the clock time on a time axis, as base', () => {
    const t = new Date(2026, 9, 19, 14, 2, 11, 400).getTime();
    const a = ann({ points: [{ t, v: 0 }] });
    expect(VLINE.objName(a, { xAxis: TIME_X_AXIS })).toBe('V-line 14:02:11');
    expect(VLINE.objName(a, { xAxis: TIME_X_AXIS })).toBe(
      objNameIn(BUILTIN_CATALOG, TIME_X_AXIS, a, [])
    );
  });

  it('formats x through the descriptor on a value axis', () => {
    const a = ann({ points: [{ t: 1234.5678, v: 0 }] });
    expect(VLINE.objName(a, { xAxis: VALUE_X_AXIS })).toBe('V-line 1235');
  });

  it('ignores the drawing axis unit', () => {
    const a = ann({ points: [{ t: 1234.5678, v: 0 }] });
    expect(
      VLINE.objName(a, { xAxis: VALUE_X_AXIS, axis: { id: 'a', name: 'I', units: 'mA' } })
    ).toBe('V-line 1235');
  });
});

describe('VLINE_TOOL geometry', () => {
  it('covers the full grid height at the projected x', () => {
    const geo = VLINE.geometry(ann(), proj, ctx)!;
    expect(geo.outline).toEqual(['M160 20V220']);
    expect(geo.handles).toEqual([[160, 120]]);
    expect(geo.lockAt).toEqual([160, 120]);
  });

  it('hit-tests along the line with key h0', () => {
    const { container } = render(<svg>{VLINE.geometry(ann(), proj, ctx)!.hits}</svg>);
    const hit = container.querySelector('path')!;
    expect(hit.getAttribute('d')).toBe('M160 20V220');
    expect(hit.getAttribute('stroke')).toBe('transparent');
    expect(hit.getAttribute('pointer-events')).toBe('stroke');
    expect(hit.hasAttribute('data-annotation-hit')).toBe(true);
  });

  it('draws on any grid: its axis need not be drawn there', () => {
    const geo = VLINE.geometry(ann({ axisId: 'elsewhere' }), { ...proj, axisIds: [] }, ctx);
    expect(geo?.outline).toEqual(['M160 20V220']);
  });

  it('follows the grid rect', () => {
    const grid = { ...proj, gridRect: { left: 0, top: 5, width: 100, height: 50 } };
    const geo = VLINE.geometry(ann({ points: [{ t: 0, v: 0 }] }), grid, ctx)!;
    expect(geo.outline).toEqual(['M60 5V55']);
    expect(geo.handles).toEqual([[60, 30]]);
  });

  it('is null with no point or a non-finite x', () => {
    expect(VLINE.geometry(ann({ points: [] }), proj, ctx)).toBeNull();
    expect(VLINE.geometry(ann({ points: [{ t: NaN, v: 0 }] }), proj, ctx)).toBeNull();
    expect(VLINE.geometry(ann(), { ...proj, tToX: () => Infinity }, ctx)).toBeNull();
  });
});

describe('VLINE_TOOL Shape', () => {
  it('renders the line and label as base', () => {
    const a = ann({ text: 'inj', dash: true });
    const shape = renderShape(a).container;
    const base = renderBase(a)!;
    const sp = shape.querySelector('path')!;
    const bp = base.querySelector('path[stroke]:not([stroke="transparent"])')!;
    expect(sp.getAttribute('d')).toBe('M160 20V220');
    for (const attr of [
      'd',
      'stroke',
      'stroke-width',
      'stroke-dasharray',
      'fill',
      'pointer-events',
    ]) {
      expect(sp.getAttribute(attr)).toBe(bp.getAttribute(attr));
    }
    const st = shape.querySelector('text')!;
    const bt = base.querySelector('text')!;
    expect(st.textContent).toBe('inj');
    expect([st.getAttribute('x'), st.getAttribute('y')]).toEqual(['164', '32']);
    for (const attr of ['x', 'y', 'fill', 'font-size', 'text-anchor']) {
      expect(st.getAttribute(attr)).toBe(bt.getAttribute(attr));
    }
  });

  it('renders no label without text and no dash when solid', () => {
    const shape = renderShape(ann()).container;
    expect(shape.querySelector('text')).toBeNull();
    const p = shape.querySelector('path')!;
    expect(p.getAttribute('stroke')).toBe('#4589ff');
    expect(p.getAttribute('stroke-width')).toBe('2');
    expect(p.hasAttribute('stroke-dasharray')).toBe(false);
    expect(shape.querySelectorAll('path')).toHaveLength(1);
  });
});
