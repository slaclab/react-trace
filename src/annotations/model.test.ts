// Pins the annotation data model: commit-time quantization, the
// lenient validator (one warning per dropped item, defaults for missing
// style), the empty-list rule of `withAnnotations`, the Layers names of
// `objNameIn` and the unknown-axis reassignment shared by rehydrate, the tuple
// decoder and undo.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ANNOTATION_INK, defaultAnnotationColor } from '../annotationTheme';
import type { Axis, Plot } from '../types';
import {
  ANNOTATION_WIDTHS,
  NEW_DRAWING_WIDTH,
  type Annotation,
  type AnnotationKind,
  arityIn,
  objNameIn,
  quantizePointIn,
  validateAnnotationIn,
} from './model';
import { reassignUnknownAxes, withAnnotations } from '../tools/trace/drawing/plotDrawings';
import { BUILTIN_CATALOG } from './catalog';
import { TIME_X_AXIS } from './catalog/xAxis';

const validateTraceDrawing = (raw: unknown) =>
  validateAnnotationIn(BUILTIN_CATALOG, raw, TIME_X_AXIS, 'Trace');

const KINDS: AnnotationKind[] = ['hline', 'vline', 'trange', 'trend', 'box', 'note', 'measure'];

function axis(id: string, extra: Partial<Axis> = {}): Axis {
  return {
    id,
    name: id,
    orientation: 'left',
    autoScale: true,
    logScale: false,
    visible: true,
    ...extra,
  };
}

function ann(extra: Partial<Annotation> = {}): Annotation {
  return {
    id: 'annotation-1',
    kind: 'hline',
    points: [{ t: 0, v: 1 }],
    axisId: 'a1',
    color: defaultAnnotationColor(0),
    width: 1.5,
    text: '',
    ...extra,
  };
}

function plot(extra: Partial<Plot> = {}): Plot {
  return {
    id: 'plot-1',
    title: 'P',
    traces: [],
    axes: [axis('a1')],
    showLegend: true,
    showXGridlines: true,
    showYGridlines: true,
    showCrosshair: true,
    gridStyle: 'solid',
    gridOpacity: 1,
    tickFontSize: 11,
    xAxis: { timeRange: '-1h' },
    ...extra,
  };
}

describe('built-in codes / arityIn', () => {
  it('codes the seven kinds 0..6 in rail order', () => {
    expect(Object.fromEntries(BUILTIN_CATALOG.tools.map((t) => [t.kind, t.code]))).toEqual({
      hline: 0,
      vline: 1,
      trange: 2,
      trend: 3,
      box: 4,
      note: 5,
      measure: 6,
    });
  });

  it('gives one point to hline/vline/note and two to the rest', () => {
    expect(KINDS.map((k) => arityIn(BUILTIN_CATALOG, k))).toEqual([1, 1, 2, 2, 2, 1, 2]);
  });
});

describe('the colour of a loaded drawing', () => {
  const load = (color: unknown) =>
    validateTraceDrawing({
      kind: 'hline',
      points: [{ t: 0, v: 1 }],
      axisId: 'a',
      color,
    })?.color;

  it.each(['#abc', 'rgb(1, 2, 3)', ANNOTATION_INK])('keeps %s', (color) => {
    expect(load(color)).toBe(color);
  });

  it.each(['url(https://example.test/beacon)', 'red;background:url(x)', 'red', ''])(
    'takes the default for %s',
    (color) => {
      expect(load(color)).toBe(defaultAnnotationColor(0));
    }
  );
});

describe('quantizePoint', () => {
  it('rounds t to integer ms and a free v to 6 significant digits', () => {
    expect(
      quantizePointIn(TIME_X_AXIS, { t: 1_700_000_000_123.6, v: 2.3456789123 }, false)
    ).toEqual({
      t: 1_700_000_000_124,
      v: 2.34568,
    });
    expect(quantizePointIn(TIME_X_AXIS, { t: 10.4, v: 0.000123456789 }, false)).toEqual({
      t: 10,
      v: 0.000123457,
    });
    expect(quantizePointIn(TIME_X_AXIS, { t: 0, v: 123456789 }, false)).toEqual({
      t: 0,
      v: 123457000,
    });
  });

  it('keeps a snapped v exact (only t is rounded)', () => {
    expect(quantizePointIn(TIME_X_AXIS, { t: 5.5, v: 2.3456789123 }, true)).toEqual({
      t: 6,
      v: 2.3456789123,
    });
  });

  it('is idempotent', () => {
    const once = quantizePointIn(TIME_X_AXIS, { t: 99.9, v: Math.PI }, false);
    expect(quantizePointIn(TIME_X_AXIS, once, false)).toEqual(once);
  });
});

describe('validateAnnotation', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it('passes a complete annotation through unchanged, without a warning', () => {
    const full = ann({
      kind: 'trend',
      points: [
        { t: 1, v: 2 },
        { t: 3, v: 4 },
      ],
      traceId: 'trace-1',
      color: defaultAnnotationColor(2),
      width: 3,
      dash: true,
      text: 'label',
      extend: 'both',
      locked: true,
      hidden: true,
    });
    expect(validateTraceDrawing(structuredClone(full))).toEqual(full);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ['null', null],
    ['a number', 42],
    ['an array', []],
    ['a string', 'hline'],
  ])('drops %s with one warning', (_, raw) => {
    expect(validateTraceDrawing(raw)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('drops an unknown kind with one warning', () => {
    expect(validateTraceDrawing({ ...ann(), kind: 'circle' })).toBeNull();
    expect(validateTraceDrawing({ ...ann(), kind: undefined })).toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['missing', undefined],
    ['not an array', { t: 0, v: 1 }],
    ['too few', [{ t: 0, v: 1 }]],
    ['a non-object point', [{ t: 0, v: 1 }, 7]],
    [
      'a non-finite t',
      [
        { t: 0, v: 1 },
        { t: Number.NaN, v: 2 },
      ],
    ],
    [
      'a non-finite v',
      [
        { t: 0, v: 1 },
        { t: 2, v: Infinity },
      ],
    ],
    [
      'a string coordinate',
      [
        { t: '0', v: 1 },
        { t: 2, v: 2 },
      ],
    ],
  ])('drops a two-point kind whose points are %s, with one warning', (_, points) => {
    expect(validateTraceDrawing({ ...ann({ kind: 'box' }), points })).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('drops a one-point kind with no points', () => {
    expect(validateTraceDrawing({ ...ann({ kind: 'note' }), points: [] })).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('keeps only the first arity points and rounds t to integer ms', () => {
    const out = validateTraceDrawing({
      ...ann({ kind: 'hline' }),
      points: [
        { t: 1.6, v: 1.23456789, extra: 1 },
        { t: 3, v: 4 },
      ],
    });
    expect(out?.points).toEqual([{ t: 2, v: 1.23456789 }]);
  });

  it('fills missing or invalid style with defaults and no warning', () => {
    const out = validateTraceDrawing({
      kind: 'trend',
      points: [
        { t: 0, v: 0 },
        { t: 1, v: 1 },
      ],
      axisId: 'a1',
      color: 7,
      width: 4,
      dash: 'yes',
      text: 12,
      extend: 'left',
      locked: false,
      hidden: 'no',
      traceId: '',
    });
    expect(out).not.toBeNull();
    expect(out!.id).toMatch(/^annotation-/);
    expect(out!.color).toBe(defaultAnnotationColor(0));
    expect(out!.width).toBe(NEW_DRAWING_WIDTH);
    expect(out!.text).toBe('');
    for (const key of ['dash', 'extend', 'locked', 'hidden', 'traceId'] as const) {
      expect(key in out!).toBe(false);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it('accepts every allowed width', () => {
    expect(ANNOTATION_WIDTHS).toEqual([0.5, 0.75, 1, 1.5, 2, 3]);
    for (const width of ANNOTATION_WIDTHS) {
      expect(validateTraceDrawing({ ...ann(), width })?.width).toBe(width);
    }
    // An absent width reads as the width a new drawing takes.
    const { width: _w, ...noWidth } = ann();
    void _w;
    expect(validateTraceDrawing(noWidth)?.width).toBe(NEW_DRAWING_WIDTH);
    expect(NEW_DRAWING_WIDTH).toBe(0.75);
  });

  it('keeps the theme ink as a colour', () => {
    expect(validateTraceDrawing({ ...ann(), color: ANNOTATION_INK })?.color).toBe(ANNOTATION_INK);
  });

  it('keeps extend only on a trend', () => {
    expect(
      validateTraceDrawing({
        ...ann({
          kind: 'trend',
          points: [
            { t: 0, v: 0 },
            { t: 1, v: 1 },
          ],
        }),
        extend: 'right',
      })?.extend
    ).toBe('right');
    const box = validateTraceDrawing({
      ...ann({
        kind: 'box',
        points: [
          { t: 0, v: 0 },
          { t: 1, v: 1 },
        ],
      }),
      extend: 'right',
    });
    expect(box && 'extend' in box).toBe(false);
  });

  it('defaults a missing axisId to empty so reassignUnknownAxes can resolve it', () => {
    const raw: Record<string, unknown> = { ...ann() };
    delete raw.axisId;
    expect(validateTraceDrawing(raw)?.axisId).toBe('');
  });

  it('strips unknown keys', () => {
    const out = validateTraceDrawing({ ...ann(), bogus: 1 });
    expect(out && 'bogus' in out).toBe(false);
  });

  it('does not mutate its input', () => {
    const raw = { ...ann(), points: [{ t: 1.5, v: 2 }] };
    const copy = structuredClone(raw);
    validateTraceDrawing(raw);
    expect(raw).toEqual(copy);
  });
});

describe('withAnnotations', () => {
  it('sets a non-empty list', () => {
    const list = [ann()];
    const out = withAnnotations(plot(), list);
    expect(out.annotations).toBe(list);
  });

  it('deletes the key when the list is empty', () => {
    const before = plot();
    const out = withAnnotations(plot({ annotations: [ann()] }), []);
    expect('annotations' in out).toBe(false);
    expect(JSON.stringify(out)).toBe(JSON.stringify(before));
  });

  it('does not mutate the input plot', () => {
    const p = plot({ annotations: [ann()] });
    withAnnotations(p, []);
    expect(p.annotations).toHaveLength(1);
  });
});

describe('reassignUnknownAxes', () => {
  const axes = [axis('a1'), axis('a2')];

  it('returns the same list when every axisId is known', () => {
    const list = [ann({ axisId: 'a1' }), ann({ id: 'x', axisId: 'a2' })];
    expect(reassignUnknownAxes(list, axes)).toBe(list);
  });

  it('moves a drawing on an unknown axis to the first axis and keeps the rest identical', () => {
    const kept = ann({ id: 'k', axisId: 'a2' });
    const lost = ann({ id: 'l', axisId: 'gone' });
    const out = reassignUnknownAxes([kept, lost], axes);
    expect(out[0]).toBe(kept);
    expect(out[1]).toEqual({ ...lost, axisId: 'a1' });
    expect(lost.axisId).toBe('gone');
  });

  it('resolves an empty axisId', () => {
    expect(reassignUnknownAxes([ann({ axisId: '' })], axes)[0].axisId).toBe('a1');
  });

  it('leaves the list alone when there is no axis to move to', () => {
    const list = [ann({ axisId: 'gone' })];
    expect(reassignUnknownAxes(list, [])).toBe(list);
  });
});

describe('objName', () => {
  const axes = [
    axis('a1', { name: 'Current', units: 'mA' }),
    axis('a2', { name: 'Gap', units: 'mm', unitLabel: 'µm' }),
  ];

  it('names an hline by value and axis unit', () => {
    expect(
      objNameIn(BUILTIN_CATALOG, TIME_X_AXIS, ann({ points: [{ t: 0, v: 2.35 }] }), axes)
    ).toBe('H-line 2.35 mA');
    expect(
      objNameIn(BUILTIN_CATALOG, TIME_X_AXIS, ann({ axisId: 'a2', points: [{ t: 0, v: 7 }] }), axes)
    ).toBe('H-line 7 µm');
    expect(
      objNameIn(
        BUILTIN_CATALOG,
        TIME_X_AXIS,
        ann({ axisId: 'gone', points: [{ t: 0, v: 7 }] }),
        axes
      )
    ).toBe('H-line 7');
  });

  it('names a vline by its local wall-clock time', () => {
    const t = new Date(2026, 9, 18, 14, 2, 11).getTime();
    expect(
      objNameIn(BUILTIN_CATALOG, TIME_X_AXIS, ann({ kind: 'vline', points: [{ t, v: 0 }] }), axes)
    ).toBe('V-line 14:02:11');
  });

  it('names a range by its duration', () => {
    const a = ann({
      kind: 'trange',
      points: [
        { t: 1000, v: 0 },
        { t: 1000 + 750_000, v: 0 },
      ],
    });
    expect(objNameIn(BUILTIN_CATALOG, TIME_X_AXIS, a, axes)).toBe('Range 12 m 30 s');
    const reversed = { ...a, points: [...a.points].reverse() };
    expect(objNameIn(BUILTIN_CATALOG, TIME_X_AXIS, reversed, axes)).toBe('Range 12 m 30 s');
  });

  it.each([
    [0, '0 s'],
    [450, '450 ms'],
    [5_000, '5 s'],
    [3_600_000, '1 h'],
    [5_400_000, '1 h 30 m'],
    [90_061_000, '1 d 1 h'],
  ])('formats a %d ms range as %s', (ms, text) => {
    const a = ann({
      kind: 'trange',
      points: [
        { t: 0, v: 0 },
        { t: ms, v: 0 },
      ],
    });
    expect(objNameIn(BUILTIN_CATALOG, TIME_X_AXIS, a, axes)).toBe(`Range ${text}`);
  });

  it('names a trend and a box by their axis', () => {
    const pts = [
      { t: 0, v: 0 },
      { t: 1, v: 1 },
    ];
    expect(objNameIn(BUILTIN_CATALOG, TIME_X_AXIS, ann({ kind: 'trend', points: pts }), axes)).toBe(
      'Trend (Current)'
    );
    expect(objNameIn(BUILTIN_CATALOG, TIME_X_AXIS, ann({ kind: 'box', points: pts }), axes)).toBe(
      'Box (Current)'
    );
    expect(
      objNameIn(
        BUILTIN_CATALOG,
        TIME_X_AXIS,
        ann({ kind: 'box', points: pts, axisId: 'gone' }),
        axes
      )
    ).toBe('Box');
  });

  it('names a note by its text, truncated', () => {
    expect(
      objNameIn(BUILTIN_CATALOG, TIME_X_AXIS, ann({ kind: 'note', text: 'beam dump' }), axes)
    ).toBe('Note “beam dump”');
    expect(objNameIn(BUILTIN_CATALOG, TIME_X_AXIS, ann({ kind: 'note', text: '' }), axes)).toBe(
      'Note'
    );
    expect(
      objNameIn(BUILTIN_CATALOG, TIME_X_AXIS, ann({ kind: 'note', text: '  multi\nline  ' }), axes)
    ).toBe('Note “multi line”');
    const long = 'x'.repeat(40);
    expect(objNameIn(BUILTIN_CATALOG, TIME_X_AXIS, ann({ kind: 'note', text: long }), axes)).toBe(
      `Note “${'x'.repeat(23)}…”`
    );
  });

  it('names a measure by Δv and Δt', () => {
    const a = ann({
      kind: 'measure',
      points: [
        { t: 0, v: 1.0 },
        { t: 70_000, v: 1.42 },
      ],
    });
    expect(objNameIn(BUILTIN_CATALOG, TIME_X_AXIS, a, axes)).toBe('Measure Δ0.42 mA / 1 m 10 s');
    expect(objNameIn(BUILTIN_CATALOG, TIME_X_AXIS, a, axes, true)).toBe(
      'Measure ≈Δ0.42 mA / 1 m 10 s'
    );
  });
});
