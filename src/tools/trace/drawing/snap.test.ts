// @vitest-environment jsdom
// Pins snap-to-sample: the cursor snaps to the
// sample nearest in *pixels* across every visible curve, within a radius;
// gap markers and hidden curves never win; and each curve is scanned only over
// the time slice covering x ± radius, never end to end.
import { describe, expect, it } from 'vitest';
import type { LinePoint } from '../../../components/traceGaps';
import { type SnapProjection } from '../../../plot/geometry';
import { snapToSample } from './snap';

// 1 ms per pixel on x (t = x); per-axis linear y: axis "a" maps v -> 200 - v,
// axis "b" maps v -> 200 - 2v. Counts every vToY call so a test can prove the
// scan never leaves the slice.
function fakeProjection(): SnapProjection & { vToYCalls: number } {
  const p = {
    vToYCalls: 0,
    tToX: (t: number) => t,
    xToT: (x: number) => x,
    vToY(v: number, axisId: string) {
      p.vToYCalls++;
      return axisId === 'b' ? 200 - 2 * v : 200 - v;
    },
  };
  return p;
}

const trace = (id: string, axisId: string, visible = true) => ({ id, axisId, visible });

function line(n: number, value: (t: number) => number | null): LinePoint[] {
  return Array.from({ length: n }, (_, t) => [t, value(t)] as LinePoint);
}

describe('snapToSample', () => {
  it('snaps to the nearer of two curves, reporting that curve and its axis', () => {
    const data = new Map<string, LinePoint[]>([
      ['t1', line(200, () => 100)], // y = 100 on axis a
      ['t2', line(200, () => 45)], //  y = 110 on axis b
    ]);
    const traces = [trace('t1', 'a'), trace('t2', 'b')];
    const proj = fakeProjection();
    expect(snapToSample(data, traces, proj, 50, 108)).toEqual({
      t: 50,
      v: 45,
      axisId: 'b',
      traceId: 't2',
    });
    expect(snapToSample(data, traces, proj, 50, 101)).toEqual({
      t: 50,
      v: 100,
      axisId: 'a',
      traceId: 't1',
    });
  });

  it('picks the nearest sample in 2-D pixel distance, not just in time', () => {
    // Sample at t=10 is far vertically; t=14 is close vertically.
    const data = new Map<string, LinePoint[]>([
      [
        't1',
        [
          [10, 0],
          [14, 95],
          [30, 0],
        ],
      ],
    ]);
    const hit = snapToSample(data, [trace('t1', 'a')], fakeProjection(), 10, 105);
    expect(hit).toEqual({ t: 14, v: 95, axisId: 'a', traceId: 't1' });
  });

  it('ignores gap markers', () => {
    // The sample right under the cursor is a gap; the next real one is 10 px away.
    const data = new Map<string, LinePoint[]>([
      [
        't1',
        [
          [40, 100],
          [50, null],
          [60, 100],
        ],
      ],
    ]);
    const hit = snapToSample(data, [trace('t1', 'a')], fakeProjection(), 51, 100);
    expect(hit).toEqual({ t: 60, v: 100, axisId: 'a', traceId: 't1' });
    const onlyGaps = new Map<string, LinePoint[]>([['t1', [[50, null]]]]);
    expect(snapToSample(onlyGaps, [trace('t1', 'a')], fakeProjection(), 50, 100)).toBeNull();
  });

  it('ignores hidden curves even when their data is present', () => {
    const data = new Map<string, LinePoint[]>([
      ['near', line(100, () => 100)],
      ['far', line(100, () => 90)],
    ]);
    const traces = [trace('near', 'a', false), trace('far', 'a')];
    expect(snapToSample(data, traces, fakeProjection(), 50, 100)).toEqual({
      t: 50,
      v: 90,
      axisId: 'a',
      traceId: 'far',
    });
  });

  it('ignores traces with no data', () => {
    const data = new Map<string, LinePoint[]>([['t1', line(100, () => 100)]]);
    const traces = [trace('missing', 'a'), trace('t1', 'a')];
    expect(snapToSample(data, traces, fakeProjection(), 50, 100)?.traceId).toBe('t1');
  });

  it('returns null when nothing lies within the radius', () => {
    const data = new Map<string, LinePoint[]>([['t1', line(200, () => 100)]]);
    const traces = [trace('t1', 'a')];
    // 30 px above the line, default radius 24.
    expect(snapToSample(data, traces, fakeProjection(), 50, 70)).toBeNull();
    // Within an explicit larger radius it snaps.
    expect(snapToSample(data, traces, fakeProjection(), 50, 70, 40)?.t).toBe(50);
    // Beyond the data's time range.
    expect(snapToSample(data, traces, fakeProjection(), 500, 100)).toBeNull();
    // Empty data map.
    expect(snapToSample(new Map(), traces, fakeProjection(), 50, 100)).toBeNull();
  });

  it('excludes a sample exactly within the slice but outside the radius diagonally', () => {
    // dx = 20, dy = 20 -> ~28.3 px > 24.
    const data = new Map<string, LinePoint[]>([['t1', [[70, 80]]]]);
    expect(snapToSample(data, [trace('t1', 'a')], fakeProjection(), 50, 100)).toBeNull();
  });

  it('scans only the time slice covering x ± radius', () => {
    const n = 100_000;
    const data = new Map<string, LinePoint[]>([['t1', line(n, () => 100)]]);
    const proj = fakeProjection();
    const hit = snapToSample(data, [trace('t1', 'a')], proj, 50_000, 100, 24);
    expect(hit).toEqual({ t: 50_000, v: 100, axisId: 'a', traceId: 't1' });
    // The slice [49 976, 50 024] holds 49 samples; nothing outside it is projected.
    expect(proj.vToYCalls).toBeGreaterThan(0);
    expect(proj.vToYCalls).toBeLessThanOrEqual(49);
  });

  it('skips non-finite projected y values', () => {
    const proj = fakeProjection();
    const nanProj: SnapProjection = {
      ...proj,
      vToY: (v, axisId) => (v < 0 ? Number.NaN : proj.vToY(v, axisId)),
    };
    const data = new Map<string, LinePoint[]>([
      [
        't1',
        [
          [50, -1],
          [55, 100],
        ],
      ],
    ]);
    expect(snapToSample(data, [trace('t1', 'a')], nanProj, 50, 100)?.t).toBe(55);
  });
});
