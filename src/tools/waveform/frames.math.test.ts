import { describe, expect, it } from 'vitest';
import {
  CurveBuffers,
  FrameRing,
  averageFrames,
  deltaFrame,
  elementSpan,
  finiteLabel,
  frameStats,
  sameLength,
  toFrame,
} from './frames';

const f = (values: ArrayLike<unknown>) => toFrame(values);

describe('sameLength', () => {
  it('is true only for equal element counts', () => {
    expect(sameLength(f([1, 2]), f([3, 4]))).toBe(true);
    expect(sameLength(f([1, 2]), f([3]))).toBe(false);
    expect(sameLength(f([]), f([]))).toBe(true);
  });
});

describe('deltaFrame', () => {
  it('subtracts reference from live element-wise', () => {
    const out = deltaFrame(f([5, 7, 9]), f([1, 2, 3]));
    expect(Array.from(out!)).toEqual([4, 5, 6]);
  });

  it('is zero for a frame against itself', () => {
    const a = f([1.5, -2, 1e9, 0]);
    expect(Array.from(deltaFrame(a, a)!)).toEqual([0, 0, 0, 0]);
  });

  it('is NaN where live has a null element', () => {
    const out = deltaFrame(f([1, null, 3]), f([1, 1, 1]))!;
    expect(out[0]).toBe(0);
    expect(Number.isNaN(out[1])).toBe(true);
    expect(out[2]).toBe(2);
  });

  it('is NaN where the reference has a null element', () => {
    const out = deltaFrame(f([1, 2, 3]), f([null, 1, 1]))!;
    expect(Number.isNaN(out[0])).toBe(true);
    expect(out[1]).toBe(1);
    expect(out[2]).toBe(2);
  });

  it('refuses frames of different lengths', () => {
    expect(deltaFrame(f([1, 2, 3]), f([1, 2]))).toBeNull();
  });

  it('writes into the given buffer when it has the right length', () => {
    const buf = new Float64Array(3);
    const out = deltaFrame(f([2, 2, 2]), f([1, 1, 1]), buf);
    expect(out).toBe(buf);
    expect(Array.from(buf)).toEqual([1, 1, 1]);
  });
});

describe('averageFrames', () => {
  it('averages per element over the frames', () => {
    const out = averageFrames([f([1, 2]), f([3, 4]), f([5, 6])])!;
    expect(Array.from(out)).toEqual([3, 4]);
  });

  it('skips a null element in one frame and averages the finite samples', () => {
    const out = averageFrames([f([1, 10]), f([null, 20]), f([3, 30])])!;
    expect(out[0]).toBe(2);
    expect(out[1]).toBe(20);
  });

  it('is NaN for an element with no finite sample', () => {
    const out = averageFrames([f([null, 1]), f([NaN, 3])])!;
    expect(Number.isNaN(out[0])).toBe(true);
    expect(out[1]).toBe(2);
  });

  it('skips infinities as non-finite samples', () => {
    const out = averageFrames([f([Infinity, 1]), f([4, 3])])!;
    expect(out[0]).toBe(4);
  });

  it('is null for no frames or frames of mixed length', () => {
    expect(averageFrames([])).toBeNull();
    expect(averageFrames([f([1, 2]), f([1])])).toBeNull();
  });

  it('is recomputed from the frames, with no running sum carried across calls', () => {
    const buf = new Float64Array(1);
    averageFrames([f([100]), f([200])], buf);
    const out = averageFrames([f([1]), f([3])], buf)!;
    expect(out).toBe(buf);
    expect(out[0]).toBe(2);
  });

  it('averages the ring frames it is given', () => {
    const ring = new FrameRing(4, 0);
    ring.push([1, 1], 1);
    ring.push([2, null], 2);
    ring.push([3, 5], 3);
    const out = averageFrames(ring.last(3))!;
    expect(Array.from(out)).toEqual([2, 3]);
  });
});

describe('elementSpan', () => {
  it('covers every element with no range', () => {
    expect(elementSpan(10, null)).toEqual({ start: 0, end: 10 });
  });

  it('maps an inclusive range to a half-open span, clamped', () => {
    expect(elementSpan(10, { first: 2, last: 4 })).toEqual({ start: 2, end: 5 });
    expect(elementSpan(10, { first: 3 })).toEqual({ start: 3, end: 10 });
    expect(elementSpan(10, { last: 20 })).toEqual({ start: 0, end: 10 });
    expect(elementSpan(10, { first: 12 })).toEqual({ start: 10, end: 10 });
    expect(elementSpan(10, { first: 5, last: 2 })).toEqual({ start: 5, end: 5 });
  });
});

describe('frameStats', () => {
  it('computes mean, RMS and peak-to-peak', () => {
    const s = frameStats(f([1, -1, 3, -3]));
    expect(s.mean).toBe(0);
    expect(s.rms).toBeCloseTo(Math.sqrt(5));
    expect(s.p2p).toBe(6);
    expect(s.finite).toBe(4);
    expect(s.len).toBe(4);
    expect(finiteLabel(s)).toBeNull();
  });

  it('uses only finite elements and reports n finite / len when some are missing', () => {
    const s = frameStats(f([2, null, 4, NaN]));
    expect(s.mean).toBe(3);
    expect(s.rms).toBeCloseTo(Math.sqrt(10));
    expect(s.p2p).toBe(2);
    expect(s.finite).toBe(2);
    expect(s.len).toBe(4);
    expect(finiteLabel(s)).toBe('2 finite / 4');
  });

  it('applies over the element range only', () => {
    const s = frameStats(f([100, 1, 2, 3, -100]), { first: 1, last: 3 });
    expect(s.mean).toBe(2);
    expect(s.p2p).toBe(2);
    expect(s.len).toBe(3);
    expect(s.finite).toBe(3);
  });

  it('is NaN with zero finite when nothing in range is finite', () => {
    const s = frameStats(f([null, null]));
    expect(Number.isNaN(s.mean)).toBe(true);
    expect(Number.isNaN(s.rms)).toBe(true);
    expect(Number.isNaN(s.p2p)).toBe(true);
    expect(s.finite).toBe(0);
    expect(finiteLabel(s)).toBe('0 finite / 2');
  });

  it('writes into the given stats object', () => {
    const into = frameStats(f([1]));
    const again = frameStats(f([5, 7]), null, into);
    expect(again).toBe(into);
    expect(again.mean).toBe(6);
    expect(again.len).toBe(2);
  });
});

describe('CurveBuffers', () => {
  it('reuses its delta, average and stats storage across calls', () => {
    const b = new CurveBuffers();
    const d1 = b.delta(f([2, 3]), f([1, 1]))!;
    const d2 = b.delta(f([5, 5]), f([1, 2]))!;
    expect(d2).toBe(d1);
    expect(Array.from(d2)).toEqual([4, 3]);

    const a1 = b.average([f([1, 2]), f([3, 4])])!;
    const a2 = b.average([f([5, 6])])!;
    expect(a2).toBe(a1);
    expect(Array.from(a2)).toEqual([5, 6]);
    expect(a2).not.toBe(d2);

    const s1 = b.stats(f([1, 2]));
    const s2 = b.stats(f([3, 5]));
    expect(s2).toBe(s1);
    expect(s2.mean).toBe(4);
  });

  it('reallocates only when the frame length changes', () => {
    const b = new CurveBuffers();
    const d1 = b.delta(f([1, 2]), f([0, 0]))!;
    const d2 = b.delta(f([1, 2, 3]), f([0, 0, 0]))!;
    expect(d2).not.toBe(d1);
    expect(d2.length).toBe(3);
    expect(b.delta(f([4, 4, 4]), f([1, 1, 1]))).toBe(d2);
  });

  it('refuses a length-mismatched delta without touching the buffer', () => {
    const b = new CurveBuffers();
    const d1 = b.delta(f([2, 2]), f([1, 1]))!;
    expect(b.delta(f([1, 2, 3]), f([1, 1]))).toBeNull();
    expect(Array.from(d1)).toEqual([1, 1]);
  });

  it('does not alias the input frames', () => {
    const b = new CurveBuffers();
    const live = f([1, 2]);
    const out = b.average([live])!;
    expect(out).not.toBe(live);
  });
});
