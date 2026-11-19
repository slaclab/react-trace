// The two x-axis descriptors. Time carries Trace's behaviour exactly;
// value rounds a free-placed x to the pixel-step rule.
import { fmtValue, formatDuration } from './format';
import type { XAxisDescriptor } from './types';

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Local HH:MM:SS (the V-line object name). */
function fmtClock(t: number): string {
  const d = new Date(t);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** Local `YYYY-MM-DD HH:mm:ss` (the status line, as the crosshair). */
function formatStatusTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** A value at seven significant digits, exponential when very small or large (the status line). */
function formatStatusValue(v: number): string {
  if (v === 0) return '0';
  const abs = Math.abs(v);
  if (abs < 1e-3 || abs >= 1e7) return v.toExponential(4);
  return String(Number(v.toPrecision(7)));
}

/** Epoch-ms x: clock times, durations, whole milliseconds. */
export const TIME_X_AXIS: XAxisDescriptor = Object.freeze({
  kind: 'time' as const,
  format: (x: number, style: 'name' | 'status') =>
    style === 'name' ? fmtClock(x) : formatStatusTime(x),
  formatSpan: (dx: number) => formatDuration(dx),
  quantize: (x: number) => Math.round(x),
});

/** The exponent of the largest power of ten no larger than `limit` (> 0, finite). */
function floorPow10(limit: number): number {
  let e = Math.floor(Math.log10(limit));
  // Math.log10 may land a hair off an exact power; settle on the true floor.
  if (10 ** (e + 1) <= limit) e += 1;
  else if (10 ** e > limit) e -= 1;
  return e;
}

/**
 * Round `x` to a multiple of 10^e without binary noise: through an exact
 * integer scale for e < 0, so 0.1 steps give `0.3`, not `0.30000000000000004`.
 */
function roundToPow10(x: number, e: number): number {
  if (e >= 0) {
    const step = 10 ** e;
    return Math.round(x / step) * step || 0;
  }
  const scale = 10 ** -e;
  const scaled = x * scale;
  // Beyond 2^53 the number already has no digits finer than the step.
  if (!Number.isSafeInteger(Math.round(scaled))) return x;
  return Math.round(scaled) / scale || 0;
}

/**
 * Value x: numbers as the Layers label prints them. A snapped x stays exact;
 * a free-placed x is rounded to the largest power of ten no larger than a
 * tenth of one pixel's worth of x, so the stored number is short and nothing
 * visible is lost at any magnitude.
 */
export const VALUE_X_AXIS: XAxisDescriptor = Object.freeze({
  kind: 'value' as const,
  format: (x: number, style: 'name' | 'status') =>
    style === 'name' ? fmtValue(x) : formatStatusValue(x),
  formatSpan: (dx: number) => fmtValue(Math.abs(dx)),
  quantize(x: number, snapped: boolean, pxStep: number): number {
    if (snapped || !Number.isFinite(x)) return x;
    const limit = Math.abs(pxStep) / 10;
    if (!Number.isFinite(limit) || limit <= 0) return x;
    return roundToPow10(x, floorPow10(limit));
  },
});
