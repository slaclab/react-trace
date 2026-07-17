import { describe, it, expect } from 'vitest';
import { parseSpanMs, relativeRangeMs, resolveTimeWindow, toDatetimeLocal, nsToMs } from './time';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('parseSpanMs', () => {
  it('parses each unit', () => {
    expect(parseSpanMs('30m')).toBe(30 * MIN);
    expect(parseSpanMs('2h')).toBe(2 * HOUR);
    expect(parseSpanMs('1d')).toBe(DAY);
    expect(parseSpanMs('2w')).toBe(14 * DAY);
    expect(parseSpanMs('1M')).toBe(30 * DAY);
  });

  it('parses decimals and tolerates surrounding space', () => {
    expect(parseSpanMs('1.5h')).toBe(1.5 * HOUR);
    expect(parseSpanMs('  90m ')).toBe(90 * MIN);
  });

  it('rejects bad input', () => {
    expect(parseSpanMs('')).toBeNull();
    expect(parseSpanMs('h')).toBeNull();
    expect(parseSpanMs('10')).toBeNull();
    expect(parseSpanMs('10s')).toBeNull();
    expect(parseSpanMs('0h')).toBeNull();
    expect(parseSpanMs('-5h')).toBeNull();
    expect(parseSpanMs('abc')).toBeNull();
  });
});

describe('relativeRangeMs', () => {
  it('resolves the standard presets', () => {
    expect(relativeRangeMs('-1h')).toBe(HOUR);
    expect(relativeRangeMs('-1w')).toBe(7 * DAY);
    expect(relativeRangeMs('-1M')).toBe(30 * DAY);
  });

  it('requires a leading dash', () => {
    expect(relativeRangeMs('1h')).toBeNull();
    expect(relativeRangeMs('custom')).toBeNull();
  });
});

describe('resolveTimeWindow', () => {
  it('anchors a relative range to now with the right span', () => {
    // Epoch-ns exceeds Number.MAX_SAFE_INTEGER, so ns<->ms round-trips are exact
    // only to within ~1ms; assert "now" with a small tolerance.
    const now = Date.now();
    const { window, error } = resolveTimeWindow({ timeRange: '-1h' });
    expect(error).toBeUndefined();
    expect(Math.abs(nsToMs(window.toNs) - now)).toBeLessThan(50);
    expect(Math.abs(nsToMs(window.toNs) - nsToMs(window.fromNs) - HOUR)).toBeLessThan(2);
  });

  it('falls back to one hour for an unknown range', () => {
    const { window } = resolveTimeWindow({ timeRange: 'bogus' });
    expect(Math.abs(nsToMs(window.toNs) - nsToMs(window.fromNs) - HOUR)).toBeLessThan(2);
  });

  it('resolves a valid custom range from From/To', () => {
    const { window, error } = resolveTimeWindow({
      timeRange: 'custom',
      timeFrom: '2024-01-01T00:00',
      timeTo: '2024-01-01T01:00',
    });
    expect(error).toBeUndefined();
    expect(Math.abs(nsToMs(window.fromNs) - new Date('2024-01-01T00:00').getTime())).toBeLessThan(
      2
    );
    expect(Math.abs(nsToMs(window.toNs) - new Date('2024-01-01T01:00').getTime())).toBeLessThan(2);
  });

  it('treats an empty To as now', () => {
    const now = Date.now();
    const { window, error } = resolveTimeWindow({
      timeRange: 'custom',
      timeFrom: '2024-01-01T00:00',
      timeTo: '',
    });
    expect(error).toBeUndefined();
    expect(Math.abs(nsToMs(window.toNs) - now)).toBeLessThan(50);
  });

  it('errors and falls back when From is blank', () => {
    const { window, error } = resolveTimeWindow({ timeRange: 'custom', timeFrom: '' });
    expect(error).toBeDefined();
    expect(Math.abs(nsToMs(window.toNs) - nsToMs(window.fromNs) - HOUR)).toBeLessThan(2);
  });

  it('errors when From is not before To', () => {
    const { error } = resolveTimeWindow({
      timeRange: 'custom',
      timeFrom: '2024-01-02T00:00',
      timeTo: '2024-01-01T00:00',
    });
    expect(error).toBeDefined();
  });

  it('errors on an unparseable From', () => {
    const { error } = resolveTimeWindow({ timeRange: 'custom', timeFrom: 'not-a-date' });
    expect(error).toBeDefined();
  });
});

describe('toDatetimeLocal', () => {
  it('round-trips through Date in local time', () => {
    const ms = new Date('2024-03-04T05:06').getTime();
    const s = toDatetimeLocal(ms);
    expect(s).toBe('2024-03-04T05:06');
    expect(new Date(s).getTime()).toBe(ms);
  });
});
