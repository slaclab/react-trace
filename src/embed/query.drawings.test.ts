// The first shrink step of serializeTraceQuery: drawings are capped at
// MAX_DRAWINGS, then trailing drawings are dropped one at a time until the
// query fits, with one "kept k of n drawings" warning. When not even one
// drawing fits, the older steps (axes only, no config, trailing PVs) run as
// before.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_DRAWINGS, type DrawingTuple } from '../annotations/config';
import type { PlotConfig } from './plotConfig';
import { MAX_QUERY_BYTES, parseTraceQuery, serializeTraceQuery } from './query';
import { BUILTIN_CATALOG } from '../annotations/catalog';

/** A built-in tool's wire code. */
const code = (kind: string): number => BUILTIN_CATALOG.byKind(kind)!.code;

const PVS = ['X:A', 'X:B'];
const RANGE = { timeRange: '-1h' };

const bytes = (s: string) => new TextEncoder().encode(s).length;

function silenceWarn() {
  return vi.spyOn(console, 'warn').mockImplementation(() => {});
}

/** A note whose text costs about `size` bytes once percent-encoded. */
function bigNote(i: number, size = 150): DrawingTuple {
  // 'é' is two UTF-8 bytes, six once percent-encoded.
  return [code('note'), [1_000 + i, i], 0, null, '', `${i}`.padEnd(Math.floor(size / 6), 'é')];
}

function hline(i: number): DrawingTuple {
  return [code('hline'), [i], 0, null];
}

function config(drawings: DrawingTuple[], extra: Partial<PlotConfig> = {}): PlotConfig {
  return { v: 1, axes: [{ name: 'Volts' }], drawings, ...extra };
}

const drawingsOf = (q: string) => parseTraceQuery(q).plot?.drawings ?? [];

afterEach(() => {
  vi.restoreAllMocks();
});

describe('serializeTraceQuery: drawings', () => {
  it('writes every drawing, without a warning, when the query fits', () => {
    const warn = silenceWarn();
    const list = [hline(1), bigNote(2), hline(3)];
    const q = serializeTraceQuery(PVS, RANGE, config(list));
    expect(drawingsOf(q)).toEqual(list);
    expect(warn).not.toHaveBeenCalled();
  });

  it('drops trailing drawings until the query fits, maximally, with one warning', () => {
    const warn = silenceWarn();
    const list = Array.from({ length: 40 }, (_, i) => bigNote(i));
    const q = serializeTraceQuery(PVS, RANGE, config(list));
    expect(bytes(q)).toBeLessThanOrEqual(MAX_QUERY_BYTES);
    const kept = drawingsOf(q);
    const k = kept.length;
    expect(k).toBeGreaterThan(0);
    expect(k).toBeLessThan(40);
    expect(kept).toEqual(list.slice(0, k));
    // The rest of the config is untouched.
    expect(parseTraceQuery(q).plot?.axes).toEqual([{ name: 'Volts' }]);
    expect(parseTraceQuery(q).pvs).toEqual(PVS);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(`kept ${k} of 40 drawings`);
    // Maximal: with one more drawing it would not have fit.
    warn.mockClear();
    const again = serializeTraceQuery(PVS, RANGE, config(list.slice(0, k + 1)));
    expect(drawingsOf(again)).toHaveLength(k);
    expect(String(warn.mock.calls[0][0])).toContain(`kept ${k} of ${k + 1} drawings`);
  });

  it('caps the drawings at MAX_DRAWINGS with one warning even when they would fit', () => {
    const warn = silenceWarn();
    const list = Array.from({ length: MAX_DRAWINGS + 5 }, (_, i) => hline(i));
    const q = serializeTraceQuery(PVS, RANGE, config(list));
    expect(bytes(q)).toBeLessThanOrEqual(MAX_QUERY_BYTES);
    expect(drawingsOf(q)).toEqual(list.slice(0, MAX_DRAWINGS));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(
      `kept ${MAX_DRAWINGS} of ${MAX_DRAWINGS + 5} drawings`
    );
  });

  it('caps and then shrinks with a single warning', () => {
    const warn = silenceWarn();
    const list = Array.from({ length: MAX_DRAWINGS + 1 }, (_, i) => bigNote(i));
    const q = serializeTraceQuery(PVS, RANGE, config(list));
    const k = drawingsOf(q).length;
    expect(k).toBeGreaterThan(0);
    expect(k).toBeLessThan(MAX_DRAWINGS);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(`kept ${k} of ${MAX_DRAWINGS + 1} drawings`);
  });

  it('falls through to the axes-only step when not even one drawing fits', () => {
    const warn = silenceWarn();
    // A title so long that the config only fits as its axes.
    const extra = { title: 'T'.repeat(MAX_QUERY_BYTES) };
    const q = serializeTraceQuery(PVS, RANGE, config([hline(1), hline(2)], extra));
    const plot = parseTraceQuery(q).plot;
    expect(plot?.drawings).toBeUndefined();
    expect(plot?.title).toBeUndefined();
    expect(plot?.axes).toEqual([{ name: 'Volts' }]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('kept only the axes');
    expect(String(warn.mock.calls[0][0])).not.toContain('drawings');
  });

  it('leaves the PV steps as they were when there are no drawings', () => {
    const warn = silenceWarn();
    const long = Array.from({ length: 200 }, (_, i) => `TEST:BPM:${i}:POSITION:X`);
    const q = serializeTraceQuery(long, RANGE);
    expect(bytes(q)).toBeLessThanOrEqual(MAX_QUERY_BYTES);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('PVs');
  });
});
