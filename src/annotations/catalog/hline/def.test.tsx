// @vitest-environment jsdom
// H-line tool definition: identity, placement, text, field, codec,
// geometry, and that its Shape renders the same marks as today's layer.
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { drawingThemeFor } from '../../../annotationTheme';
import { HorizontalLineIcon } from '../../icons';
import { createProjectionStore, type Projection } from '../../../plot/geometry';
import { projectionOf } from '../../../plot/testUtils';
import { type Annotation, objNameIn } from '../../model';
import { AnnotationLayer } from '../../AnnotationLayer';
import registryRaw from '../../__fixtures__/registry.json?raw';
import type { Axis } from '../../../types';
import type { GridProjection } from '../types';
import { TIME_X_AXIS } from '../xAxis';
import { HLINE_TOOL } from './def';
import { BUILTIN_CATALOG } from '..';
import { toolHintIn } from '../../statusHints';

const TRACE_LAYER = { catalog: BUILTIN_CATALOG, xAxis: TIME_X_AXIS };

afterEach(cleanup);

const GRID = { left: 60, top: 20, width: 400, height: 200 };
const tToX = (t: number) => GRID.left + t / 10;
const xToT = (x: number) => (x - GRID.left) * 10;
const vToY = (v: number, axisId: string) =>
  axisId === 'a' ? 220 - v : axisId === 'log' ? (v > 0 ? 220 - 50 * Math.log10(v) : NaN) : NaN;
const yToV = (y: number, axisId: string) => (axisId === 'a' ? 220 - y : NaN);

const grid: GridProjection = { tToX, xToT, vToY, yToV, gridRect: GRID, axisIds: ['a', 'log'] };
const ctx = { theme: drawingThemeFor('dark'), xAxis: TIME_X_AXIS };

function ann(over: Partial<Annotation> = {}): Annotation {
  return {
    id: 'h',
    kind: 'hline',
    points: [{ t: 0, v: 100 }],
    axisId: 'a',
    color: '#4589ff',
    width: 2,
    text: '',
    ...over,
  };
}

describe('HLINE_TOOL identity and placement', () => {
  it('matches the registry pin', () => {
    const registry = JSON.parse(registryRaw) as { tools: Record<string, unknown>[] };
    const pin = registry.tools.find((t) => t.kind === 'hline')!;
    expect(HLINE_TOOL.kind).toBe('hline');
    expect(HLINE_TOOL.code).toBe(0);
    expect(HLINE_TOOL.code).toBe(pin.code);
    expect(HLINE_TOOL.key).toBe('h');
    expect(HLINE_TOOL.key).toBe(pin.key);
    expect(HLINE_TOOL.label).toEqual({ long: 'Horizontal line', short: 'H-line' });
    expect(HLINE_TOOL.label).toEqual({ long: pin.label, short: pin.shortLabel });
    expect(HLINE_TOOL.icon).toBe(HorizontalLineIcon);
    expect(HLINE_TOOL.arity).toBe(1);
    expect(HLINE_TOOL.axes).toBe('y');
    expect(HLINE_TOOL.menuAdd).toEqual({ label: 'Add horizontal line here' });
    expect(HLINE_TOOL.inlineText).toBeUndefined();
    expect(HLINE_TOOL.codec).toEqual({ layout: 'v' });
    expect(HLINE_TOOL.validate).toBeUndefined();
  });

  it('shapePoint zeroes x and keeps v', () => {
    expect(HLINE_TOOL.shapePoint({ t: 1234, v: 5.5 })).toEqual({ t: 0, v: 5.5 });
  });
});

describe('HLINE_TOOL text', () => {
  it('objName equals base objName, with and without a unit', () => {
    const a = ann({ points: [{ t: 0, v: 2.34567 }] });
    const axis: Axis = {
      id: 'a',
      name: 'Current',
      units: 'mA',
      orientation: 'left',
      autoScale: true,
      logScale: false,
      visible: true,
    };
    expect(HLINE_TOOL.objName(a, { axis, xAxis: TIME_X_AXIS })).toBe(
      objNameIn(BUILTIN_CATALOG, TIME_X_AXIS, a, [axis])
    );
    expect(HLINE_TOOL.objName(a, { axis, xAxis: TIME_X_AXIS })).toBe('H-line 2.346 mA');
    const over = { ...axis, unitLabel: 'uA' };
    expect(HLINE_TOOL.objName(a, { axis: over, xAxis: TIME_X_AXIS })).toBe(
      objNameIn(BUILTIN_CATALOG, TIME_X_AXIS, a, [over])
    );
    expect(HLINE_TOOL.objName(a, { xAxis: TIME_X_AXIS })).toBe(
      objNameIn(BUILTIN_CATALOG, TIME_X_AXIS, a, [])
    );
    expect(HLINE_TOOL.objName(a, { xAxis: TIME_X_AXIS })).toBe('H-line 2.346');
  });

  it('hint equals the base status hint', () => {
    expect(HLINE_TOOL.hint({ xAxis: TIME_X_AXIS })).toBe(
      toolHintIn(BUILTIN_CATALOG, 'hline', { xAxis: TIME_X_AXIS })
    );
    expect(HLINE_TOOL.hint({ xAxis: TIME_X_AXIS })).toBe('Horizontal line: click to place');
  });
});

describe('HLINE_TOOL value field', () => {
  const [field] = HLINE_TOOL.fields;
  it('is the only field, with today id and label', () => {
    expect(HLINE_TOOL.fields).toHaveLength(1);
    expect(field.id).toBe('annotation-value');
    expect(field.label).toBe('Value');
    expect(field.kind).toBe('number');
    expect(field.when).toBeUndefined();
  });

  it('gets and sets the value, same reference when unchanged or invalid', () => {
    if (field.kind !== 'number') throw new Error('number field expected');
    const a = ann({ points: [{ t: 0, v: 7 }] });
    expect(field.get(a)).toBe(7);
    expect(field.get(ann({ points: [] }))).toBeNull();
    const b = field.set(a, 9);
    expect(b).not.toBe(a);
    expect(b.points).toEqual([{ t: 0, v: 9 }]);
    expect(a.points[0].v).toBe(7);
    expect(field.set(a, 7)).toBe(a);
    expect(field.set(a, null)).toBe(a);
    expect(field.set(a, Number.NaN)).toBe(a);
    expect(field.set(a, Number.POSITIVE_INFINITY)).toBe(a);
    const empty = ann({ points: [] });
    expect(field.set(empty, 3)).toBe(empty);
  });
});

describe('HLINE_TOOL geometry', () => {
  it('spans the grid at the projected y', () => {
    const g = HLINE_TOOL.geometry(ann(), grid, ctx);
    expect(g).not.toBeNull();
    expect(g!.outline).toEqual(['M60 120H460']);
    expect(g!.handles).toEqual([[260, 120]]);
    expect(g!.lockAt).toEqual([260, 120]);
  });

  it('is null with no points, an axis the grid does not draw, or a non-finite y', () => {
    expect(HLINE_TOOL.geometry(ann({ points: [] }), grid, ctx)).toBeNull();
    expect(HLINE_TOOL.geometry(ann({ axisId: 'zz' }), grid, ctx)).toBeNull();
    expect(HLINE_TOOL.geometry(ann(), { ...grid, axisIds: ['log'] }, ctx)).toBeNull();
    expect(
      HLINE_TOOL.geometry(ann({ axisId: 'log', points: [{ t: 0, v: -1 }] }), grid, ctx)
    ).toBeNull();
    expect(HLINE_TOOL.geometry(ann({ points: [{ t: Number.NaN, v: 1 }] }), grid, ctx)).toBeNull();
  });

  it('hits along the line with key h0', () => {
    const g = HLINE_TOOL.geometry(ann(), grid, ctx)!;
    const { container } = render(<svg>{g.hits}</svg>);
    const hit = container.querySelector('path[data-annotation-hit]');
    expect(hit?.getAttribute('d')).toBe('M60 120H460');
    expect(hit?.getAttribute('stroke')).toBe('transparent');
  });
});

describe('HLINE_TOOL Shape renders the same marks as base', () => {
  function baseMarks(a: Annotation) {
    const store = createProjectionStore((): Projection => projectionOf(grid));
    const utils = render(
      <div style={{ position: 'relative' }}>
        <AnnotationLayer
          config={TRACE_LAYER}
          projectionStore={store}
          annotations={[a]}
          axes={[{ id: 'a' }, { id: 'log' }]}
          theme={drawingThemeFor('dark')}
        />
      </div>
    );
    act(() => store.bump());
    const el = utils.container.querySelector(`[data-annotation-id="${a.id}"]`);
    const path = el?.querySelector('path[stroke]:not([stroke="transparent"])');
    const text = el?.querySelector('text[data-annotation-label]');
    const out = {
      path: path ? attrs(path) : null,
      text: text ? { ...attrs(text), body: text.textContent } : null,
    };
    utils.unmount();
    return out;
  }

  function toolMarks(a: Annotation) {
    const g = HLINE_TOOL.geometry(a, grid, ctx)!;
    const Shape = HLINE_TOOL.Shape;
    const { container, unmount } = render(
      <svg>
        <Shape annotation={a} geometry={g} />
      </svg>
    );
    const path = container.querySelector('path[stroke]:not([stroke="transparent"])');
    const text = container.querySelector('text[data-annotation-label]');
    const out = {
      path: path ? attrs(path) : null,
      text: text ? { ...attrs(text), body: text.textContent } : null,
    };
    unmount();
    return out;
  }

  function attrs(el: Element): Record<string, string> {
    return Object.fromEntries(Array.from(el.attributes).map((x) => [x.name, x.value]));
  }

  it.each([
    ['plain', ann()],
    ['labelled and dashed', ann({ text: 'limit', dash: true, width: 3, color: '#ff8389' })],
    ['on the log axis', ann({ axisId: 'log', points: [{ t: 0, v: 10 }], text: 'x' })],
  ])('%s', (_name, a) => {
    const base = baseMarks(a);
    const tool = toolMarks(a);
    expect(base.path).not.toBeNull();
    expect(tool).toEqual(base);
  });
});
