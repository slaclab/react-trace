import { describe, expect, it } from 'vitest';
import { binCount, histogram, MAX_BINS, MIN_BINS } from './histogram';

describe('histogram', () => {
  it('is null without a finite value', () => {
    expect(histogram([])).toBeNull();
    expect(histogram([NaN, null, Infinity])).toBeNull();
  });

  it('a constant row is one unit-width bin of density 1', () => {
    const h = histogram([3, 3, 3, NaN])!;
    expect(Array.from(h.edges)).toEqual([2.5, 3.5]);
    expect(Array.from(h.density)).toEqual([1]);
    expect(h.n).toBe(3);
    expect(h.mean).toBe(3);
    expect(h.std).toBe(0);
  });

  it('a single value has no std', () => {
    expect(histogram([7])!.std).toBeNaN();
  });

  it('integrates to one and counts every finite value', () => {
    const values = Array.from({ length: 500 }, (_, i) => Math.sin(i / 7) * 3 + (i % 11) / 10);
    const h = histogram([...values, NaN, null])!;
    expect(h.n).toBe(500);
    let area = 0;
    for (let b = 0; b < h.density.length; b++) area += h.density[b] * (h.edges[b + 1] - h.edges[b]);
    expect(area).toBeCloseTo(1, 9);
    expect(h.edges[0]).toBe(Math.min(...values));
    expect(h.edges[h.edges.length - 1]).toBe(Math.max(...values));
    expect(h.density.length).toBeGreaterThanOrEqual(MIN_BINS);
    expect(h.density.length).toBeLessThanOrEqual(MAX_BINS);
  });

  it('puts the maximum in the last bin', () => {
    const h = histogram([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])!;
    expect(h.density[h.density.length - 1]).toBeGreaterThan(0);
  });

  it('mean and std are the sample statistics', () => {
    const h = histogram([2, 4, 4, 4, 5, 5, 7, 9])!;
    expect(h.mean).toBe(5);
    expect(h.std).toBeCloseTo(Math.sqrt(32 / 7), 12);
  });

  describe('binCount', () => {
    it('clamps Freedman–Diaconis into 8…64', () => {
      const wide = Float64Array.from({ length: 10 }, (_, i) => i);
      expect(binCount(wide, 9)).toBe(MIN_BINS);
      // A narrow core with one far outlier asks for ~1000 bins: clamped to 64.
      const tailed = Float64Array.from([...Array.from({ length: 1000 }, (_, i) => i / 1000), 100]);
      expect(binCount(tailed, 100)).toBe(MAX_BINS);
    });

    it('uses √n bins when the IQR is zero', () => {
      const spike = Float64Array.from([0, ...new Array(98).fill(5), 10]);
      expect(binCount(spike, 10)).toBe(Math.min(MAX_BINS, Math.max(MIN_BINS, Math.ceil(10))));
    });

    it('is one bin below two values or without a range', () => {
      expect(binCount(Float64Array.of(1), 0)).toBe(1);
      expect(binCount(Float64Array.of(1, 2), 0)).toBe(1);
    });
  });
});
