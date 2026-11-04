// Pins the `plot=` drawing tuples: the points
// layout of every kind (note = `tv`), axis and trace indices
// (traceId -> index -> traceId), default-colour omission, the flags
// `l h d r b w1 w2 w3`, the MAX_DRAWINGS cap in encoder and
// decoder, per-tuple leniency with one warning, and that
// applyPlotConfig decodes `drawings` instead of spreading it onto the Plot.
// Also the BUDGET_VIEW byte budget and the drawing shrink step
// through the whole query pipeline.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ANNOTATION_INK, defaultAnnotationColor } from '../annotationTheme';
import { applyPlotConfig, parsePlotConfig, plotConfigOf } from '../embed/plotConfig';
import { buildInitialPlots } from '../embed/initialPlots';
import { MAX_QUERY_BYTES, serializeTraceQuery } from '../embed/query';
import { DEFAULT_PALETTE_ID, getPalette } from '../palettes';
import type { Axis } from '../types';
import {
  decodeDrawings,
  type DrawingTuple,
  encodeDrawings,
  encodeJsonParam,
  MAX_DRAWINGS,
} from './config';
import { BUILTIN_CATALOG, CORRELATION_CATALOG } from './catalog';
import { VALUE_X_AXIS, TIME_X_AXIS } from './catalog/xAxis';
import {
  type Annotation,
  type AnnotationKind,
  type AnnotationPoint,
  quantizePointIn,
} from './model';

/** A built-in tool's wire code. */
const code = (kind: string): number => BUILTIN_CATALOG.byKind(kind)!.code;

function axis(id: string): Axis {
  return { id, name: id, orientation: 'left', autoScale: true, logScale: false, visible: true };
}

const AXES = [axis('a1'), axis('a2')];
const TRACES = [{ id: 'tA' }, { id: 'tB' }, { id: 'tC' }];
const P0 = { t: 1_000_000, v: 1.5 };
const P1 = { t: 2_000_000, v: -2.25 };

function ann(extra: Partial<Annotation> = {}): Annotation {
  return {
    id: 'annotation-1',
    kind: 'trend',
    points: [P0, P1],
    axisId: 'a1',
    color: defaultAnnotationColor(0),
    width: 0.75,
    text: '',
    ...extra,
  };
}

/** Trace's codec: the built-in tools on a time axis. */
const TRACE_CODEC = { catalog: BUILTIN_CATALOG, xAxis: TIME_X_AXIS };

function encode(list: Annotation[]): DrawingTuple[] | undefined {
  return encodeDrawings({ annotations: list, axes: AXES }, TRACES, TRACE_CODEC);
}

function decode(raw: unknown): Annotation[] {
  return decodeDrawings(raw, { axes: AXES }, TRACES, TRACE_CODEC);
}

/** An annotation without its (regenerated) id. */
const noId = ({ id: _id, ...rest }: Annotation) => (void _id, rest);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('tuple points layout', () => {
  it('fixes the points layout of every built-in kind', () => {
    expect(Object.fromEntries(BUILTIN_CATALOG.tools.map((t) => [t.kind, t.codec.layout]))).toEqual({
      hline: 'v',
      vline: 't',
      trange: 'tt',
      note: 'tv',
      trend: 'tvtv',
      box: 'tvtv',
      measure: 'tvtv',
    });
  });

  it.each([
    ['hline', [P0], [1.5]],
    ['vline', [P0], [1_000_000]],
    ['trange', [P0, P1], [1_000_000, 2_000_000]],
    ['note', [P0], [1_000_000, 1.5]],
    ['trend', [P0, P1], [1_000_000, 1.5, 2_000_000, -2.25]],
    ['box', [P0, P1], [1_000_000, 1.5, 2_000_000, -2.25]],
    ['measure', [P0, P1], [1_000_000, 1.5, 2_000_000, -2.25]],
  ] as const)('%s encodes its points as %j', (kind, points, expected) => {
    const [tuple] = encode([ann({ kind, points: [...points] })])!;
    expect(tuple[0]).toBe(code(kind));
    expect(tuple[1]).toEqual(expected);
    const [back] = decode([tuple]);
    expect(back.kind).toBe(kind);
    expect(encode([back])).toEqual([tuple]);
  });
});

describe('encodeDrawings', () => {
  it('is undefined with no drawings', () => {
    expect(encodeDrawings({ axes: AXES }, TRACES, TRACE_CODEC)).toBeUndefined();
    expect(encode([])).toBeUndefined();
  });

  it('writes the bare tuple for a default drawing', () => {
    expect(encode([ann()])).toEqual([[code('trend'), [1_000_000, 1.5, 2_000_000, -2.25], 0, null]]);
  });

  it('names the axis by index and the snapped trace by its query index', () => {
    const [tuple] = encode([ann({ axisId: 'a2', traceId: 'tC' })])!;
    expect(tuple[2]).toBe(1);
    expect(tuple[3]).toBe(2);
  });

  it('writes null for a trace that is not in the query (formula or unsnapped)', () => {
    const [tuple] = encode([ann({ traceId: 'formula-1' })])!;
    expect(tuple[3]).toBeNull();
  });

  it('omits the colour only when it is the palette default for its index', () => {
    const list = [
      ann({ color: defaultAnnotationColor(0) }),
      ann({ color: defaultAnnotationColor(0) }),
      ann({ color: defaultAnnotationColor(2) }),
    ];
    const tuples = encode(list)!;
    expect(tuples[0]).toHaveLength(4);
    expect(tuples[1][4]).toBe(defaultAnnotationColor(0));
    expect(tuples[2]).toHaveLength(4);
  });

  it('fills an omitted slot before a present one with an empty string', () => {
    const [tuple] = encode([ann({ locked: true })])!;
    expect(tuple.slice(4)).toEqual(['', '', 'l']);
  });

  it.each([
    [0.75, undefined],
    [1, 'w1'],
    [1.5, 'w1.5'],
    [2, 'w2'],
    [3, 'w3'],
  ] as const)('width %s writes flags %s', (width, flags) => {
    const [tuple] = encode([ann({ width })])!;
    expect(tuple[6]).toBe(flags);
    expect(decode([tuple])[0].width).toBe(width);
  });

  it('keeps the first MAX_DRAWINGS with one warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const list = Array.from({ length: 70 }, (_, i) =>
      ann({ kind: 'hline', points: [{ t: 0, v: i }], color: defaultAnnotationColor(i) })
    );
    const tuples = encode(list)!;
    expect(tuples).toHaveLength(MAX_DRAWINGS);
    expect(tuples[63][1]).toEqual([63]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('kept 64 of 70');
  });
});

describe('decodeDrawings: round trip', () => {
  it('keeps every field through encode/decode, traceId -> index -> traceId included', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const list: Annotation[] = [
      ann({ axisId: 'a2', traceId: 'tB', color: '#ff0000', text: 'ramp "a" & b', dash: true }),
      ann({ kind: 'note', points: [P0], text: 'hello', color: defaultAnnotationColor(1) }),
      ann({ kind: 'box', color: defaultAnnotationColor(2), locked: true, hidden: true, width: 3 }),
      ann({ extend: 'right', color: defaultAnnotationColor(3) }),
      ann({ extend: 'both', color: defaultAnnotationColor(4), width: 1 }),
    ];
    const back = decode(JSON.parse(JSON.stringify(encode(list))));
    expect(back.map(noId)).toEqual(list.map(noId));
    expect(back[0].traceId).toBe('tB');
    expect(back.every((a) => a.id.startsWith('annotation'))).toBe(true);
    expect(new Set(back.map((a) => a.id)).size).toBe(back.length);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ['dash', { dash: true }, 'd'],
    ['locked', { locked: true }, 'l'],
    ['hidden', { hidden: true }, 'h'],
    ['extend right', { extend: 'right' }, 'r'],
    ['extend both', { extend: 'both' }, 'b'],
  ] as const)('%s round-trips as flag %s', (_name, extra, flag) => {
    const a = ann(extra as Partial<Annotation>);
    const [tuple] = encode([a])!;
    expect(tuple[6]).toBe(flag);
    expect(noId(decode([tuple])[0])).toEqual(noId(a));
  });

  it.each([
    ['0.5', 0.5, 'w.5'],
    ['1', 1, 'w1'],
    ['1.5', 1.5, 'w1.5'],
    ['2', 2, 'w2'],
    ['3', 3, 'w3'],
  ] as const)('width %s round-trips as flag %s', (_name, width, flag) => {
    const a = ann({ width });
    const [tuple] = encode([a])!;
    expect(tuple[6]).toBe(flag);
    expect(noId(decode([tuple])[0])).toEqual(noId(a));
  });

  it('writes no width flag for the default width', () => {
    const [tuple] = encode([ann({ width: 0.75 })])!;
    expect(tuple[6] ?? '').toBe('');
  });

  it('still reads the w.75 flag older links carry', () => {
    const [t] = encode([ann({ width: 2 })])!;
    const old: DrawingTuple = [t[0], t[1], t[2], t[3], '', '', 'w.75'];
    expect(decode([old])[0].width).toBe(0.75);
  });

  it('round-trips the theme ink as its colour slot', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = ann({ color: ANNOTATION_INK, width: 1.5 });
    const [tuple] = encode([a])!;
    expect(tuple[4]).toBe(ANNOTATION_INK);
    expect(tuple[6]).toBe('w1.5');
    expect(noId(decode(JSON.parse(JSON.stringify([tuple])))[0])).toEqual(noId(a));
    expect(warn).not.toHaveBeenCalled();
  });

  it('fills an absent colour with the palette default for the tuple index', () => {
    const tuple: DrawingTuple = [code('vline'), [5], 0, null];
    const back = decode([tuple, tuple, tuple]);
    expect(back.map((a) => a.color)).toEqual([0, 1, 2].map(defaultAnnotationColor));
  });

  it('applies extend only to a trend, and ignores unknown flag letters', () => {
    const [box] = decode([[code('box'), [1, 2, 3, 4], 0, null, '', '', 'bzx']]);
    expect(box.extend).toBeUndefined();
    const [trend] = decode([[code('trend'), [1, 2, 3, 4], 0, null, '', '', 'qrw2']]);
    expect(trend.extend).toBe('right');
    expect(trend.width).toBe(2);
  });

  it('moves an axis index past the list to the first axis', () => {
    const [a] = decode([[code('hline'), [1], 9, null]]);
    expect(a.axisId).toBe('a1');
  });
});

describe('decodeDrawings: leniency', () => {
  it.each([
    ['not an array', 'nope'],
    ['an unknown kind code', [99, [1], 0, null]],
    ['a non-integer kind code', ['hline', [1], 0, null]],
    ['too few points', [code('trend'), [1, 2, 3], 0, null]],
    ['a non-finite point', [code('note'), [1, 'x'], 0, null]],
    ['points not an array', [code('hline'), 1, 0, null]],
    ['a negative axis index', [code('hline'), [1], -1, null]],
    ['a fractional trace index', [code('hline'), [1], 0, 0.5]],
    ['a trace index past the pv list', [code('hline'), [1], 0, 3]],
    ['a bad colour', [code('hline'), [1], 0, null, 'red']],
    ['a non-string text', [code('hline'), [1], 0, null, '', 42]],
    ['non-string flags', [code('hline'), [1], 0, null, '', '', 7]],
  ])('drops a tuple with %s, keeps the rest, warns once', (_name, bad) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const good: DrawingTuple = [code('vline'), [10], 0, null];
    const back = decode([good, bad, good]);
    expect(back).toHaveLength(2);
    expect(back.every((a) => a.kind === 'vline')).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('decodes 70 hlines to the first 64, with one warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const raw = Array.from({ length: 70 }, (_, i) => [code('hline'), [i], 0, null]);
    const back = decode(raw);
    expect(back).toHaveLength(MAX_DRAWINGS);
    expect(back[63].points[0].v).toBe(63);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('returns no drawings for a value that is not an array', () => {
    expect(decode({ a: 1 })).toEqual([]);
  });
});

// ── Wiring into the plot config ─────────────────────────────────────────────

const palette = getPalette(DEFAULT_PALETTE_ID);
const opened = (search: string) => buildInitialPlots(search, palette)[0];

describe('plot config: drawings', () => {
  it('plotConfigOf encodes the drawings against the query traces and axes', () => {
    const plot = opened('?pv=X:A&pv=X:B&range=-1h');
    const withDrawing = {
      ...plot,
      annotations: [ann({ axisId: plot.axes[0].id, traceId: plot.traces[1].id })],
    };
    expect(plotConfigOf(plot)).toBeUndefined();
    expect(plotConfigOf(withDrawing)?.drawings).toEqual([
      [code('trend'), [1_000_000, 1.5, 2_000_000, -2.25], 0, 1],
    ]);
  });

  it('accepts any array as drawings in parsePlotConfig and drops a non-array', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const many = Array.from({ length: 70 }, () => [code('hline'), [1], 0, null]);
    expect(parsePlotConfig(JSON.stringify({ v: 1, drawings: many }))?.drawings).toHaveLength(70);
    expect(warn).not.toHaveBeenCalled();
    expect(parsePlotConfig(JSON.stringify({ v: 1, drawings: 'x' }))?.drawings).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('applyPlotConfig decodes drawings into annotations and leaves no drawings key on the Plot', () => {
    const plot = opened('?pv=X:A&pv=X:B&range=-1h');
    const out = applyPlotConfig(plot, {
      v: 1,
      axes: [{ name: 'One' }, { name: 'Two' }],
      drawings: [[code('hline'), [2.5], 1, 1, '', 'limit', 'l']],
    });
    expect('drawings' in out).toBe(false);
    expect(out.annotations).toHaveLength(1);
    const [a] = out.annotations!;
    expect(a.axisId).toBe(out.axes[1].id);
    expect(a.traceId).toBe(out.traces[1].id);
    expect(a.text).toBe('limit');
    expect(a.locked).toBe(true);
  });

  it('applyPlotConfig with no valid drawing leaves annotations absent', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const plot = opened('?pv=X:A&range=-1h');
    const out = applyPlotConfig(plot, { v: 1, drawings: [[99, [], 0, null]] });
    expect('annotations' in out).toBe(false);
    expect('drawings' in out).toBe(false);
  });

  it('round-trips through the query: drawings survive a reopen', () => {
    const plot = opened('?pv=X:A&pv=X:B&range=-1h');
    const list = [
      ann({
        kind: 'note',
        points: [P0],
        text: 'n',
        axisId: plot.axes[0].id,
        traceId: plot.traces[0].id,
      }),
    ];
    const config = plotConfigOf({ ...plot, annotations: list })!;
    const reopened = opened(
      `?pv=X:A&pv=X:B&range=-1h&plot=${encodeURIComponent(JSON.stringify(config))}`
    );
    expect(reopened.annotations?.map(noId)).toEqual(
      list.map((a) => noId({ ...a, traceId: reopened.traces[0].id, axisId: reopened.axes[0].id }))
    );
  });
});

// ── The byte budget ──────────────────────────────

/** `n` characters starting with `prefix`, padded with letters. */
const chars = (prefix: string, n: number) => prefix.padEnd(n, 'X');

const BUDGET_T0 = 1_760_000_000_000;

/** As the commit path (tools.ts) does: zero the coordinate a kind ignores. */
function shapePoint(kind: AnnotationKind, p: AnnotationPoint): AnnotationPoint {
  if (kind === 'hline') return { t: 0, v: p.v };
  if (kind === 'vline' || kind === 'trange') return { t: p.t, v: 0 };
  return p;
}

// A realistic heavy view: 8 PVs with 40-character names, 3 axes with units
// and manual limits, explicit trace colours, and 10 drawings (2 of each
// hline/vline/trange/box/note) with 40-character texts, whose points are raw
// pixel-converted floats quantized as the commit path does.
function budgetView() {
  const pvs = Array.from({ length: 8 }, (_, i) => chars(`TEST${i}:BPM:${i}:POSITION:`, 40));
  const base = opened(`?${pvs.map((p) => `pv=${p}`).join('&')}&range=-1h`);
  const axes: Axis[] = ['mm', 'mA', 'kV'].map((units, i) => ({
    ...axis(`budget-axis-${i}`),
    name: `Axis ${units}`,
    units,
    autoScale: false,
    min: -12.5 * (i + 1),
    max: 37.25 * (i + 1),
    orientation: i === 2 ? 'right' : 'left',
  }));
  const colors = [
    '#1f77b4',
    '#ff7f0e',
    '#2ca02c',
    '#d62728',
    '#9467bd',
    '#8c564b',
    '#e377c2',
    '#7f7f7f',
  ];
  const traces = base.traces.map((t, i) => ({ ...t, axisId: axes[i % 3].id, color: colors[i] }));
  const raw = (i: number, j: number) => ({
    t: BUDGET_T0 + 123_456.789 * (i + 1) + 98_765.4321 * j + 0.333_333_3,
    v: Math.PI * (i + 1) * (j === 0 ? 1 : -1.7) + 1e-9 * Math.E,
  });
  const kinds: AnnotationKind[] = ['hline', 'vline', 'trange', 'box', 'note'];
  const annotations: Annotation[] = Array.from({ length: 10 }, (_, i) => {
    const kind = kinds[i % 5];
    const arity = kind === 'hline' || kind === 'vline' || kind === 'note' ? 1 : 2;
    return {
      id: `annotation-budget-${i}`,
      kind,
      points: Array.from({ length: arity }, (_, j) =>
        shapePoint(kind, quantizePointIn(TIME_X_AXIS, raw(i, j), false))
      ),
      axisId: axes[i % 3].id,
      ...(i % 2 === 0 ? { traceId: traces[i % 8].id } : {}),
      color: colors[(i + 3) % 8],
      width: 1.5,
      text: chars(`Drawing ${i} ${kind}: `, 40),
    };
  });
  return { ...base, axes, traces, annotations };
}

describe('BUDGET_VIEW', () => {
  it('encodes within the budget with no shrink step and reopens with all 10 drawings', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const view = budgetView();
    const q = serializeTraceQuery(view.traces, view.xAxis, plotConfigOf(view));
    expect(new TextEncoder().encode(q).length).toBeLessThanOrEqual(MAX_QUERY_BYTES);
    expect(warn).not.toHaveBeenCalled();

    const back = opened(`?${q}`);
    expect(warn).not.toHaveBeenCalled();
    expect(back.annotations).toHaveLength(10);
    back.annotations!.forEach((a, i) => {
      const want = view.annotations[i];
      expect(a.kind).toBe(want.kind);
      expect(a.points).toEqual(want.points);
      expect(a.text).toBe(want.text);
      expect(a.color).toBe(want.color);
      expect(back.axes.findIndex((x) => x.id === a.axisId)).toBe(i % 3);
      expect(a.traceId === undefined ? -1 : back.traces.findIndex((t) => t.id === a.traceId)).toBe(
        i % 2 === 0 ? i % 8 : -1
      );
    });
    expect(back.axes.map((x) => [x.units, x.min, x.max, x.autoScale])).toEqual(
      view.axes.map((x) => [x.units, x.min, x.max, false])
    );
  });

  it('with 11 oversized drawings keeps exactly the first k, with one warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const view = budgetView();
    // 200 characters that cost six bytes each once percent-encoded.
    const annotations = Array.from({ length: 11 }, (_, i) => ({
      ...view.annotations[i % 10],
      id: `annotation-big-${i}`,
      text: `${i}`.padEnd(200, 'é'),
    }));
    const big = { ...view, annotations };
    const q = serializeTraceQuery(big.traces, big.xAxis, plotConfigOf(big));
    expect(new TextEncoder().encode(q).length).toBeLessThanOrEqual(MAX_QUERY_BYTES);
    expect(warn).toHaveBeenCalledTimes(1);
    const back = opened(`?${q}`);
    const k = back.annotations?.length ?? 0;
    expect(k).toBeGreaterThan(0);
    expect(k).toBeLessThan(11);
    expect(back.annotations!.map((a) => a.text)).toEqual(
      annotations.slice(0, k).map((a) => a.text)
    );
    expect(String(warn.mock.calls[0][0])).toContain(`kept ${k} of 11 drawings`);
    expect(warn).toHaveBeenCalledTimes(1);
    // The rest of the view survived: the shrink touched only the drawings.
    expect(back.axes.map((x) => x.units)).toEqual(['mm', 'mA', 'kV']);
    expect(back.traces.map((t) => t.color)).toEqual(view.traces.map((t) => t.color));
  });

  it('MAX_DRAWINGS + 5 small hlines encode, parse and decode to MAX_DRAWINGS, one warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const plot = opened('?pv=X:A&pv=X:B&range=-1h');
    const annotations = Array.from({ length: MAX_DRAWINGS + 5 }, (_, i) =>
      ann({
        id: `annotation-${i}`,
        kind: 'hline',
        points: [{ t: 0, v: i }],
        axisId: plot.axes[0].id,
        color: defaultAnnotationColor(i),
      })
    );
    const view = { ...plot, annotations };
    const q = serializeTraceQuery(view.traces, view.xAxis, plotConfigOf(view));
    expect(new TextEncoder().encode(q).length).toBeLessThanOrEqual(MAX_QUERY_BYTES);
    const back = opened(`?${q}`);
    expect(back.annotations).toHaveLength(MAX_DRAWINGS);
    expect(back.annotations!.map((a) => a.points[0].v)).toEqual(
      Array.from({ length: MAX_DRAWINGS }, (_, i) => i)
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(`kept ${MAX_DRAWINGS} of ${MAX_DRAWINGS + 5}`);
  });
});

// ── The catalog and the x-axis descriptor ──────────────

describe('codec: catalog and x axis', () => {
  it('keeps x = 1.234567891 exactly on a value axis', () => {
    const a = ann({ kind: 'note', points: [{ t: 1.234567891, v: 2.5 }], text: 'peak' });
    const tuples = encodeDrawings({ annotations: [a], axes: AXES }, TRACES, {
      catalog: CORRELATION_CATALOG,
    });
    const back = decodeDrawings(JSON.parse(JSON.stringify(tuples)), { axes: AXES }, TRACES, {
      catalog: CORRELATION_CATALOG,
      xAxis: VALUE_X_AXIS,
    });
    expect(back[0].points).toEqual([{ t: 1.234567891, v: 2.5 }]);
  });

  it('still rounds x to whole milliseconds on a time axis', () => {
    const [a] = decode([[code('vline'), [1.6], 0, null]]);
    expect(a.points[0].t).toBe(2);
  });

  it('drops an unknown code, keeping the rest, with one warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const back = decode([
      [code('hline'), [1], 0, null],
      [42, [1], 0, null],
    ]);
    expect(back.map((a) => a.kind)).toEqual(['hline']);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('drops a code absent from the passed catalog (a Correlation catalog rejects trange)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const raw = [
      [code('trange'), [1, 2], 0, null],
      [code('vline'), [3], 0, null],
    ];
    expect(decode(raw).map((a) => a.kind)).toEqual(['trange', 'vline']);
    const back = decodeDrawings(raw, { axes: AXES }, TRACES, {
      catalog: CORRELATION_CATALOG,
      xAxis: TIME_X_AXIS,
    });
    expect(back.map((a) => a.kind)).toEqual(['vline']);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('encodeJsonParam', () => {
  it('percent-encodes JSON but leaves its structure characters readable', () => {
    expect(encodeJsonParam({ a: [1, 'x y&z'], b: { c: ':' } })).toBe(
      '{%22a%22:[1,%22x%20y%26z%22],%22b%22:{%22c%22:%22:%22}}'
    );
  });
});
