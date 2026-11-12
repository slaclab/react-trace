// Waveform frames. Ring buffers: each incoming array is converted exactly
// once into a Float64Array — null and non-numeric elements become NaN — and
// that array is the ring's storage; nothing downstream copies it again (trails
// are returned by identity). A ring holds frames of one length: a frame of a
// different length resets it, as do a reconnect and the curve no longer being
// wanted (page wanted && curve Visible). Capacity is max(persistence, average);
// a capacity change keeps every frame the new capacity can hold. The reset
// epoch is the time of the ring's last reset, so a snapshot taken before it is
// known not to belong to the frames now held.
//
// Per-frame maths: Δ = live − reference element-wise (NaN where either
// side is NaN, equal lengths required); the average is recomputed at publish
// from the ring's frames, per element over finite samples only — no running
// sum; statistics cover the finite elements of the element-ranged array (never
// decimated data). Results are written into reusable per-curve buffers
// (`CurveBuffers`), not fresh arrays per publish.

import type { WaveformElementRange } from './query';

/** Convert one incoming frame to its stored form: a fresh Float64Array, NaN for every non-number. */
export function toFrame(values: ArrayLike<unknown>): Float64Array {
  const n = values.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const v = values[i];
    out[i] = typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : NaN;
  }
  return out;
}

/** The number of frames a curve's ring keeps: max(persistence, average), at least one. */
export function ringCapacity(persistence: number, average: number): number {
  const n = Math.max(1, Math.floor(persistence) || 0, Math.floor(average) || 0);
  return n;
}

/** A fixed-capacity ring of one-length frames, with an arrival stamp per frame. */
export class FrameRing {
  private frames: (Float64Array | undefined)[];
  private stamps: number[];
  /** Index of the next write. */
  private head = 0;
  private count = 0;
  private len: number | null = null;
  private epoch: number;
  private wanted = true;

  constructor(capacity: number, now: number) {
    const cap = Math.max(1, Math.floor(capacity) || 1);
    this.frames = new Array<Float64Array | undefined>(cap);
    this.stamps = new Array<number>(cap).fill(0);
    this.epoch = now;
  }

  get capacity(): number {
    return this.frames.length;
  }

  /** Frames currently held. */
  get size(): number {
    return this.count;
  }

  /** Element count of the frames held, or null when the ring is empty. */
  get frameLength(): number | null {
    return this.len;
  }

  /** Time of the ring's last reset (construction counts as one). */
  get resetEpoch(): number {
    return this.epoch;
  }

  /**
   * Ingest one frame arriving at `arrival`. Returns the stored array, or null
   * when the ring is not wanted (nothing is held then). A frame whose length
   * differs from the held frames resets the ring first.
   */
  push(values: ArrayLike<unknown>, arrival: number): Float64Array | null {
    if (!this.wanted) return null;
    const frame = toFrame(values);
    if (this.len !== null && frame.length !== this.len) this.reset(arrival);
    const cap = this.frames.length;
    this.frames[this.head] = frame;
    this.stamps[this.head] = arrival;
    this.head = (this.head + 1) % cap;
    if (this.count < cap) this.count++;
    this.len = frame.length;
    return frame;
  }

  /** Drop every frame and stamp the reset epoch. */
  reset(at: number): void {
    this.frames.fill(undefined);
    this.head = 0;
    this.count = 0;
    this.len = null;
    this.epoch = at;
  }

  /** The PV reconnected: frames from before the disconnect are not continued. */
  reconnect(at: number): void {
    this.reset(at);
  }

  /** Whether the curve is wanted (page wanted && curve Visible); going false resets. */
  setWanted(wanted: boolean, at: number): void {
    if (this.wanted && !wanted) this.reset(at);
    this.wanted = wanted;
  }

  /** Change capacity, keeping the newest frames that fit — all of them when it grows. */
  setCapacity(capacity: number): void {
    const cap = Math.max(1, Math.floor(capacity) || 1);
    if (cap === this.frames.length) return;
    const keep = Math.min(this.count, cap);
    const frames = this.last(keep);
    const stamps = this.arrivals(keep);
    this.frames = new Array<Float64Array | undefined>(cap);
    this.stamps = new Array<number>(cap).fill(0);
    for (let i = 0; i < keep; i++) {
      this.frames[i] = frames[i];
      this.stamps[i] = stamps[i];
    }
    this.count = keep;
    this.head = keep % cap;
  }

  /** The newest frame, or null. */
  latest(): Float64Array | null {
    if (this.count === 0) return null;
    return this.frames[this.slot(this.count - 1)]!;
  }

  /** Arrival stamp of the newest frame, or null. */
  latestArrival(): number | null {
    if (this.count === 0) return null;
    return this.stamps[this.slot(this.count - 1)];
  }

  /** The last `n` frames, oldest first, as the stored arrays. */
  last(n: number): Float64Array[] {
    const k = this.take(n);
    const out: Float64Array[] = [];
    for (let i = this.count - k; i < this.count; i++) out.push(this.frames[this.slot(i)]!);
    return out;
  }

  /** Arrival stamps of the last `n` frames, oldest first (parallel to `last(n)`). */
  arrivals(n: number): number[] {
    const k = this.take(n);
    const out: number[] = [];
    for (let i = this.count - k; i < this.count; i++) out.push(this.stamps[this.slot(i)]);
    return out;
  }

  private take(n: number): number {
    return Math.max(0, Math.min(this.count, Math.floor(n) || 0));
  }

  /** Storage slot of the i-th held frame, 0 = oldest. */
  private slot(i: number): number {
    const cap = this.frames.length;
    return (this.head - this.count + i + cap) % cap;
  }
}

/** Whether two frames have the same element count. */
export function sameLength(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  return a.length === b.length;
}

/** `out` when it already holds `n` elements, else a fresh array of `n`. */
function sized(out: Float64Array | undefined, n: number): Float64Array {
  return out && out.length === n ? out : new Float64Array(n);
}

/**
 * Δ = live − reference, element-wise, into `out` (reused when it has the right
 * length). NaN wherever either side is NaN. Null when the lengths differ.
 */
export function deltaFrame(
  live: Float64Array,
  ref: Float64Array,
  out?: Float64Array
): Float64Array | null {
  if (!sameLength(live, ref)) return null;
  const n = live.length;
  const dst = sized(out, n);
  for (let i = 0; i < n; i++) dst[i] = live[i] - ref[i];
  return dst;
}

/**
 * Per-element mean of `frames` over finite samples only, into `out` (reused
 * when it has the right length); NaN for an element with no finite sample.
 * Recomputed from the frames on every call. Null for no frames or mixed lengths.
 */
export function averageFrames(
  frames: readonly Float64Array[],
  out?: Float64Array
): Float64Array | null {
  if (frames.length === 0) return null;
  const n = frames[0].length;
  for (const fr of frames) if (fr.length !== n) return null;
  const dst = sized(out, n);
  const k = frames.length;
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let count = 0;
    for (let j = 0; j < k; j++) {
      const v = frames[j][i];
      if (Number.isFinite(v)) {
        sum += v;
        count++;
      }
    }
    dst[i] = count > 0 ? sum / count : NaN;
  }
  return dst;
}

/** A half-open element span [start, end). */
export interface ElementSpan {
  start: number;
  end: number;
}

/** Clamp an inclusive element range (null = all) to a half-open span of a `len`-element frame. */
export function elementSpan(
  len: number,
  range: WaveformElementRange | null | undefined
): ElementSpan {
  const first = range?.first ?? 0;
  const last = range?.last ?? len - 1;
  const start = Math.min(len, Math.max(0, Math.floor(first)));
  const end = Math.max(start, Math.min(len, Math.floor(last) + 1));
  return { start, end };
}

/** Statistics of one frame over its element range. */
export interface FrameStats {
  mean: number;
  rms: number;
  /** Peak-to-peak (max − min). */
  p2p: number;
  /** Finite elements in range. */
  finite: number;
  /** Elements in range. */
  len: number;
}

function emptyStats(): FrameStats {
  return { mean: NaN, rms: NaN, p2p: NaN, finite: 0, len: 0 };
}

/**
 * Mean, RMS and peak-to-peak over the finite elements of `frame` within the
 * element range (pass the full-range frame, never decimated data). Written into
 * `out` when given. NaN statistics when no element in range is finite.
 */
export function frameStats(
  frame: Float64Array,
  range?: WaveformElementRange | null,
  out?: FrameStats
): FrameStats {
  const dst = out ?? emptyStats();
  const { start, end } = elementSpan(frame.length, range);
  let sum = 0;
  let sumSq = 0;
  let min = Infinity;
  let max = -Infinity;
  let finite = 0;
  for (let i = start; i < end; i++) {
    const v = frame[i];
    if (!Number.isFinite(v)) continue;
    sum += v;
    sumSq += v * v;
    if (v < min) min = v;
    if (v > max) max = v;
    finite++;
  }
  dst.len = end - start;
  dst.finite = finite;
  if (finite === 0) {
    dst.mean = NaN;
    dst.rms = NaN;
    dst.p2p = NaN;
  } else {
    dst.mean = sum / finite;
    dst.rms = Math.sqrt(sumSq / finite);
    dst.p2p = max - min;
  }
  return dst;
}

/** "n finite / len" when some elements in range were not finite, else null. */
export function finiteLabel(stats: FrameStats): string | null {
  return stats.finite < stats.len ? `${stats.finite} finite / ${stats.len}` : null;
}

/**
 * One curve's reusable result storage: the Δ and average arrays and the stats
 * object are kept across publishes and reallocated only when the frame length
 * changes. A returned array is overwritten by the next call of the same kind.
 */
export class CurveBuffers {
  private deltaBuf: Float64Array | undefined;
  private avgBuf: Float64Array | undefined;
  private statsBuf: FrameStats = emptyStats();

  /** Δ = live − reference into this curve's Δ buffer; null when the lengths differ. */
  delta(live: Float64Array, ref: Float64Array): Float64Array | null {
    if (!sameLength(live, ref)) return null;
    this.deltaBuf = deltaFrame(live, ref, this.deltaBuf)!;
    return this.deltaBuf;
  }

  /** Finite-only per-element average of `frames` into this curve's average buffer. */
  average(frames: readonly Float64Array[]): Float64Array | null {
    const out = averageFrames(frames, this.avgBuf);
    if (out) this.avgBuf = out;
    return out;
  }

  /** Statistics of `frame` over the element range into this curve's stats object. */
  stats(frame: Float64Array, range?: WaveformElementRange | null): FrameStats {
    return frameStats(frame, range, this.statsBuf);
  }
}

// ── Rolling reference ──────────────────────────────────────────────────────

/** The most frames a rolling window keeps per curve. */
export const MAX_ROLLING_FRAMES = 600;
/** …and the most bytes: a 100k-element PV keeps 40 frames, a 10k one 400. */
export const ROLLING_BYTE_BUDGET = 32 * 1024 * 1024;
/** Pushes between full rebuilds of the running sums (bounds their rounding drift). */
const REBUILD_EVERY = 512;

/** The frames a window may keep for frames of `length` elements. */
export function rollingFrameCap(length: number): number {
  return Math.max(
    1,
    Math.min(MAX_ROLLING_FRAMES, Math.floor(ROLLING_BYTE_BUDGET / (8 * Math.max(1, length))))
  );
}

/** What a rolling window publishes for one curve. */
export interface RollingFrame {
  /** Per-element mean over the window's frames (finite samples only; NaN with none). */
  mean: Float64Array;
  /** Per-element sample σ (ddof = 1); NaN below two finite samples. */
  std: Float64Array;
  /** Frames inside the window the statistics cover. */
  frames: number;
  /** Time (ms) from the oldest frame in the window to the newest. */
  spanMs: number;
}

/**
 * The frames of one curve, with the statistics of those inside the last
 * `seconds`. Retained frames are time-decimated so at most `rollingFrameCap`
 * are kept (a frame is kept only once `seconds / MAX_ROLLING_FRAMES` has
 * passed since the last kept one: a 10 Hz PV over 60 s keeps every frame, a
 * 1 kHz one keeps one in ten). A frame that leaves the window stays retained
 * until the cap pushes it out, so a window shrunk and grown again (the
 * Window field commits each keystroke) loses nothing. A frame of another
 * length resets the window, as does `reset()` (a reconnect, the curve no
 * longer wanted).
 *
 * Mean and σ come from running per-element sums over the frames in the
 * window — added on push, subtracted when a frame leaves — so `stats()` is
 * O(length), not O(frames × length). The sums are of values shifted by the
 * window's first frame, so σ keeps its precision when the mean is large
 * (a 500 MHz frequency with Hz jitter), and they are rebuilt from the frames
 * every `REBUILD_EVERY` pushes and whenever the window length changes.
 * `stats()` returns the same object until something changed, and never
 * mutates an object it returned.
 */
export class RollingWindow {
  private frames: Float64Array[] = [];
  private stamps: number[] = [];
  private seconds: number;
  /** Index of the oldest retained frame inside the window. */
  private start = 0;
  private shift: Float64Array | null = null;
  private sum: Float64Array | null = null;
  private sumSq: Float64Array | null = null;
  private finite: Float64Array | null = null;
  private sumsValid = false;
  private pushesSinceRebuild = 0;
  private dirty = true;
  private cached: RollingFrame | null = null;

  constructor(seconds: number) {
    this.seconds = Math.max(1, seconds);
  }

  get windowSeconds(): number {
    return this.seconds;
  }

  /** Frames inside the window, as of the last push or stats(). */
  get size(): number {
    return this.frames.length - this.start;
  }

  /** Frames retained, inside the window or not. */
  get retained(): number {
    return this.frames.length;
  }

  /** Change the window; the sums are rebuilt over the new window at the next stats(). */
  setSeconds(seconds: number): void {
    const next = Math.max(1, seconds);
    if (next === this.seconds) return;
    this.seconds = next;
    this.sumsValid = false;
    this.dirty = true;
  }

  reset(): void {
    this.frames = [];
    this.stamps = [];
    this.start = 0;
    this.shift = this.sum = this.sumSq = this.finite = null;
    this.sumsValid = false;
    this.dirty = true;
    this.cached = null;
  }

  private minGapMs(): number {
    return (this.seconds * 1000) / MAX_ROLLING_FRAMES;
  }

  /** Keep `frame` (a stored ring array, never mutated) arriving at `at`, subject to the decimation gap. */
  push(frame: Float64Array, at: number): void {
    const last = this.frames[this.frames.length - 1];
    if (last !== undefined && last.length !== frame.length) this.reset();
    const lastAt = this.stamps[this.stamps.length - 1];
    if (lastAt !== undefined && at - lastAt < this.minGapMs()) return;
    this.frames.push(frame);
    this.stamps.push(at);
    if (this.sumsValid) {
      this.add(frame, 1);
      if (++this.pushesSinceRebuild >= REBUILD_EVERY) this.sumsValid = false;
    }
    const cap = rollingFrameCap(frame.length);
    while (this.frames.length > cap) {
      const dropped = this.frames.shift()!;
      this.stamps.shift();
      if (this.start > 0) this.start--;
      else if (this.sumsValid) this.add(dropped, -1);
    }
    this.dirty = true;
  }

  /** Move the window's start past frames older than `at − seconds`. */
  private advance(at: number): void {
    const cutoff = at - this.seconds * 1000;
    while (this.start < this.frames.length && this.stamps[this.start] < cutoff) {
      if (this.sumsValid) this.add(this.frames[this.start], -1);
      this.start++;
      this.dirty = true;
    }
  }

  /** Rebuild the running sums over the frames inside the window as of `at`. */
  private rebuild(at: number): void {
    const cutoff = at - this.seconds * 1000;
    let start = 0;
    while (start < this.frames.length && this.stamps[start] < cutoff) start++;
    this.start = start;
    const n = this.frames[0]?.length ?? 0;
    const first = this.frames[start];
    this.shift = new Float64Array(n);
    if (first !== undefined)
      for (let i = 0; i < n; i++) this.shift[i] = Number.isFinite(first[i]) ? first[i] : 0;
    this.sum = new Float64Array(n);
    this.sumSq = new Float64Array(n);
    this.finite = new Float64Array(n);
    this.sumsValid = true;
    this.pushesSinceRebuild = 0;
    for (let j = start; j < this.frames.length; j++) this.add(this.frames[j], 1);
    this.dirty = true;
  }

  /** Add (`sign` 1) or remove (`sign` −1) one frame from the running sums. */
  private add(frame: Float64Array, sign: 1 | -1): void {
    const { shift, sum, sumSq, finite } = this;
    if (shift === null || sum === null || sumSq === null || finite === null) return;
    const n = Math.min(frame.length, sum.length);
    for (let i = 0; i < n; i++) {
      const v = frame[i];
      if (!Number.isFinite(v)) continue;
      const d = v - shift[i];
      sum[i] += sign * d;
      sumSq[i] += sign * d * d;
      finite[i] += sign;
    }
  }

  /** The window's statistics as of `at`, or null when no frame is inside it. */
  stats(at: number): RollingFrame | null {
    if (this.frames.length === 0) return null;
    if (this.sumsValid) this.advance(at);
    else this.rebuild(at);
    const k = this.frames.length - this.start;
    if (k === 0) {
      this.cached = null;
      return null;
    }
    if (!this.dirty && this.cached !== null) return this.cached;
    const { shift, sum, sumSq, finite } = this;
    const n = sum!.length;
    const mean = new Float64Array(n);
    const std = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const c = finite![i];
      if (c <= 0) {
        mean[i] = NaN;
        std[i] = NaN;
        continue;
      }
      const m = sum![i] / c;
      mean[i] = shift![i] + m;
      std[i] = c < 2 ? NaN : Math.sqrt(Math.max(0, (sumSq![i] - c * m * m) / (c - 1)));
    }
    this.cached = {
      mean,
      std,
      frames: k,
      spanMs: this.stamps[this.frames.length - 1] - this.stamps[this.start],
    };
    this.dirty = false;
    return this.cached;
  }
}
