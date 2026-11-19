// Trace's time-window maths: stretches keep the right edge, zooms keep the
// anchor's relative position, and All spans the earliest loaded sample.
import { describe, expect, it } from 'vitest';
import type { ArchiveSeriesResult } from '../../../hooks/useArchiveSeries';
import type { FormulaSeriesResult } from '../../../hooks/useFormulaSeries';
import type { LiveSeriesResult } from '../../../hooks/useLiveSeries';
import {
  allLoadedWindow,
  allLoadedXAxis,
  centerTimeOn,
  type LoadedResults,
  panTime,
  stretchTimeRightAnchored,
  zoomTimeAt,
} from './time';

describe('time windows', () => {
  const w = { from: 1_000_000, to: 1_060_000 }; // one minute

  it('stretchTimeRightAnchored keeps the right edge', () => {
    const out = stretchTimeRightAnchored(w, 2);
    expect(out.to).toBe(w.to);
    expect(out.to - out.from).toBe(120_000);
    const narrow = stretchTimeRightAnchored(w, 0.5);
    expect(narrow).toEqual({ from: 1_030_000, to: 1_060_000 });
  });

  it('zoomTimeAt keeps the anchor time at the same relative position', () => {
    const at = 1_015_000; // a quarter in
    const out = zoomTimeAt(w, at, 0.5);
    expect(out.to - out.from).toBe(30_000);
    expect((at - out.from) / (out.to - out.from)).toBeCloseTo(0.25);
  });

  it('zoomTimeAt about the centre preserves the centre', () => {
    const out = zoomTimeAt(w, 1_030_000, 3);
    expect((out.from + out.to) / 2).toBe(1_030_000);
  });

  it('panTime shifts both edges and keeps the span', () => {
    expect(panTime(w, -5_000)).toEqual({ from: 995_000, to: 1_055_000 });
  });

  it('centerTimeOn centres the window on t with the same span', () => {
    expect(centerTimeOn(w, 5_000_000)).toEqual({ from: 4_970_000, to: 5_030_000 });
  });
});

// All = earliest loaded sample of the visible curves → now, written as a
// relative span that never cuts that sample off.
describe('allLoadedWindow / allLoadedXAxis', () => {
  const NOW = 1_700_000_000_000;
  const MIN = 60_000;
  const archive = (pts: [number, number | null][]): ArchiveSeriesResult => ({
    status: 'ready',
    mean: pts.map(([time, value]) => ({ time, value })) as ArchiveSeriesResult['mean'],
    band: [],
  });
  const live = (pts: [number, number | null][], breaks: number[] = []): LiveSeriesResult =>
    ({
      status: 'live',
      connected: true,
      severity: null,
      latest: null,
      error: null,
      points: pts.map(([time, value]) => ({
        time,
        value,
        severity: null,
      })) as unknown as LiveSeriesResult['points'],
      breaks,
    }) as unknown as LiveSeriesResult;
  const formula = (pts: [number, number | null][]): FormulaSeriesResult => ({
    status: 'ready',
    points: pts as [number, number][],
  });
  const xAxis = { timeRange: '-1h' };

  it('is the earliest sample across archive, live and formula buffers to now', () => {
    const results: LoadedResults = {
      archive: new Map([
        [
          'a',
          archive([
            [NOW - 30 * MIN, 1],
            [NOW - 20 * MIN, 2],
          ]),
        ],
      ]),
      live: new Map([['b', live([[NOW - 50 * MIN, 1]])]]),
      formula: new Map([['c', formula([[NOW - 40 * MIN, 3]])]]),
    };
    expect(allLoadedWindow(results, ['a', 'b', 'c'], NOW)).toEqual({
      from: NOW - 50 * MIN,
      to: NOW,
    });
    expect(allLoadedWindow(results, new Set(['a', 'c']), NOW)).toEqual({
      from: NOW - 40 * MIN,
      to: NOW,
    });
  });

  it('skips gap markers and live disconnect breaks', () => {
    const results: LoadedResults = {
      archive: new Map([
        [
          'a',
          archive([
            [NOW - 90 * MIN, null],
            [NOW - 10 * MIN, 1],
          ]),
        ],
      ]),
      live: new Map([['a', live([[NOW - 5 * MIN, 1]], [NOW - 80 * MIN])]]),
      formula: new Map([
        [
          'f',
          formula([
            [NOW - 70 * MIN, null],
            [NOW - 60 * MIN, NaN],
            [NOW - 15 * MIN, 2],
          ]),
        ],
      ]),
    };
    expect(allLoadedWindow(results, ['a', 'f'], NOW)).toEqual({ from: NOW - 15 * MIN, to: NOW });
  });

  it('ignores hidden curves', () => {
    const results: LoadedResults = {
      archive: new Map([
        ['shown', archive([[NOW - 10 * MIN, 1]])],
        ['hidden', archive([[NOW - 300 * MIN, 1]])],
      ]),
    };
    expect(allLoadedWindow(results, ['shown'], NOW)).toEqual({ from: NOW - 10 * MIN, to: NOW });
    expect(allLoadedXAxis(xAxis, results, ['shown'], NOW)).toEqual({ timeRange: '-10m' });
  });

  it('is null when nothing is loaded', () => {
    expect(allLoadedWindow({}, ['a'], NOW)).toBeNull();
    expect(allLoadedWindow({ archive: new Map([['a', archive([])]]) }, ['a'], NOW)).toBeNull();
    expect(
      allLoadedWindow({ formula: new Map([['a', formula([[NOW - MIN, null]])]]) }, ['a'], NOW)
    ).toBeNull();
    const hiddenOnly: LoadedResults = { archive: new Map([['h', archive([[NOW - MIN, 1]])]]) };
    expect(allLoadedWindow(hiddenOnly, [], NOW)).toBeNull();
    expect(allLoadedXAxis(xAxis, hiddenOnly, [], NOW)).toBeNull();
    expect(allLoadedXAxis(xAxis, {}, ['a'], NOW)).toBeNull();
  });

  it('is null when the span is under the relative-span floor', () => {
    const results: LoadedResults = { live: new Map([['a', live([[NOW - 500, 1]])]]) };
    expect(allLoadedWindow(results, ['a'], NOW)).toEqual({ from: NOW - 500, to: NOW });
    expect(allLoadedXAxis(xAxis, results, ['a'], NOW)).toBeNull();
  });

  it('follows live and keeps the earliest sample in view', () => {
    // 10 min 0.03 s: 'nearest' would round down to -10m and cut the sample off.
    const from = NOW - 10 * MIN - 30;
    const results: LoadedResults = { archive: new Map([['a', archive([[from, 1]])]]) };
    const custom = {
      timeRange: 'custom',
      timeFrom: '2023-11-14T20:00',
      timeTo: '2023-11-14T21:00',
    };
    const out = allLoadedXAxis(custom, results, ['a'], NOW);
    expect(out).not.toBeNull();
    expect(out!.timeRange).toBe('-600.03s');
    expect(out).not.toBe(custom);
    const spanMs = parseFloat(out!.timeRange.slice(1)) * 1000;
    expect(NOW - spanMs).toBeLessThanOrEqual(from);
  });
});
