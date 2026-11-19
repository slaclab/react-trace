import { describe, it, expect, vi } from 'vitest';
import {
  isAtNow,
  parseSpanMs,
  relativeRangeMs,
  relativeSpanFor,
  resolveTimeWindow,
  toDatetimeLocal,
  msToNs,
} from './time';
import { parseTraceQuery, serializeTraceQuery } from '../embed/query';

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

describe('toDatetimeLocal', () => {
  it('round-trips through Date in local time', () => {
    const ms = new Date('2024-03-04T05:06').getTime();
    const s = toDatetimeLocal(ms);
    expect(s).toBe('2024-03-04T05:06');
    expect(new Date(s).getTime()).toBe(ms);
  });
});

describe('relativeSpanFor', () => {
  const T = Date.UTC(2026, 9, 18, 12, 0, 0);
  const win = (spanMs: number) => ({ from: T - spanMs, to: T });
  const SPANS = [40 * SEC, 90 * SEC, 6 * HOUR];

  it('writes seconds, promoted to m/h/d only when exact', () => {
    expect(relativeSpanFor(win(40 * SEC))).toBe('-40s');
    expect(relativeSpanFor(win(90 * SEC))).toBe('-90s');
    expect(relativeSpanFor(win(1500))).toBe('-1.5s');
    expect(relativeSpanFor(win(MIN))).toBe('-1m');
    expect(relativeSpanFor(win(6 * HOUR))).toBe('-6h');
    expect(relativeSpanFor(win(2 * DAY))).toBe('-2d');
    expect(relativeSpanFor(win(90 * MIN))).toBe('-90m');
    expect(relativeSpanFor(win(30 * MIN))).toBe('-30m');
  });

  it('round-trips through parseSpanMs within 1 ms', () => {
    for (const span of [...SPANS, 40_001.4, 61_234]) {
      for (const round of ['nearest', 'up'] as const) {
        const out = relativeSpanFor(win(span), round);
        expect(out).not.toBeNull();
        expect(out!.startsWith('-')).toBe(true);
        const back = parseSpanMs(out!.slice(1));
        expect(back).not.toBeNull();
        expect(relativeRangeMs(out!)).toBe(back);
        expect(Math.abs(back! - span)).toBeLessThanOrEqual(1);
      }
    }
  });

  it("'up' never comes out shorter than the window", () => {
    for (const span of [...SPANS, 1000.2, 61_001.5, 40_001, 59_999.9, 3 * HOUR + 7]) {
      const out = relativeSpanFor(win(span), 'up');
      expect(relativeRangeMs(out!)!).toBeGreaterThanOrEqual(span);
      expect(relativeRangeMs(out!)! - span).toBeLessThan(1);
    }
  });

  it('nearest can round down; up does not', () => {
    expect(relativeSpanFor(win(40_000.4))).toBe('-40s');
    expect(relativeSpanFor(win(40_000.4), 'up')).toBe('-40.001s');
  });

  it('every output survives a query round-trip unchanged', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (const span of [...SPANS, 1000, 1001, 61_001, 2 * DAY, 25 * HOUR, 7 * DAY + 1]) {
        for (const round of ['nearest', 'up'] as const) {
          const range = relativeSpanFor(win(span), round)!;
          const q = parseTraceQuery(serializeTraceQuery([], { timeRange: range }));
          expect(q.xAxis).toEqual({ timeRange: range });
        }
      }
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('returns null below the 1 s floor and for empty or inverted windows', () => {
    expect(relativeSpanFor(win(999))).toBeNull();
    expect(relativeSpanFor(win(999), 'up')).toBeNull();
    expect(relativeSpanFor(win(0))).toBeNull();
    expect(relativeSpanFor({ from: T, to: T - MIN })).toBeNull();
    expect(relativeSpanFor({ from: NaN, to: T })).toBeNull();
    expect(relativeSpanFor(win(1000))).toBe('-1s');
  });
});

describe('isAtNow', () => {
  const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);

  it('is true when the window ends within one refresh interval of now', () => {
    expect(isAtNow({ from: NOW - HOUR, to: NOW }, NOW, 5 * SEC)).toBe(true);
    expect(isAtNow({ from: NOW - HOUR, to: NOW - 5000 }, NOW, 5 * SEC)).toBe(true);
    expect(isAtNow({ from: NOW - HOUR, to: NOW + 2000 }, NOW, 5 * SEC)).toBe(true);
  });

  it('is false when the window ends earlier than that', () => {
    expect(isAtNow({ from: NOW - HOUR, to: NOW - 5001 }, NOW, 5 * SEC)).toBe(false);
    expect(isAtNow({ from: NOW - 2 * HOUR, to: NOW - HOUR }, NOW, 60 * SEC)).toBe(false);
  });
});
