// The distribution view's numbers: a row's finite values as a
// probability density over equal-width bins, with the mean and the sample
// standard deviation as guides. Pure; the chart is Distribution.tsx.
//
// Bins: Freedman–Diaconis (width 2·IQR·n^-1/3) clamped to 8…64 bins over the
// value range; √n bins when the IQR is zero (a spike with tails); a constant
// row is one bin of unit width around its value. The density integrates to
// one, so rows of different sample counts compare on one scale.

import type { StatColumn } from './evaluate';

export const MIN_BINS = 8;
export const MAX_BINS = 64;

export interface Histogram {
  /** Bin edges, ascending, `density.length + 1` of them. */
  edges: Float64Array;
  /** Probability density per bin (count / (n · width)). */
  density: Float64Array;
  /** Finite values counted. */
  n: number;
  mean: number;
  /** Sample standard deviation (ddof = 1); NaN below two values. */
  std: number;
}

function finiteSorted(column: StatColumn): Float64Array {
  const out: number[] = [];
  for (let i = 0; i < column.length; i++) {
    const v = column[i];
    if (v !== null && v !== undefined && Number.isFinite(v)) out.push(v);
  }
  return Float64Array.from(out).sort();
}

/** Linear-interpolation percentile of ascending `sorted`, p in 0..100. */
function percentileSorted(sorted: Float64Array, p: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  const pos = ((n - 1) * p) / 100;
  const lo = Math.floor(pos);
  const hi = Math.min(n - 1, lo + 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** The bin count for `n` sorted values spanning `range`. */
export function binCount(sorted: Float64Array, range: number): number {
  const n = sorted.length;
  if (n < 2 || range <= 0) return 1;
  const iqr = percentileSorted(sorted, 75) - percentileSorted(sorted, 25);
  const width = 2 * iqr * Math.cbrt(1 / n);
  const raw = width > 0 ? Math.ceil(range / width) : Math.ceil(Math.sqrt(n));
  return Math.min(MAX_BINS, Math.max(MIN_BINS, raw));
}

/** The step-area points of a histogram: each bin's density at its left edge, closed at the last edge. */
export function densitySteps(h: Histogram): [number, number][] {
  const out: [number, number][] = [];
  for (let b = 0; b < h.density.length; b++) out.push([h.edges[b], h.density[b]]);
  out.push([h.edges[h.edges.length - 1], h.density[h.density.length - 1]]);
  return out;
}

/** The histogram of a column's finite values, or null without any. */
export function histogram(column: StatColumn): Histogram | null {
  const sorted = finiteSorted(column);
  const n = sorted.length;
  if (n === 0) return null;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += sorted[i];
  const mean = sum / n;
  let sq = 0;
  for (let i = 0; i < n; i++) sq += (sorted[i] - mean) ** 2;
  const std = n > 1 ? Math.sqrt(sq / (n - 1)) : NaN;

  const min = sorted[0];
  const max = sorted[n - 1];
  const range = max - min;
  if (range <= 0) {
    // One bin of unit width centred on the value: density 1.
    return {
      edges: Float64Array.of(min - 0.5, min + 0.5),
      density: Float64Array.of(1),
      n,
      mean,
      std,
    };
  }
  const bins = binCount(sorted, range);
  const width = range / bins;
  const edges = new Float64Array(bins + 1);
  for (let b = 0; b <= bins; b++) edges[b] = min + b * width;
  edges[bins] = max;
  const counts = new Float64Array(bins);
  for (let i = 0; i < n; i++) {
    const b = Math.min(bins - 1, Math.floor((sorted[i] - min) / width));
    counts[b]++;
  }
  const density = new Float64Array(bins);
  for (let b = 0; b < bins; b++) density[b] = counts[b] / (n * width);
  return { edges, density, n, mean, std };
}
