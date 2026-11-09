import { describe, it, expect } from 'vitest';
import {
  parseSpanMs,
  relativeRangeMs,
  resolveTimeWindow,
  toDatetimeLocal,
  msToNs,
  parseOffsetMs,
  formatOffsetLabel,
} from './time';

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('parseSpanMs', () => {
  it('parses each unit', () => {
    expect(parseSpanMs('30s')).toBe(30 * SEC);
    expect(parseSpanMs('30m')).toBe(30 * MIN);
    expect(parseSpanMs('2h')).toBe(2 * HOUR);
    expect(parseSpanMs('1d')).toBe(DAY);
    expect(parseSpanMs('2w')).toBe(14 * DAY);
    expect(parseSpanMs('1M')).toBe(30 * DAY);
  });

  it('parses decimals and tolerates surrounding space', () => {
    expect(parseSpanMs('1.5h')).toBe(1.5 * HOUR);
    expect(parseSpanMs('2.5s')).toBe(2.5 * SEC);
    expect(parseSpanMs(' 90s ')).toBe(90 * SEC);
    expect(parseSpanMs('  90m ')).toBe(90 * MIN);
  });

  it('rejects bad input', () => {
    expect(parseSpanMs('')).toBeNull();
    expect(parseSpanMs('h')).toBeNull();
    expect(parseSpanMs('10')).toBeNull();
    expect(parseSpanMs('10S')).toBeNull();
    expect(parseSpanMs('10x')).toBeNull();
    expect(parseSpanMs('0h')).toBeNull();
    expect(parseSpanMs('-5h')).toBeNull();
    expect(parseSpanMs('abc')).toBeNull();
  });
});

describe('relativeRangeMs', () => {
  it('resolves the standard presets', () => {
    expect(relativeRangeMs('-30s')).toBe(30 * SEC);
    expect(relativeRangeMs('-60s')).toBe(MIN);
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
  // A fixed "now" (the plot's clock). resolveTimeWindow never reads the wall
  // clock, so these are exact. Epoch-ns exceeds Number.MAX_SAFE_INTEGER, so
  // compare against the same msToNs expressions the code computes rather than
  // re-deriving them from ms arithmetic.
  const NOW = new Date('2026-10-15T12:00:00Z').getTime();

  it('ends a relative range at the given now with the right span', () => {
    const { window, error } = resolveTimeWindow({ timeRange: '-1h' }, NOW);
    expect(error).toBeUndefined();
    expect(window.toNs).toBe(msToNs(NOW));
    expect(window.fromNs).toBe(msToNs(NOW) - msToNs(HOUR));
  });

  it('resolves to the same window however much wall-clock time passes', () => {
    const a = resolveTimeWindow({ timeRange: '-30m' }, NOW).window;
    const b = resolveTimeWindow({ timeRange: '-30m' }, NOW).window;
    expect(b).toEqual(a);
    expect(resolveTimeWindow({ timeRange: '-30m' }, NOW + 5000).window.toNs).toBe(
      msToNs(NOW + 5000)
    );
  });

  it('resolves a seconds span exactly', () => {
    const { window } = resolveTimeWindow({ timeRange: '-30s' }, NOW);
    expect(window.toNs).toBe(msToNs(NOW));
    expect(window.fromNs).toBe(msToNs(NOW) - msToNs(30 * SEC));
  });

  it('falls back to one hour for an unknown range', () => {
    const { window } = resolveTimeWindow({ timeRange: 'bogus' }, NOW);
    expect(window.toNs).toBe(msToNs(NOW));
    expect(window.fromNs).toBe(msToNs(NOW) - msToNs(HOUR));
  });

  it('resolves a valid custom range from From/To', () => {
    const { window, error } = resolveTimeWindow(
      {
        timeRange: 'custom',
        timeFrom: '2024-01-01T00:00',
        timeTo: '2024-01-01T01:00',
      },
      NOW
    );
    expect(error).toBeUndefined();
    expect(window.fromNs).toBe(msToNs(new Date('2024-01-01T00:00').getTime()));
    expect(window.toNs).toBe(msToNs(new Date('2024-01-01T01:00').getTime()));
  });

  it('treats an empty To as the given now', () => {
    const { window, error } = resolveTimeWindow(
      { timeRange: 'custom', timeFrom: '2024-01-01T00:00', timeTo: '' },
      NOW
    );
    expect(error).toBeUndefined();
    expect(window.toNs).toBe(msToNs(NOW));
  });

  it('errors and falls back to the hour before now when From is blank', () => {
    const { window, error } = resolveTimeWindow({ timeRange: 'custom', timeFrom: '' }, NOW);
    expect(error).toBeDefined();
    expect(window.toNs).toBe(msToNs(NOW));
    expect(window.fromNs).toBe(msToNs(NOW) - msToNs(HOUR));
  });

  it('errors when From is not before To', () => {
    const { error } = resolveTimeWindow(
      {
        timeRange: 'custom',
        timeFrom: '2024-01-02T00:00',
        timeTo: '2024-01-01T00:00',
      },
      NOW
    );
    expect(error).toBeDefined();
  });

  it('errors when From is after the given now and To is blank', () => {
    const { error } = resolveTimeWindow(
      { timeRange: 'custom', timeFrom: '2026-10-16T00:00', timeTo: '' },
      NOW
    );
    expect(error).toBeDefined();
  });

  it('errors on an unparseable From', () => {
    const { error } = resolveTimeWindow({ timeRange: 'custom', timeFrom: 'not-a-date' }, NOW);
    expect(error).toBeDefined();
  });
});

describe('parseOffsetMs', () => {
  it('parses signed and bare offsets, rejects invalid input', () => {
    expect(parseOffsetMs('-1d')).toBe(-DAY);
    expect(parseOffsetMs('-7d')).toBe(-7 * DAY);
    expect(parseOffsetMs('+2h')).toBe(2 * HOUR);
    expect(parseOffsetMs('30s')).toBe(30 * SEC);
    expect(parseOffsetMs('')).toBeNull();
    expect(parseOffsetMs('abc')).toBeNull();
    expect(parseOffsetMs('-0h')).toBeNull();
  });
});

describe('formatOffsetLabel', () => {
  it('picks the largest whole unit with the correct sign', () => {
    expect(formatOffsetLabel(-DAY)).toBe('−1 d');
    expect(formatOffsetLabel(-14 * DAY)).toBe('−2 w');
    expect(formatOffsetLabel(2 * HOUR)).toBe('+2 h');
    expect(formatOffsetLabel(-500)).toBe('−500 ms');
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
