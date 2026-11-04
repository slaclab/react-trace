import { describe, expect, it } from 'vitest';
import { MAX_ROLLING_FRAMES, ROLLING_BYTE_BUDGET, RollingWindow, rollingFrameCap } from './frames';

const f = (...v: number[]) => Float64Array.from(v);

describe('RollingWindow', () => {
  it('is empty until a frame is pushed; mean and σ are per element over finite samples', () => {
    const w = new RollingWindow(60);
    expect(w.stats(0)).toBeNull();
    w.push(f(1, 10, NaN), 1000);
    const one = w.stats(1000)!;
    expect(Array.from(one.mean)).toEqual([1, 10, NaN]);
    expect(Array.from(one.std)).toEqual([NaN, NaN, NaN]);
    expect(one.frames).toBe(1);
    w.push(f(3, 10, 5), 2000);
    w.push(f(2, NaN, 7), 3000);
    const s = w.stats(3000)!;
    expect(Array.from(s.mean)).toEqual([2, 10, 6]);
    expect(s.std[0]).toBeCloseTo(1, 12);
    expect(s.std[1]).toBe(0);
    expect(s.std[2]).toBeCloseTo(Math.SQRT2, 12);
    expect(s.frames).toBe(3);
    expect(s.spanMs).toBe(2000);
  });

  it('evicts frames older than the window as of the asked time', () => {
    const w = new RollingWindow(10);
    w.push(f(1), 0);
    w.push(f(3), 5000);
    w.push(f(5), 9000);
    expect(w.stats(9000)!.mean[0]).toBe(3);
    // At 12 s the frame from 0 s is outside the 10 s window.
    expect(w.stats(12_000)!.mean[0]).toBe(4);
    expect(w.size).toBe(2);
    expect(w.stats(30_000)).toBeNull();
  });

  it('keeps at most MAX_ROLLING_FRAMES per window by thinning fast arrivals', () => {
    const w = new RollingWindow(60);
    // 1 kHz for 60 s: 60 000 arrivals.
    for (let i = 0; i < 60_000; i++) w.push(f(i), i);
    expect(w.size).toBeLessThanOrEqual(MAX_ROLLING_FRAMES);
    expect(w.size).toBeGreaterThan(MAX_ROLLING_FRAMES / 2);
    // 10 Hz for 60 s keeps every frame.
    const slow = new RollingWindow(60);
    for (let i = 0; i < 600; i++) slow.push(f(i), i * 100);
    expect(slow.size).toBe(600);
  });

  it('resets on a frame of another length and on reset()', () => {
    const w = new RollingWindow(60);
    w.push(f(1, 2), 0);
    w.push(f(1, 2, 3), 1000);
    expect(w.size).toBe(1);
    expect(w.stats(1000)!.mean.length).toBe(3);
    w.reset();
    expect(w.stats(1000)).toBeNull();
  });

  it('returns the same object until something changed and never mutates one it returned', () => {
    const w = new RollingWindow(60);
    w.push(f(1, 2), 0);
    const a = w.stats(0)!;
    expect(w.stats(10)).toBe(a);
    w.push(f(3, 4), 500);
    const b = w.stats(500)!;
    expect(b).not.toBe(a);
    expect(Array.from(a.mean)).toEqual([1, 2]);
    expect(Array.from(b.mean)).toEqual([2, 3]);
  });

  it('a window shrunk and grown again keeps the frames it retained (the Window field types digit by digit)', () => {
    const w = new RollingWindow(60);
    for (let i = 0; i < 6; i++) w.push(f(i), i * 10_000);
    expect(w.stats(50_000)!.frames).toBe(6);
    w.setSeconds(3);
    expect(w.stats(50_000)!.frames).toBe(1);
    w.setSeconds(300);
    expect(w.stats(50_000)!.frames).toBe(6);
    expect(w.stats(50_000)!.mean[0]).toBe(2.5);
  });

  it('caps retained frames by bytes as well as count', () => {
    expect(rollingFrameCap(10)).toBe(MAX_ROLLING_FRAMES);
    expect(rollingFrameCap(100_000)).toBe(Math.floor(ROLLING_BYTE_BUDGET / 800_000));
    const w = new RollingWindow(3600);
    const big = new Float64Array(100_000);
    for (let i = 0; i < 100; i++) w.push(big, i * 10_000);
    expect(w.retained).toBe(rollingFrameCap(100_000));
  });

  it('keeps σ precise when the mean is large, over many pushes', () => {
    const w = new RollingWindow(60);
    const base = 5e8;
    const noise = [0.5, -0.5, 1.5, -1.5];
    for (let i = 0; i < 1200; i++) w.push(f(base + noise[i % 4]), i * 100);
    const s = w.stats(1200 * 100)!;
    // The window holds the last 600 frames: 150 of each noise value.
    expect(s.frames).toBe(600);
    expect(s.mean[0]).toBeCloseTo(base, 6);
    expect(s.std[0]).toBeCloseTo(Math.sqrt(((0.25 + 0.25 + 2.25 + 2.25) * 150) / 599), 9);
  });

  it('a shorter window evicts at the next stats()', () => {
    const w = new RollingWindow(100);
    w.push(f(1), 0);
    w.push(f(9), 50_000);
    w.setSeconds(10);
    expect(w.stats(50_000)!.mean[0]).toBe(9);
  });
});
