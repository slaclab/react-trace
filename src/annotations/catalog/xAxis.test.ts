// Pins the x-axis descriptors: TIME_X_AXIS reproduces today's time
// behaviour exactly (clock names, status dates, durations, Math.round), and
// VALUE_X_AXIS rounds a free-placed x by the pixel-step rule while a snapped
// x stays exact. Also pins catalog/format.ts to the outputs of model.ts's former formatters.
import { describe, it, expect } from 'vitest';
import { TIME_X_AXIS, VALUE_X_AXIS } from './xAxis';
import { fmtValue, formatDuration, withUnit } from './format';
import type { Annotation } from '../model';
import { BUILTIN_CATALOG } from '.';
import { objNameIn, quantizePointIn } from '../model';

const vline = (t: number): Annotation => ({
  id: 'a',
  kind: 'vline',
  points: [{ t, v: 0 }],
  axisId: 'y',
  color: 'c',
  width: 1.5,
  text: '',
});

describe('TIME_X_AXIS', () => {
  const t = new Date(2026, 9, 19, 7, 5, 9, 600).getTime();

  it('is a time descriptor', () => {
    expect(TIME_X_AXIS.kind).toBe('time');
  });

  it("formats 'name' as the V-line object name's local HH:MM:SS", () => {
    expect(TIME_X_AXIS.format(t, 'name')).toBe('07:05:09');
    expect(`V-line ${TIME_X_AXIS.format(t, 'name')}`).toBe(
      objNameIn(BUILTIN_CATALOG, TIME_X_AXIS, vline(t), [])
    );
  });

  it("formats 'status' as the local YYYY-MM-DD HH:mm:ss of the status line", () => {
    expect(TIME_X_AXIS.format(t, 'status')).toBe('2026-10-19 07:05:09');
    expect(TIME_X_AXIS.format(new Date(2026, 0, 2, 23, 0, 0).getTime(), 'status')).toBe(
      '2026-01-02 23:00:00'
    );
  });

  it('formats spans exactly as formatDuration', () => {
    // Pinned from model.ts formatDuration before it moved to catalog/format (2.10).
    const spans: [number, string][] = [
      [0, '0 s'],
      [1, '1 ms'],
      [999, '999 ms'],
      [1000, '1 s'],
      [61_000, '1 m 1 s'],
      [750_000, '12 m 30 s'],
      [3_600_000, '1 h'],
      [90_061_000, '1 d 1 h'],
      [-125_000, '2 m 5 s'],
    ];
    for (const [ms, text] of spans) {
      expect(TIME_X_AXIS.formatSpan(ms)).toBe(formatDuration(ms));
      expect(TIME_X_AXIS.formatSpan(ms)).toBe(text);
    }
    expect(TIME_X_AXIS.formatSpan(750_000)).toBe('12 m 30 s');
  });

  it('quantizes with Math.round, snapped or not, whatever the pixel step', () => {
    for (const [x, px] of [
      [1.4, 1000],
      [1.5, 0.001],
      [1_700_000_000_123.6, 60_000],
      [-2.5, 1],
    ]) {
      expect(TIME_X_AXIS.quantize(x, false, px)).toBe(Math.round(x));
      expect(TIME_X_AXIS.quantize(x, true, px)).toBe(Math.round(x));
    }
  });

  it('agrees with quantizePoint on t', () => {
    const p = { t: 1_700_000_000_000.7, v: 1.23456789 };
    expect(TIME_X_AXIS.quantize(p.t, false, 1)).toBe(quantizePointIn(TIME_X_AXIS, p, false).t);
  });
});

describe('VALUE_X_AXIS', () => {
  it('is a value descriptor', () => {
    expect(VALUE_X_AXIS.kind).toBe('value');
  });

  it('keeps a snapped x exact', () => {
    expect(VALUE_X_AXIS.quantize(1.23456789, true, 0.5)).toBe(1.23456789);
    expect(VALUE_X_AXIS.quantize(499_654_321.987, true, 10)).toBe(499_654_321.987);
  });

  it('rounds a free x to the largest power of ten no larger than a tenth of a pixel', () => {
    // pxStep 0.5 → limit 0.05 → step 0.01
    expect(VALUE_X_AXIS.quantize(1.23456, false, 0.5)).toBe(1.23);
    // pxStep 1 → limit 0.1 → step 0.1 (exact power: no off-by-one)
    expect(VALUE_X_AXIS.quantize(0.26, false, 1)).toBe(0.3);
    // pxStep 0.99 → limit 0.099 → step 0.01
    expect(VALUE_X_AXIS.quantize(0.256, false, 0.99)).toBe(0.26);
    // pxStep 250 → limit 25 → step 10
    expect(VALUE_X_AXIS.quantize(1234.5, false, 250)).toBe(1230);
    // pxStep 10 → limit 1 → step 1
    expect(VALUE_X_AXIS.quantize(41.6, false, 10)).toBe(42);
  });

  it('stores short numbers with no binary noise', () => {
    expect(VALUE_X_AXIS.quantize(0.30000001, false, 1)).toBe(0.3);
    expect(String(VALUE_X_AXIS.quantize(0.1 + 0.2, false, 0.001))).toBe('0.3');
  });

  it('keeps resolution for a large value on a narrow span (RF frequency)', () => {
    // 499.65 MHz on a 2 kHz span over 400 px: 5 Hz per pixel → step 0.1 Hz.
    expect(VALUE_X_AXIS.quantize(499_654_321.987, false, 5)).toBe(499_654_322);
    expect(VALUE_X_AXIS.quantize(499_654_321.987, false, 2)).toBe(499_654_322.0);
    expect(VALUE_X_AXIS.quantize(499_654_321.987, false, 0.5)).toBe(499_654_321.99);
  });

  it('works at tiny magnitudes', () => {
    expect(VALUE_X_AXIS.quantize(1.23456e-9, false, 1e-11)).toBe(1.235e-9);
  });

  it('rounds negatives and never stores -0', () => {
    expect(VALUE_X_AXIS.quantize(-1.23456, false, 0.5)).toBe(-1.23);
    expect(Object.is(VALUE_X_AXIS.quantize(-0.004, false, 0.5), 0)).toBe(true);
  });

  it('leaves x alone when the pixel step is unusable', () => {
    for (const px of [0, NaN, Infinity, -Infinity]) {
      expect(VALUE_X_AXIS.quantize(1.23456789, false, px)).toBe(1.23456789);
    }
    expect(VALUE_X_AXIS.quantize(1.23456, false, -0.5)).toBe(1.23);
    expect(VALUE_X_AXIS.quantize(NaN, false, 1)).toBeNaN();
  });

  it("formats 'name' at 4 significant digits and 'status' at 7", () => {
    expect(VALUE_X_AXIS.format(1234.5678, 'name')).toBe('1235');
    expect(VALUE_X_AXIS.format(1234.5678, 'status')).toBe('1234.568');
    expect(VALUE_X_AXIS.format(0, 'status')).toBe('0');
    expect(VALUE_X_AXIS.format(1e-5, 'status')).toBe('1.0000e-5');
    expect(VALUE_X_AXIS.format(499_654_321, 'status')).toBe('4.9965e+8');
  });

  it('formats a span as the size of the difference', () => {
    expect(VALUE_X_AXIS.formatSpan(0.123456)).toBe('0.1235');
    expect(VALUE_X_AXIS.formatSpan(-2.5)).toBe('2.5');
  });
});

describe('catalog/format', () => {
  // Outputs pinned from model.ts's originals, deleted in 2.10 in favour of this module.
  it('keeps the outputs of the fmtValue, withUnit and formatDuration that model.ts had', () => {
    const values: [number, string][] = [
      [0, '0'],
      [1, '1'],
      [-1.23456, '-1.235'],
      [1234567, '1235000'],
      [1e-7, '1e-7'],
      [0.1 + 0.2, '0.3'],
    ];
    for (const [v, text] of values) expect(fmtValue(v)).toBe(text);
    expect(withUnit('1.5', 'mA')).toBe('1.5 mA');
    expect(withUnit('1.5', undefined)).toBe('1.5');
    expect(withUnit('1.5', '')).toBe('1.5');
    const durations: [number, string][] = [
      [0, '0 s'],
      [12, '12 ms'],
      [1000, '1 s'],
      [59_999, '59 s'],
      [86_400_000 + 3_600_000 + 5000, '1 d 1 h'],
      [3 * 86_400_000, '3 d'],
    ];
    for (const [ms, text] of durations) expect(formatDuration(ms)).toBe(text);
  });
});
