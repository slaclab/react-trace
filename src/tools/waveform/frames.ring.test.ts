import { describe, expect, it } from 'vitest';
import { FrameRing, ringCapacity, toFrame } from './frames';

describe('toFrame', () => {
  it('turns null and non-numeric elements into NaN', () => {
    const f = toFrame([1, null, 'x', undefined, 2.5, true, {}, -0.5]);
    expect(f).toBeInstanceOf(Float64Array);
    expect(Array.from(f)).toEqual([1, NaN, NaN, NaN, 2.5, NaN, NaN, -0.5]);
  });

  it('copies typed input once so the source buffer can be reused', () => {
    const src = new Float32Array([1, 2, 3]);
    const f = toFrame(src);
    src[0] = 9;
    expect(Array.from(f)).toEqual([1, 2, 3]);
  });
});

describe('ringCapacity', () => {
  it('is max(persistence, average), at least 1', () => {
    expect(ringCapacity(1, 1)).toBe(1);
    expect(ringCapacity(16, 4)).toBe(16);
    expect(ringCapacity(3, 64)).toBe(64);
    expect(ringCapacity(0, 0)).toBe(1);
  });
});

describe('FrameRing', () => {
  it('stores ingested frames with null as NaN', () => {
    const ring = new FrameRing(4, 0);
    ring.push([1, null, 3], 10);
    const latest = ring.latest()!;
    expect(latest[0]).toBe(1);
    expect(Number.isNaN(latest[1])).toBe(true);
    expect(latest[2]).toBe(3);
    expect(ring.frameLength).toBe(3);
    expect(ring.latestArrival()).toBe(10);
  });

  it('returns the last N frames oldest first with their arrival stamps', () => {
    const ring = new FrameRing(3, 0);
    for (let i = 1; i <= 5; i++) ring.push([i, i], i * 100);
    expect(ring.size).toBe(3);
    expect(ring.last(3).map((f) => f[0])).toEqual([3, 4, 5]);
    expect(ring.last(2).map((f) => f[0])).toEqual([4, 5]);
    expect(ring.last(10).map((f) => f[0])).toEqual([3, 4, 5]);
    expect(ring.last(0)).toEqual([]);
    expect(ring.arrivals(3)).toEqual([300, 400, 500]);
  });

  it('returns the stored arrays by identity, never copies', () => {
    const ring = new FrameRing(4, 0);
    const a = ring.push([1, 2], 1)!;
    const b = ring.push([3, 4], 2)!;
    const trail = ring.last(2);
    expect(trail[0]).toBe(a);
    expect(trail[1]).toBe(b);
    expect(ring.latest()).toBe(b);
    expect(ring.last(2)[0]).toBe(a);
  });

  it('resets on a length change and keeps only the new frame', () => {
    const ring = new FrameRing(4, 0);
    ring.push([1, 2], 1);
    ring.push([3, 4], 2);
    const c = ring.push([5, 6, 7], 3)!;
    expect(ring.size).toBe(1);
    expect(ring.frameLength).toBe(3);
    expect(ring.last(4)).toEqual([c]);
    expect(ring.resetEpoch).toBe(3);
  });

  it('resets on reconnect', () => {
    const ring = new FrameRing(4, 0);
    ring.push([1, 2], 1);
    ring.push([3, 4], 2);
    ring.reconnect(50);
    expect(ring.size).toBe(0);
    expect(ring.latest()).toBeNull();
    expect(ring.latestArrival()).toBeNull();
    expect(ring.frameLength).toBeNull();
    expect(ring.resetEpoch).toBe(50);
    ring.push([9, 9, 9], 60);
    expect(ring.size).toBe(1);
  });

  it('resets when it stops being wanted and holds nothing while unwanted', () => {
    const ring = new FrameRing(4, 0);
    ring.push([1], 1);
    ring.setWanted(true, 2);
    expect(ring.size).toBe(1);
    expect(ring.resetEpoch).toBe(0);
    ring.setWanted(false, 5);
    expect(ring.size).toBe(0);
    expect(ring.resetEpoch).toBe(5);
    expect(ring.push([2], 6)).toBeNull();
    expect(ring.size).toBe(0);
    ring.setWanted(false, 7);
    expect(ring.resetEpoch).toBe(5);
    ring.setWanted(true, 8);
    ring.push([3], 9);
    expect(ring.last(4).map((f) => f[0])).toEqual([3]);
  });

  it('starts with the construction time as reset epoch', () => {
    expect(new FrameRing(2, 1234).resetEpoch).toBe(1234);
  });

  it('keeps every held frame when capacity grows', () => {
    const ring = new FrameRing(2, 0);
    for (let i = 1; i <= 3; i++) ring.push([i], i);
    const held = ring.last(2);
    ring.setCapacity(5);
    expect(ring.capacity).toBe(5);
    expect(ring.last(5)).toEqual(held);
    expect(ring.last(5)[0]).toBe(held[0]);
    for (let i = 4; i <= 8; i++) ring.push([i], i);
    expect(ring.last(5).map((f) => f[0])).toEqual([4, 5, 6, 7, 8]);
    expect(ring.arrivals(5)).toEqual([4, 5, 6, 7, 8]);
  });

  it('keeps the newest frames when capacity shrinks', () => {
    const ring = new FrameRing(5, 0);
    for (let i = 1; i <= 5; i++) ring.push([i], i);
    ring.setCapacity(2);
    expect(ring.last(5).map((f) => f[0])).toEqual([4, 5]);
    ring.push([6], 6);
    expect(ring.last(5).map((f) => f[0])).toEqual([5, 6]);
    expect(ring.arrivals(2)).toEqual([5, 6]);
  });

  it('never drops a frame within capacity', () => {
    const ring = new FrameRing(64, 0);
    for (let i = 0; i < 64; i++) ring.push([i], i);
    expect(ring.size).toBe(64);
    expect(ring.last(64).map((f) => f[0])).toEqual(Array.from({ length: 64 }, (_, i) => i));
  });

  it('accepts an empty frame as a frame of length 0', () => {
    const ring = new FrameRing(2, 0);
    ring.push([], 1);
    expect(ring.frameLength).toBe(0);
    expect(ring.size).toBe(1);
  });
});
