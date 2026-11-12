import { describe, expect, it } from 'vitest';
import { MIN_POOL, RENDER_CAP, fuzzyMatch, matchChannels } from './fuzzy';

const values = (query: string, catalog: string[]) =>
  matchChannels(query, catalog).results.map((r) => r.value);

describe('fuzzyMatch', () => {
  it('an empty query matches with score 0 and no spans', () => {
    expect(fuzzyMatch('  ', 'SIM:BPM1:X')).toEqual({ score: 0, spans: [] });
  });

  it('every token must subsequence-match, case-insensitively', () => {
    expect(fuzzyMatch('bpm x', 'SIM:BPM1:X')).not.toBeNull();
    expect(fuzzyMatch('bpm q', 'SIM:BPM1:X')).toBeNull();
    expect(fuzzyMatch('xb', 'SIM:BPM1:X')).toBeNull();
  });

  it('scores base, boundary and consecutive bonuses and merges spans', () => {
    // "si" at 0,1: 1+10 (boundary) + 1+5 (consecutive) = 17.
    expect(fuzzyMatch('si', 'SIM:BPM1:X')).toEqual({ score: 17, spans: [[0, 2]] });
    // After '_' is a boundary; after ':' is not.
    expect(fuzzyMatch('b', 'a_b')?.score).toBe(11);
    expect(fuzzyMatch('b', 'a:b')?.score).toBe(1);
    // camelCase transition is a boundary.
    expect(fuzzyMatch('c', 'abCd')?.score).toBe(11);
  });
});

describe('matchChannels', () => {
  const catalog = ['SIM:BPM1:X', 'SIM:BPM1:Y', 'SIM:BPM2:X', 'SIM:MAG:QF1:CURRENT'];

  it('an empty query returns the catalog head in order with an honest total', () => {
    const big = Array.from({ length: RENDER_CAP + 5 }, (_, i) => `SIM:CH${i}`);
    const result = matchChannels(' ', big);
    expect(result.total).toBe(big.length);
    expect(result.results.map((r) => r.value)).toEqual(big.slice(0, RENDER_CAP));
  });

  it('below MIN_POOL substring hits, the pool widens to fuzzy matches', () => {
    // "simq" is no substring of anything but subsequence-matches the magnet.
    expect(values('simq', catalog)).toEqual(['SIM:MAG:QF1:CURRENT']);
  });

  it('ranks by score descending, ties by value ascending', () => {
    expect(values('bpm1', catalog)).toEqual(['SIM:BPM1:X', 'SIM:BPM1:Y']);
    expect(values('x', ['SIM:B:X', 'SIM:A:X'])).toEqual(['SIM:A:X', 'SIM:B:X']);
  });

  it('with MIN_POOL substring hits, only those are ranked', () => {
    const hits = Array.from({ length: MIN_POOL }, (_, i) => `SIM:QF${i}:I`);
    // A fuzzy-only match ("q...f") that is not a substring hit for "qf".
    const result = values('qf', [...hits, 'SIM:Q:F']);
    expect(result).toHaveLength(MIN_POOL);
    expect(result).not.toContain('SIM:Q:F');
  });

  it('caps results at RENDER_CAP and reports the full total', () => {
    const big = Array.from({ length: 120 }, (_, i) => `SIM:BPM${i}:X`);
    const result = matchChannels('bpm', big);
    expect(result.results).toHaveLength(50);
    expect(result.total).toBe(120);
  });
});
