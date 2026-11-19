// @vitest-environment jsdom
// Trend tool definition: identity, placement, text, the extend
// field, its link flags and file validation, extended-line geometry, and that
// its Shape renders the same marks as today's layer.
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { drawingThemeFor } from '../../../annotationTheme';
import { TrendLineIcon } from '../../icons';
import { createProjectionStore, type Projection } from '../../../plot/geometry';
import { projectionOf } from '../../../plot/testUtils';
import { type Annotation, objNameIn, validateAnnotationIn } from '../../model';
import { AnnotationLayer } from '../../AnnotationLayer';
import registryRaw from '../../__fixtures__/registry.json?raw';
import type { Axis } from '../../../types';
import type { GridProjection } from '../types';
import { EXTEND_PX } from '../shapeKit';
import { TIME_X_AXIS } from '../xAxis';
import { TREND_TOOL } from './def';
import { BUILTIN_CATALOG } from '..';
import { toolHintIn } from '../../statusHints';

const TRACE_LAYER = { catalog: BUILTIN_CATALOG, xAxis: TIME_X_AXIS };

const validateTraceDrawing = (raw: unknown) =>
  validateAnnotationIn(BUILTIN_CATALOG, raw, TIME_X_AXIS, 'Trace');

afterEach(cleanup);

const GRID = { left: 60, top: 20, width: 400, height: 200 };
const tToX = (t: number) => GRID.left + t / 10;
const xToT = (x: number) => (x - GRID.left) * 10;
const vToY = (v: number, axisId: string) =>
  axisId === 'a' ? 220 - v : axisId === 'log' ? (v > 0 ? 220 - 50 * Math.log10(v) : NaN) : NaN;
const yToV = (y: number, axisId: string) => (axisId === 'a' ? 220 - y : NaN);

const grid: GridProjection = { tToX, xToT, vToY, yToV, gridRect: GRID, axisIds: ['a', 'log'] };
const ctx = { theme: drawingThemeFor('dark'), xAxis: TIME_X_AXIS };

// (0, 100) -> (60, 120); (300, 130) -> (90, 90): dx 30, dy -30.
function ann(over: Partial<Annotation> = {}): Annotation {
  return {
    id: 'l',
    kind: 'trend',
    points: [
      { t: 0, v: 100 },
      { t: 300, v: 130 },
    ],
    axisId: 'a',
    color: '#4589ff',
    width: 2,
    text: '',
    ...over,
  };
}

const AXIS: Axis = {
  id: 'a',
  name: 'Current',
  units: 'mA',
  orientation: 'left',
  autoScale: true,
  logScale: false,
  visible: true,
};

describe('TREND_TOOL identity and placement', () => {
  it('matches the registry pin', () => {
    const registry = JSON.parse(registryRaw) as { tools: Record<string, unknown>[] };
    const pin = registry.tools.find((t) => t.kind === 'trend')!;
    expect(TREND_TOOL.kind).toBe('trend');
    expect(TREND_TOOL.code).toBe(3);
    expect(TREND_TOOL.code).toBe(pin.code);
    expect(TREND_TOOL.key).toBe('l');
    expect(TREND_TOOL.key).toBe(pin.key);
    expect(TREND_TOOL.label).toEqual({ long: 'Trend line', short: 'Trend' });
    expect(TREND_TOOL.label).toEqual({ long: pin.label, short: pin.shortLabel });
    expect(TREND_TOOL.icon).toBe(TrendLineIcon);
    expect(TREND_TOOL.arity).toBe(2);
    expect(TREND_TOOL.axes).toBe('xy');
    expect(TREND_TOOL.menuAdd).toBeUndefined();
    expect(TREND_TOOL.inlineText).toBeUndefined();
    expect(TREND_TOOL.modifierGesture).toBeUndefined();
    expect(TREND_TOOL.card).toBeUndefined();
    expect(TREND_TOOL.codec.layout).toBe('tvtv');
    expect(TREND_TOOL.codec.flags).toBeDefined();
  });

  it('shapePoint keeps both coordinates', () => {
    expect(TREND_TOOL.shapePoint({ t: 1234, v: 5.5 })).toEqual({ t: 1234, v: 5.5 });
  });
});

describe('TREND_TOOL text', () => {
  it('objName equals base objName, with and without an axis name', () => {
    const a = ann();
    expect(TREND_TOOL.objName(a, { axis: AXIS, xAxis: TIME_X_AXIS })).toBe(
      objNameIn(BUILTIN_CATALOG, TIME_X_AXIS, a, [AXIS])
    );
    expect(TREND_TOOL.objName(a, { axis: AXIS, xAxis: TIME_X_AXIS })).toBe('Trend (Current)');
    const unnamed = { ...AXIS, name: '' };
    expect(TREND_TOOL.objName(a, { axis: unnamed, xAxis: TIME_X_AXIS })).toBe(
      objNameIn(BUILTIN_CATALOG, TIME_X_AXIS, a, [unnamed])
    );
    expect(TREND_TOOL.objName(a, { xAxis: TIME_X_AXIS })).toBe(
      objNameIn(BUILTIN_CATALOG, TIME_X_AXIS, a, [])
    );
    expect(TREND_TOOL.objName(a, { xAxis: TIME_X_AXIS })).toBe('Trend');
  });

  it('hint equals the base status hint', () => {
    expect(TREND_TOOL.hint({ xAxis: TIME_X_AXIS })).toBe(
      toolHintIn(BUILTIN_CATALOG, 'trend', { xAxis: TIME_X_AXIS })
    );
    expect(TREND_TOOL.hint({ xAxis: TIME_X_AXIS })).toBe('Trend line: drag or click twice');
  });
});

describe('TREND_TOOL extend field', () => {
  const [field] = TREND_TOOL.fields;
  it('is the only field, with today id, label and options', () => {
    expect(TREND_TOOL.fields).toHaveLength(1);
    expect(field.id).toBe('annotation-extend');
    expect(field.label).toBe('Extend');
    expect(field.kind).toBe('select');
    expect(field.when).toBeUndefined();
    if (field.kind !== 'select') throw new Error('select field expected');
    expect(field.options(ann())).toEqual([
      { value: 'none', label: 'None' },
      { value: 'right', label: 'Right' },
      { value: 'both', label: 'Both' },
    ]);
  });

  it('gets and sets extend, deleting the key for none, same reference when unchanged', () => {
    if (field.kind !== 'select') throw new Error('select field expected');
    const a = ann();
    expect(field.get(a)).toBe('none');
    expect(field.get(ann({ extend: 'right' }))).toBe('right');
    expect(field.get(ann({ extend: 'both' }))).toBe('both');

    const r = field.set(a, 'right');
    expect(r).not.toBe(a);
    expect(r.extend).toBe('right');
    expect(a.extend).toBeUndefined();
    expect(field.set(r, 'right')).toBe(r);
    const b = field.set(r, 'both');
    expect(b.extend).toBe('both');
    const n = field.set(b, 'none');
    expect('extend' in n).toBe(false);
    expect(n).toEqual(a);
    expect(field.set(a, 'none')).toBe(a);
    expect(field.set(a, 'left')).toBe(a);
    expect(field.set(r, 'bogus')).toBe(r);
  });
});

describe('TREND_TOOL codec flags', () => {
  const flags = TREND_TOOL.codec.flags!;
  it('encodes r for right, b for both, nothing otherwise', () => {
    expect(flags.encode(ann())).toBe('');
    expect(flags.encode(ann({ extend: 'right' }))).toBe('r');
    expect(flags.encode(ann({ extend: 'both' }))).toBe('b');
  });

  it('decodes r and b among other letters, ignoring unknown ones', () => {
    const a = ann();
    expect(flags.decode('r', a).extend).toBe('right');
    expect(flags.decode('b', a).extend).toBe('both');
    expect(flags.decode('ldrw2', a).extend).toBe('right');
    expect(flags.decode('hbw3', a).extend).toBe('both');
    expect(flags.decode('', a)).toBe(a);
    expect(flags.decode('ldhw1xyz', a)).toBe(a);
    expect(a.extend).toBeUndefined();
  });

  it('round-trips', () => {
    for (const extend of [undefined, 'right', 'both'] as const) {
      const a = extend ? ann({ extend }) : ann();
      expect(flags.decode(flags.encode(a), ann()).extend).toBe(extend);
    }
  });
});

describe('TREND_TOOL validate', () => {
  const base = ann();
  it('copies a valid extend from raw', () => {
    const r = TREND_TOOL.validate!({ extend: 'right' }, base);
    expect(r).not.toBeNull();
    expect(r!.extend).toBe('right');
    expect(TREND_TOOL.validate!({ extend: 'both' }, base)!.extend).toBe('both');
    expect(base.extend).toBeUndefined();
  });

  it('returns base unchanged for a missing or invalid extend', () => {
    for (const extend of [undefined, 'none', 'left', 1, true, null, { a: 1 }]) {
      expect(TREND_TOOL.validate!({ extend }, base)).toBe(base);
    }
    expect(TREND_TOOL.validate!({}, base)).toBe(base);
  });

  it('agrees with base validateAnnotation', () => {
    for (const extend of [undefined, 'none', 'right', 'both', 'left', 7]) {
      const raw = { ...ann(), extend } as Record<string, unknown>;
      const common = { ...raw };
      delete common.extend;
      const baseCommon = validateTraceDrawing(common)!;
      expect(TREND_TOOL.validate!(raw, baseCommon)).toEqual(validateTraceDrawing(raw));
    }
  });
});

describe('TREND_TOOL geometry', () => {
  it('joins the two points when not extended', () => {
    const g = TREND_TOOL.geometry(ann(), grid, ctx);
    expect(g).not.toBeNull();
    expect(g!.outline).toEqual(['M60 120L90 90']);
    expect(g!.handles).toEqual([
      [60, 120],
      [90, 90],
    ]);
    expect(g!.lockAt).toEqual([60, 120]);
  });

  it('extends past the second point when extend is right', () => {
    const k = EXTEND_PX / Math.hypot(30, -30);
    const g = TREND_TOOL.geometry(ann({ extend: 'right' }), grid, ctx)!;
    expect(g.outline).toEqual([`M60 120L${90 + 30 * k} ${90 - 30 * k}`]);
    expect(g.handles).toEqual([
      [60, 120],
      [90, 90],
    ]);
    expect(g.lockAt).toEqual([60, 120]);
  });

  it('extends both ways when extend is both', () => {
    const k = EXTEND_PX / Math.hypot(30, -30);
    const g = TREND_TOOL.geometry(ann({ extend: 'both' }), grid, ctx)!;
    expect(g.outline).toEqual([`M${60 - 30 * k} ${120 + 30 * k}L${90 + 30 * k} ${90 - 30 * k}`]);
  });

  it('does not divide by zero for coincident points', () => {
    const p = { t: 100, v: 50 };
    const g = TREND_TOOL.geometry(ann({ points: [p, p], extend: 'both' }), grid, ctx)!;
    expect(g.outline).toEqual(['M70 170L70 170']);
  });

  it('is null with no points, an axis the grid does not draw, or a non-finite coordinate', () => {
    expect(TREND_TOOL.geometry(ann({ points: [] }), grid, ctx)).toBeNull();
    expect(TREND_TOOL.geometry(ann({ axisId: 'zz' }), grid, ctx)).toBeNull();
    expect(TREND_TOOL.geometry(ann(), { ...grid, axisIds: ['log'] }, ctx)).toBeNull();
    expect(
      TREND_TOOL.geometry(
        ann({
          axisId: 'log',
          points: [
            { t: 0, v: 10 },
            { t: 100, v: -1 },
          ],
        }),
        grid,
        ctx
      )
    ).toBeNull();
    expect(
      TREND_TOOL.geometry(
        ann({
          points: [
            { t: Number.NaN, v: 1 },
            { t: 1, v: 1 },
          ],
        }),
        grid,
        ctx
      )
    ).toBeNull();
  });

  it('hits along the line with key h0', () => {
    const g = TREND_TOOL.geometry(ann(), grid, ctx)!;
    const { container } = render(<svg>{g.hits}</svg>);
    const hit = container.querySelector('path[data-annotation-hit]');
    expect(hit?.getAttribute('d')).toBe('M60 120L90 90');
    expect(hit?.getAttribute('stroke')).toBe('transparent');
  });
});

describe('TREND_TOOL Shape renders the same marks as base', () => {
  function attrs(el: Element): Record<string, string> {
    return Object.fromEntries(Array.from(el.attributes).map((x) => [x.name, x.value]));
  }

  function marks(root: ParentNode) {
    const path = root.querySelector('path[stroke]:not([stroke="transparent"])');
    const text = root.querySelector('text[data-annotation-label]');
    return {
      path: path ? attrs(path) : null,
      text: text ? { ...attrs(text), body: text.textContent } : null,
    };
  }

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
    const el = utils.container.querySelector(`[data-annotation-id="${a.id}"]`)!;
    const out = marks(el);
    utils.unmount();
    return out;
  }

  function toolMarks(a: Annotation) {
    const g = TREND_TOOL.geometry(a, grid, ctx)!;
    const Shape = TREND_TOOL.Shape;
    const { container, unmount } = render(
      <svg>
        <Shape annotation={a} geometry={g} />
      </svg>
    );
    const out = marks(container);
    unmount();
    return out;
  }

  it.each([
    ['plain', ann()],
    ['labelled and dashed', ann({ text: 'slope', dash: true, width: 3, color: '#ff8389' })],
    ['extended right', ann({ extend: 'right', text: 'r' })],
    ['extended both', ann({ extend: 'both' })],
    [
      'on the log axis',
      ann({
        axisId: 'log',
        points: [
          { t: 0, v: 10 },
          { t: 200, v: 100 },
        ],
        text: 'x',
      }),
    ],
  ])('%s', (_name, a) => {
    const base = baseMarks(a);
    const tool = toolMarks(a);
    expect(base.path).not.toBeNull();
    expect(tool).toEqual(base);
  });
});
