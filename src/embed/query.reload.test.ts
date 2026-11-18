// A link the writer accepts always opens again. The writer budgets the query
// it writes; the page that reopens it reads it back through the browser's
// URL (which percent-encodes `'`), with the page keys in front, and through
// `plotQuery` (which re-encodes `:,[]{}`). None of that may push a query the
// writer kept under 4 KB over the reader's limit: the plot must reopen with
// every PV, the range and every drawing the writer kept.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN_CATALOG } from '../annotations/catalog';
import type { DrawingTuple } from '../annotations/config';
import { buildInitialPlots } from './initialPlots';
import { siblingToolUrl } from './openTool';
import type { PlotConfig } from './plotConfig';
import { MAX_QUERY_BYTES, parseTraceQuery, serializeTraceQuery } from './query';

const NOTE = BUILTIN_CATALOG.byKind('note')!.code;
const PVS = ['TEST:ALARM', 'TEST:SINE:A'];
const RANGE = { timeRange: 'custom', timeFrom: '2026-11-18T12:50', timeTo: '2026-11-18T13:00' };

const bytes = (s: string) => new TextEncoder().encode(s).length;

/** A note whose text has the characters the URL parser and `plotQuery` re-encode. */
function note(i: number, size: number): DrawingTuple {
  const text = `it's #${i}: [a, b] {c}`.padEnd(size, 'x');
  return [NOTE, [1_800_000_000_000 + i * 1000, i], 0, null, '', text];
}

function config(drawings: DrawingTuple[]): PlotConfig {
  return { v: 1, axes: [{ name: 'Volts' }], drawings };
}

/** What the embedded tile's URL holds after a state write: the page keys, then the query. */
function tileSearch(query: string): string {
  return new URL(`http://localhost/?embedded=true&theme=dark&hostbar=1&${query}`).search;
}

/** What "Copy link to this view" opens. */
function copiedSearch(query: string): string {
  return new URL(siblingToolUrl('trace', query, 'http://localhost/index.html')).search;
}

function reopen(search: string) {
  const [plot] = buildInitialPlots(search);
  return {
    pvs: plot.traces.map((t) => t.pvName),
    xAxis: plot.xAxis,
    drawings: plot.annotations?.length ?? 0,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a link the writer accepts reopens whole', () => {
  it('at the edge of the budget, with page keys in front, through the tile and a copied link', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Fourteen notes, and a PV name grown a byte at a time until the
    // writer's query is exactly at the limit with every note kept.
    const list = Array.from({ length: 14 }, (_, i) => note(i, 180));
    let edge: { q: string; pvs: string[] } | null = null;
    for (let k = 0; k < 1000 && edge === null; k++) {
      const pvs = [...PVS, `TEST:${'X'.repeat(k)}`];
      const q = serializeTraceQuery(pvs, RANGE, config(list));
      if (bytes(q) === MAX_QUERY_BYTES && parseTraceQuery(q).plot?.drawings?.length === 14) {
        edge = { q, pvs };
      }
    }
    expect(edge).not.toBeNull();
    for (const search of [tileSearch(edge!.q), copiedSearch(edge!.q)]) {
      expect(reopen(search)).toEqual({ pvs: edge!.pvs, xAxis: RANGE, drawings: 14 });
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it('when the writer trims the drawings to fit ("kept k of n")', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const list = Array.from({ length: 23 }, (_, i) => note(i, 180));
    const q = serializeTraceQuery(PVS, RANGE, config(list));
    expect(bytes(q)).toBeLessThanOrEqual(MAX_QUERY_BYTES);
    const kept = parseTraceQuery(q).plot?.drawings?.length ?? 0;
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(23);
    warn.mockClear();
    for (const search of [tileSearch(q), copiedSearch(q)]) {
      expect(reopen(search)).toEqual({ pvs: PVS, xAxis: RANGE, drawings: kept });
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it('at every size the writer produces near the limit', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (let n = 1; n <= 40; n++) {
      const list = Array.from({ length: n }, (_, i) => note(i, 60 + ((i * 37) % 120)));
      const q = serializeTraceQuery(PVS, RANGE, config(list));
      const kept = parseTraceQuery(q).plot?.drawings?.length ?? 0;
      expect(reopen(tileSearch(q)), `${n} notes`).toEqual({
        pvs: PVS,
        xAxis: RANGE,
        drawings: kept,
      });
    }
  });
});

describe('a query over the limit on arrival', () => {
  it('opens its PVs, range and the rest of its config without the drawings when that fits', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const list = Array.from({ length: 40 }, (_, i) => note(i, 180));
    // Hand-made: the writer would never write this much.
    const plot = encodeURIComponent(JSON.stringify(config(list)));
    const q = `pv=${PVS[0]}&pv=${PVS[1]}&range=-4h&plot=${plot}`;
    expect(bytes(q)).toBeGreaterThan(MAX_QUERY_BYTES);
    const parsed = parseTraceQuery(q);
    expect(parsed.pvs).toEqual(PVS);
    expect(parsed.xAxis).toEqual({ timeRange: '-4h' });
    expect(parsed.plot?.axes).toEqual([{ name: 'Volts' }]);
    expect(parsed.plot?.drawings).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('without its drawings');
  });

  it('opens its PVs and range without the plot config when only that fits', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const plot = encodeURIComponent(JSON.stringify({ v: 1, title: 'T'.repeat(5000) }));
    const q = `pv=${PVS[0]}&range=-4h&plot=${plot}`;
    expect(parseTraceQuery(q)).toEqual({ pvs: [PVS[0]], xAxis: { timeRange: '-4h' } });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('without its plot config');
  });
});
