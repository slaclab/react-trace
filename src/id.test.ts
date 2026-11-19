import { describe, it, expect } from 'vitest';
import { makeId } from './id';

describe('makeId', () => {
  it('prefixes the id with the kind', () => {
    expect(makeId('plot')).toMatch(/^plot-/);
    expect(makeId('trace')).toMatch(/^trace-/);
    expect(makeId('axis')).toMatch(/^axis-/);
    expect(makeId('formula')).toMatch(/^formula-/);
    expect(makeId('annotation')).toMatch(/^annotation-/);
  });

  it('never collides, even for many ids created in the same millisecond', () => {
    // The whole point of the counter: Date.now() alone would repeat here.
    const ids = Array.from({ length: 1000 }, () => makeId('axis'));
    expect(new Set(ids).size).toBe(ids.length);
  });
});
