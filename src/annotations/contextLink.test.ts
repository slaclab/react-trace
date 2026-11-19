// Pins the shared `ann=` codec of the Correlation and Waveform links: the `{r, b, d}` reference table round trip, the context
// slot rules (an out-of-range trace index clears the magnet and keeps the
// drawing; an out-of-range axis or binding index drops it), the catalog
// gate, the note trim, and the drop-from-end step under a page-key reserve.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultAnnotationColor } from '../annotationTheme';
import { BUILTIN_CATALOG, CORRELATION_CATALOG } from './catalog';
import { VALUE_X_AXIS } from './catalog/xAxis';
import { encodeJsonParam, MAX_DRAWINGS } from './config';
import {
  CONTEXT_LINK_MAX_BYTES,
  type ContextLinkValue,
  decodeContextDrawings,
  encodeContextDrawings,
  fitContextDrawings,
  NOTE_TRIM_POINTS,
  trimNoteTexts,
} from './contextLink';
import type { Annotation } from './model';

/** A built-in tool's wire code. */
const code = (kind: string): number => BUILTIN_CATALOG.byKind(kind)!.code;

const bytes = (s: string) => new TextEncoder().encode(s).length;

function ann(i: number, extra: Partial<Annotation> = {}): Annotation {
  return {
    id: `annotation-${i}`,
    kind: 'hline',
    points: [{ t: 0, v: i + 0.5 }],
    axisId: 'TEST:Y1',
    color: defaultAnnotationColor(i),
    width: 0.75,
    text: '',
    ...extra,
  };
}

/** An annotation without its (regenerated) id. */
const noId = ({ id: _id, ...rest }: Annotation) => (void _id, rest);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('encodeContextDrawings / decodeContextDrawings', () => {
  it('round-trips through the reference and binding tables', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const list: Annotation[] = [
      ann(0, { traceId: 'TEST:Y1', text: 'floor' }),
      ann(1, {
        kind: 'trend',
        points: [
          { t: 1.234567891, v: 1 },
          { t: 2.5, v: -3 },
        ],
        axisId: 'TEST:Y2',
        extend: 'both',
        xRef: 'TEST:X',
      }),
      ann(2, {
        kind: 'note',
        points: [{ t: 7.25, v: 3 }],
        axisId: 'TEST:Y1',
        traceId: 'TEST:Y2',
        text: 'hello',
        xRef: 'TEST:X',
        delta: true,
        locked: true,
      }),
      ann(3, { kind: 'vline', points: [{ t: 4.5, v: 0 }], xRef: 'TEST:X' }),
    ];
    const { value, dropped } = encodeContextDrawings(list, CORRELATION_CATALOG);
    expect(dropped).toBe(0);
    expect(value!.r).toEqual(['TEST:Y1', 'TEST:Y2']);
    expect(value!.b).toEqual([{ x: 'TEST:X' }, { x: 'TEST:X', d: 1 }]);
    expect(value!.d[0]).toEqual([code('hline'), [0.5], 0, 0, '', 'floor']);
    expect(value!.d[1]).toEqual([
      code('trend'),
      [1.234567891, 1, 2.5, -3],
      1,
      null,
      '',
      '',
      'b',
      0,
    ]);
    expect(value!.d[2]).toEqual([code('note'), [7.25, 3], 0, 1, '', 'hello', 'l', 1]);
    expect(value!.d[3]).toEqual([code('vline'), [4.5], 0, null, '', '', '', 0]);

    const back = decodeContextDrawings(JSON.parse(JSON.stringify(value)), CORRELATION_CATALOG, {
      xAxis: VALUE_X_AXIS,
    });
    expect(back.map(noId)).toEqual(list.map(noId));
    expect(warn).not.toHaveBeenCalled();
  });

  it('is undefined with no drawings', () => {
    expect(encodeContextDrawings([], CORRELATION_CATALOG)).toEqual({
      value: undefined,
      dropped: 0,
    });
  });

  it('maps references through injected resolvers', () => {
    const list = [ann(0, { axisId: 'y', traceId: 'curve-1' })];
    const { value } = encodeContextDrawings(list, CORRELATION_CATALOG, {
      traceRef: (a) => (a.traceId === 'curve-1' ? 'WF:PV' : null),
    });
    expect(value!.r).toEqual(['y', 'WF:PV']);
    const [back] = decodeContextDrawings(value, CORRELATION_CATALOG, {
      traceId: (ref) => (ref === 'WF:PV' ? 'curve-1' : null),
    });
    expect(back.traceId).toBe('curve-1');
    expect(back.axisId).toBe('y');
  });

  it('accepts the link value as a JSON string', () => {
    const { value } = encodeContextDrawings([ann(0)], CORRELATION_CATALOG);
    const back = decodeContextDrawings(JSON.stringify(value), CORRELATION_CATALOG);
    expect(back.map(noId)).toEqual([noId(ann(0))]);
  });

  it('clears the magnet and keeps the drawing on an out-of-range trace index', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const raw: ContextLinkValue = { r: ['TEST:Y1'], b: [], d: [[code('hline'), [2], 0, 5]] };
    const back = decodeContextDrawings(raw, CORRELATION_CATALOG);
    expect(back).toHaveLength(1);
    expect(back[0].axisId).toBe('TEST:Y1');
    expect(back[0].traceId).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('drops a drawing whose axis or binding index is out of range, with one counted warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const raw: ContextLinkValue = {
      r: ['TEST:Y1'],
      b: [{ x: 'TEST:X' }],
      d: [
        [code('hline'), [1], 3, null],
        [code('hline'), [2], 0, null, '', '', '', 4],
        [code('hline'), [3], 0, null, '', '', '', 0],
      ],
    };
    const back = decodeContextDrawings(raw, CORRELATION_CATALOG);
    expect(back.map((a) => a.points[0].v)).toEqual([3]);
    expect(back[0].axisId).toBe('TEST:Y1');
    expect(back[0].xRef).toBe('TEST:X');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('dropped 2');
  });

  it('drops an unknown code and a code absent from the catalog', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const raw: ContextLinkValue = {
      r: ['TEST:Y1'],
      b: [],
      d: [
        [code('trange'), [1, 2], 0, null],
        [77, [1], 0, null],
        [code('vline'), [3], 0, null],
      ],
    };
    expect(decodeContextDrawings(raw, BUILTIN_CATALOG).map((a) => a.kind)).toEqual([
      'trange',
      'vline',
    ]);
    expect(decodeContextDrawings(raw, CORRELATION_CATALOG).map((a) => a.kind)).toEqual(['vline']);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('does not encode a drawing whose kind the catalog lacks, nor one the host omits', () => {
    const list = [
      ann(0, {
        kind: 'trange',
        points: [
          { t: 1, v: 0 },
          { t: 2, v: 0 },
        ],
      }),
      ann(1),
      ann(2, { delta: true }),
    ];
    const { value, dropped } = encodeContextDrawings(list, CORRELATION_CATALOG, {
      omit: (a) => a.delta === true,
    });
    expect(value!.d).toHaveLength(1);
    expect(dropped).toBe(2);
  });

  it('returns no drawings for an unusable value', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(decodeContextDrawings('{nope', CORRELATION_CATALOG)).toEqual([]);
    expect(decodeContextDrawings({ r: 'x', d: [] }, CORRELATION_CATALOG)).toEqual([]);
    expect(decodeContextDrawings(null, CORRELATION_CATALOG)).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1); // the unreadable JSON
  });

  it('keeps the first MAX_DRAWINGS and counts the rest as dropped', () => {
    const list = Array.from({ length: MAX_DRAWINGS + 3 }, (_, i) => ann(i));
    const { value, dropped } = encodeContextDrawings(list, CORRELATION_CATALOG);
    expect(value!.d).toHaveLength(MAX_DRAWINGS);
    expect(dropped).toBe(3);
  });
});

describe('trimNoteTexts', () => {
  const note = (i: number, text: string) =>
    ann(i, { kind: 'note', points: [{ t: 1, v: 1 }], text });

  it('cuts a note to its first 24 code points plus an ellipsis, unchanged at 25 or fewer', () => {
    const long = '\u{1F600}'.repeat(3) + 'x'.repeat(27); // 30 code points, 3 astral
    const exact = 'y'.repeat(25);
    const label = ann(2, { text: 'z'.repeat(40) }); // an hline label is not inline text
    const list = [note(0, long), note(1, exact), label];
    const { list: out, trimmed } = trimNoteTexts(list, CORRELATION_CATALOG, 'cut');
    expect(NOTE_TRIM_POINTS).toBe(24);
    expect(out[0].text).toBe('\u{1F600}'.repeat(3) + 'x'.repeat(21) + '…');
    expect([...out[0].text]).toHaveLength(25);
    expect(out[1]).toBe(list[1]);
    expect(out[2]).toBe(label);
    expect(trimmed).toBe(1);
    expect(list[0].text).toBe(long); // state untouched
  });

  it('empties every inline text in the second pass', () => {
    const list = [note(0, 'abc'), note(1, ''), ann(2, { text: 'label' })];
    const { list: out, trimmed } = trimNoteTexts(list, CORRELATION_CATALOG, 'empty');
    expect(out.map((a) => a.text)).toEqual(['', '', 'label']);
    expect(trimmed).toBe(1);
  });
});

describe('fitContextDrawings', () => {
  const base = 'y=TEST:Y1&m=1';
  const queryWith = (annValue: string | undefined) =>
    annValue === undefined ? base : `${base}&ann=${annValue}`;

  it('leaves a link that fits untouched', () => {
    const list = [ann(0, { text: 'a label' })];
    const fit = fitContextDrawings(list, CORRELATION_CATALOG, { queryWith, reserve: 20 });
    expect(fit.shed).toEqual({ dropped: 0, trimmed: 0 });
    expect(fit.ann).toBe(encodeJsonParam(encodeContextDrawings(list, CORRELATION_CATALOG).value));
    expect(fit.query).toBe(queryWith(fit.ann));
  });

  it('trims notes before dropping any drawing: three long notes are all kept', () => {
    const list = [0, 1, 2].map((i) =>
      ann(i, { kind: 'note', points: [{ t: i, v: 1 }], text: 'n'.repeat(200) })
    );
    // Room for the trimmed notes, not for the full ones.
    const trimmedAnn = encodeJsonParam(
      encodeContextDrawings(
        trimNoteTexts(list, CORRELATION_CATALOG, 'cut').list,
        CORRELATION_CATALOG
      ).value
    );
    const maxBytes = bytes(queryWith(trimmedAnn)) + 10;
    const fit = fitContextDrawings(list, CORRELATION_CATALOG, { queryWith, reserve: 10, maxBytes });
    expect(fit.shed).toEqual({ dropped: 0, trimmed: 3 });
    const back = decodeContextDrawings(decodeURIComponent(fit.ann!), CORRELATION_CATALOG);
    expect(back.map((a) => a.text)).toEqual([
      'n'.repeat(24) + '…',
      'n'.repeat(24) + '…',
      'n'.repeat(24) + '…',
    ]);
    expect(list[0].text).toHaveLength(200);
  });

  it('drops drawings from the end until the query plus the page-key reserve fits', () => {
    const list = Array.from({ length: MAX_DRAWINGS }, (_, i) =>
      ann(i, { text: `label number ${i} `.repeat(4), axisId: `TEST:Y${i % 3}` })
    );
    const reserve = bytes('&theme=dark&embedded=1');
    const fit = fitContextDrawings(list, CORRELATION_CATALOG, { queryWith, reserve });
    expect(fit.shed.dropped).toBeGreaterThan(0);
    expect(fit.shed.trimmed).toBe(0);
    expect(bytes(fit.query) + reserve).toBeLessThanOrEqual(CONTEXT_LINK_MAX_BYTES);
    const kept = MAX_DRAWINGS - fit.shed.dropped;
    // One more drawing would not have fit with the reserve.
    const oneMore = encodeJsonParam(
      encodeContextDrawings(list.slice(0, kept + 1), CORRELATION_CATALOG).value
    );
    expect(bytes(queryWith(oneMore)) + reserve).toBeGreaterThan(CONTEXT_LINK_MAX_BYTES);
    // The reserve is what made the difference for at least one drawing.
    const free = fitContextDrawings(list, CORRELATION_CATALOG, { queryWith, reserve: 0 });
    expect(free.shed.dropped).toBeLessThanOrEqual(fit.shed.dropped);
    const back = decodeContextDrawings(decodeURIComponent(fit.ann!), CORRELATION_CATALOG);
    expect(back.map(noId)).toEqual(list.slice(0, kept).map(noId));
  });

  it('drops every drawing when even one does not fit', () => {
    const list = [ann(0, { text: 'x'.repeat(100) })];
    const fit = fitContextDrawings(list, CORRELATION_CATALOG, {
      queryWith,
      reserve: 0,
      maxBytes: bytes(base) + 5,
    });
    expect(fit.ann).toBeUndefined();
    expect(fit.query).toBe(base);
    expect(fit.shed).toEqual({ dropped: 1, trimmed: 0 });
  });
});
