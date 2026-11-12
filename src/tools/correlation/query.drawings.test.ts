// The Correlation link's drawings: a link shed to fit leaves room
// for the page keys and reloads with the drawings it reported, a drawing keeps
// its Y PV after the Y leaves `y=`, notes over budget are trimmed before any
// drawing is dropped, and a tool of the catalog the parser is given (not just
// the built-ins) round-trips.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultAnnotationColor } from '../../annotationTheme';
import { BUILTIN_TOOLS, CORRELATION_CATALOG, makeCatalog } from '../../annotations/catalog';
import type { DrawingTool } from '../../annotations/catalog/types';
import { NOTE_TRIM_POINTS } from '../../annotations/contextLink';
import type { Annotation } from '../../annotations/model';
import {
  defaultCorrelationState,
  MAX_QUERY_BYTES,
  normalizeCorrelationState,
  parseCorrelationQuery,
  serializeCorrelationQuery,
  serializeCorrelationQueryWithShed,
  type CorrelationState,
} from './query';

const X = 'SIM:BPM01:X';
const Y1 = 'SIM:BPM02:X';
const Y2 = 'SIM:BPM03:X';
const PAGE_KEYS = 'embedded=true&theme=light&';

const bytes = (s: string) => new TextEncoder().encode(s).length;

function state(over: Partial<CorrelationState> = {}): CorrelationState {
  return normalizeCorrelationState({ ...defaultCorrelationState(), x: X, ys: [Y1, Y2], ...over });
}

function drawing(i: number, over: Partial<Annotation> = {}): Annotation {
  return {
    id: `annotation-${i}`,
    kind: 'hline',
    points: [{ t: 0, v: i + 0.25 }],
    axisId: Y1,
    color: defaultAnnotationColor(i),
    width: 1.5,
    text: '',
    ...over,
  };
}

/** A drawing without its (regenerated) id. */
const noId = ({ id: _id, ...rest }: Annotation) => (void _id, rest);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Correlation link drawings', () => {
  it('a link shed to fit, with the page keys added, reloads with its drawings', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // A query of ~3.6 KB before drawings: 64 drawings cannot all fit.
    const ys = Array.from({ length: 8 }, (_, i) => `PV:${'Z'.repeat(420)}:${i}`);
    const drawings = Array.from({ length: 64 }, (_, i) => drawing(i, { axisId: ys[i % 2] }));
    const s = state({ ys, drawings });
    const { query, shed } = serializeCorrelationQueryWithShed(s);
    expect(shed.dropped).toBeGreaterThan(0);
    expect(shed.dropped).toBeLessThan(drawings.length);

    const link = PAGE_KEYS + query;
    expect(bytes(link)).toBeLessThanOrEqual(MAX_QUERY_BYTES);
    warn.mockClear();
    const back = parseCorrelationQuery(`?${link}`);
    expect(warn).not.toHaveBeenCalled();
    expect(back.ys).toEqual(ys);
    expect(back.drawings.map(noId)).toEqual(
      drawings.slice(0, drawings.length - shed.dropped).map(noId)
    );
  });

  it('a drawing whose Y is no longer in y= decodes onto that PV', () => {
    const gone = 'SIM:BPM99:X';
    const s = state({
      drawings: [drawing(0, { axisId: gone, traceId: gone }), drawing(1, { axisId: Y2 })],
    });
    // The normalizer never prunes by Y.
    expect(s.drawings.map((a) => a.axisId)).toEqual([gone, Y2]);
    const back = parseCorrelationQuery(serializeCorrelationQuery(s));
    expect(back.ys).toEqual([Y1, Y2]);
    expect(back.drawings.map(noId)).toEqual(s.drawings.map(noId));
    expect(back.drawings[0]).toMatchObject({ axisId: gone, traceId: gone });
  });

  it('three notes over budget serialize trimmed, with all three drawings kept', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const notes = [0, 1, 2].map((i) =>
      drawing(i, { kind: 'note', points: [{ t: i, v: i }], text: `${i}`.repeat(180) })
    );
    // Pad the X so the full notes are over budget and the trimmed ones fit.
    const sized = (pad: number) => state({ x: `X:${'P'.repeat(pad)}`, drawings: notes });
    const over = bytes(serializeCorrelationQueryWithShed(sized(0)).query);
    const s = sized(MAX_QUERY_BYTES - over + 100);
    const { query, shed } = serializeCorrelationQueryWithShed(s);
    expect(shed).toEqual({ dropped: 0, trimmed: 3 });
    expect(bytes(PAGE_KEYS + query)).toBeLessThanOrEqual(MAX_QUERY_BYTES);

    const back = parseCorrelationQuery(query);
    expect(back.x).toBe(s.x);
    expect(back.drawings).toHaveLength(3);
    for (const [i, a] of back.drawings.entries()) {
      expect(a.text).toBe(`${i}`.repeat(NOTE_TRIM_POINTS) + '…');
    }
    // Only the link is trimmed: the state keeps the full text.
    expect(s.drawings.map((a) => a.text)).toEqual(notes.map((a) => a.text));
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("a test catalog's tool round-trips", () => {
    const hline = BUILTIN_TOOLS.find((t) => t.kind === 'hline')!;
    const LEVEL: DrawingTool = {
      ...hline,
      kind: 'level',
      code: 901,
      key: undefined,
      label: { long: 'Level', short: 'Level' },
    };
    const catalog = makeCatalog([...CORRELATION_CATALOG.tools, LEVEL]);
    const s = normalizeCorrelationState(
      {
        ...defaultCorrelationState(),
        x: X,
        ys: [Y1],
        drawings: [drawing(0, { kind: 'level', text: 'floor' }), drawing(1)],
      },
      catalog
    );
    expect(s.drawings.map((a) => a.kind)).toEqual(['level', 'hline']);

    const q = serializeCorrelationQuery(s, { catalog });
    const back = parseCorrelationQuery(q, { catalog });
    expect(back.drawings.map(noId)).toEqual(s.drawings.map(noId));
    expect(serializeCorrelationQuery(back, { catalog })).toBe(q);

    // Without that catalog the level is not one of the plot's tools.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseCorrelationQuery(q).drawings.map((a) => a.kind)).toEqual(['hline']);
    expect(warn).toHaveBeenCalled();
  });
});

describe('normalizeCorrelationState: drawings', () => {
  it('returns the same drawings array when no element changed', () => {
    const s = state({ drawings: [drawing(0), drawing(1)] });
    const again = normalizeCorrelationState({ ...s, n: 50 });
    expect(again.drawings).toBe(s.drawings);
    expect(again.labels).toBe(s.labels);
  });

  it('keeps each unchanged element and replaces only the invalid or changed ones', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = drawing(0);
    const b = { ...drawing(1), width: 7 } as unknown as Annotation;
    const c = drawing(2, { kind: 'nope' });
    const next = normalizeCorrelationState({ ...state(), drawings: [a, b, c] });
    expect(next.drawings).toHaveLength(2);
    expect(next.drawings[0]).toBe(a);
    expect(next.drawings[1]).not.toBe(b);
    expect(next.drawings[1].width).toBe(0.75);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('reads a state without drawings as none', () => {
    const { drawings: _d, ...rest } = state();
    void _d;
    expect(normalizeCorrelationState(rest as CorrelationState).drawings).toEqual([]);
  });
});
