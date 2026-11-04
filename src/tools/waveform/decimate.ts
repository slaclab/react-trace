// Decimation of the Waveform chart's columns, for drawing only: Δ,
// decimation and the index column write into reusable buffers when the caller
// keeps one, so a publish does not allocate per curve.

/** Reusable Float64Arrays by key, reallocated only when the length changes. */
export class WaveformPlotBuffers {
  private arrays = new Map<string, Float64Array>();
  private indexFrom = new Map<string, number>();

  get(key: string, n: number): Float64Array {
    const have = this.arrays.get(key);
    if (have && have.length === n) return have;
    const fresh = new Float64Array(n);
    this.arrays.set(key, fresh);
    this.indexFrom.delete(key);
    return fresh;
  }

  /** Element numbers start..start+n−1, rewritten only when they change. */
  index(key: string, start: number, n: number): Float64Array {
    const out = this.get(key, n);
    if (this.indexFrom.get(key) !== start) {
      for (let i = 0; i < n; i++) out[i] = start + i;
      this.indexFrom.set(key, start);
    }
    return out;
  }
}

export function freshIndex(start: number, n: number): Float64Array {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = start + i;
  return out;
}

/**
 * Bucket `y` (and its x positions `x`) into `buckets` buckets of elements;
 * each writes two points: its minimum and maximum in element order, at the
 * bucket's first and last x. A bucket holding a non-finite element writes its
 * second point as NaN. `outY` (and `outX`, when given) hold 2 × buckets.
 * Elements of `y` past its length (shorter than `x`) count as NaN.
 */
export function decimateInto(
  y: Float64Array,
  x: Float64Array,
  buckets: number,
  outY: Float64Array,
  outX?: Float64Array | null
): void {
  const n = x.length;
  for (let b = 0; b < buckets; b++) {
    const from = Math.floor((b * n) / buckets);
    const to = Math.max(from + 1, Math.floor(((b + 1) * n) / buckets));
    let min = Infinity;
    let max = -Infinity;
    let iMin = -1;
    let iMax = -1;
    let dead = false;
    for (let i = from; i < to; i++) {
      const v = i < y.length ? y[i] : NaN;
      if (!Number.isFinite(v)) {
        dead = true;
        continue;
      }
      if (v < min) {
        min = v;
        iMin = i;
      }
      if (v > max) {
        max = v;
        iMax = i;
      }
    }
    let first = NaN;
    let second = NaN;
    if (iMin >= 0) {
      first = iMin <= iMax ? min : max;
      second = iMin <= iMax ? max : min;
    }
    outY[2 * b] = first;
    outY[2 * b + 1] = dead ? NaN : second;
    if (outX) {
      outX[2 * b] = x[from];
      outX[2 * b + 1] = x[to - 1];
    }
  }
}

export function hasNaN(a: Float64Array): boolean {
  for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) return true;
  return false;
}

export function decimateXInto(x: Float64Array, buckets: number, outX: Float64Array): void {
  const n = x.length;
  for (let b = 0; b < buckets; b++) {
    const from = Math.floor((b * n) / buckets);
    const to = Math.max(from + 1, Math.floor(((b + 1) * n) / buckets));
    outX[2 * b] = x[from];
    outX[2 * b + 1] = x[to - 1];
  }
}
