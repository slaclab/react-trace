import { describe, it, expect } from 'vitest';
import { mergeLive, type InsightRow } from './useInsightData';
import type { LivePoint } from '../state/liveStore';
import type { AlarmSeverity } from '../api/types';

// Archive rows carry ns timestamps; live points carry ms. A live point at
// `t` ms lands at `t * 1e6` ns, so these helpers keep the two domains aligned.
function archive(tsMs: number, value: number, severity: AlarmSeverity = 'NO_ALARM'): InsightRow {
  return { tsNs: tsMs * 1e6, value, severity, source: 'Archive' };
}

function live(tsMs: number, value: number, severity: AlarmSeverity = 'NO_ALARM'): LivePoint {
  return { time: tsMs, value, severity };
}

const WIDE: [number, number] = [0, 10_000 * 1e6];

describe('mergeLive', () => {
  it('returns the archive rows unchanged when there are no live points', () => {
    const rows = [archive(1000, 1), archive(2000, 2)];
    const merged = mergeLive(rows, [], WIDE[0], WIDE[1]);
    expect(merged).toBe(rows); // same reference — no allocation when nothing to add
  });

  it('appends live samples after the archive seam and tags their source', () => {
    const rows = [archive(1000, 1), archive(2000, 2), archive(3000, 3)];
    const points = [live(3500, 3.5), live(4000, 4)];
    const merged = mergeLive(rows, points, WIDE[0], WIDE[1]);
    expect(merged).toEqual([
      archive(1000, 1),
      archive(2000, 2),
      archive(3000, 3),
      { tsNs: 3500 * 1e6, value: 3.5, severity: 'NO_ALARM', source: 'Live' },
      { tsNs: 4000 * 1e6, value: 4, severity: 'NO_ALARM', source: 'Live' },
    ]);
  });

  it('drops live samples at or before the last archive sample (seam de-dupe)', () => {
    const rows = [archive(1000, 1), archive(3000, 3)];
    // 2500 and 3000 are at/before the seam (3000) — dropped; 3500 kept.
    const points = [live(2500, 2.5), live(3000, 9), live(3500, 3.5)];
    const merged = mergeLive(rows, points, WIDE[0], WIDE[1]);
    expect(merged.map((r) => [r.tsNs, r.source])).toEqual([
      [1000 * 1e6, 'Archive'],
      [3000 * 1e6, 'Archive'],
      [3500 * 1e6, 'Live'],
    ]);
  });

  it('windows live samples to the visible range', () => {
    const rows = [archive(1000, 1)];
    const points = [live(500, 0.5), live(2000, 2), live(9000, 9)];
    // Window [1500ms, 5000ms]: 500 below, 9000 above, only 2000 survives.
    const merged = mergeLive(rows, points, 1500 * 1e6, 5000 * 1e6);
    expect(merged.map((r) => r.tsNs)).toEqual([1000 * 1e6, 2000 * 1e6]);
  });

  it('keeps all live samples when there is no archive data (live-only)', () => {
    const points = [live(1000, 1), live(2000, 2)];
    const merged = mergeLive([], points, WIDE[0], WIDE[1]);
    expect(merged).toEqual([
      { tsNs: 1000 * 1e6, value: 1, severity: 'NO_ALARM', source: 'Live' },
      { tsNs: 2000 * 1e6, value: 2, severity: 'NO_ALARM', source: 'Live' },
    ]);
  });

  it('carries per-sample severity onto live rows', () => {
    const points = [live(1000, 1, 'MINOR'), live(2000, 2, 'MAJOR')];
    const merged = mergeLive([], points, WIDE[0], WIDE[1]);
    expect(merged.map((r) => r.severity)).toEqual(['MINOR', 'MAJOR']);
  });

  it('applies no window filtering when the bounds are undefined', () => {
    const points = [live(1, 1), live(9_999_999, 2)];
    const merged = mergeLive([], points, undefined, undefined);
    expect(merged).toHaveLength(2);
  });
});
