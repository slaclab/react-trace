// Line data and gap markers for a Trace curve.
//
// Contract:
// - Line data is `[ms, value | null][]`; a `[t, null]` entry makes ECharts
//   break the line there, so an outage renders as a gap instead of a ramp.
// - INVALID samples (invalidGaps.ts) break the line the same way: the first
//   INVALID sample of a run becomes `[t, null]` and the rest of the run is left
//   out, so the next good sample starts a new segment.
// - Archive (the recorder writes on a fixed grid): `[t_prev + 1 ms, null]` is
//   inserted wherever the spacing to the next sample exceeds
//   `max(30 s, 3 × median of the ≤ 11 spacings centred on it)` (upper middle
//   for an even count; the global median under 5 points, the 30 s floor alone
//   under 3). The min/max band goes through the same rules, so its nulls sit
//   at the same t as the mean's.
// - Live (Hare monitors): silence means "unchanged", so there is no spacing
//   rule. A null appears only at a recorded disconnect (`LiveEntry.breaks`).
// - Seam: when the archive's covered window ends more than the tail threshold
//   after its last sample, live data that follows is separated by
//   `[t_last_archive + 1 ms, null]`.
// - The dashed now-extension anchors on the last non-null point. A live trace
//   draws it only while connected with no open break; an archive-only trace
//   drops it when its covered window ends more than the tail threshold after
//   its last sample.
// - `traceSamples` is the same merge as plain samples, INVALID ones included
//   with their severity: the tooltip and the INVALID markers read it.

import { nsToMs } from '../api/time';
import type {
  ArchiveBandPoint,
  ArchivePlotPoint,
  ArchiveSeriesResult,
} from '../hooks/useArchiveSeries';
import type { FormulaSeriesResult } from '../hooks/useFormulaSeries';
import type { LiveSeriesResult } from '../hooks/useLiveSeries';
import type { PVTrace } from '../types';
import { isInvalid, type PlotSample } from './invalidGaps';
import type { WireAlarmSeverity } from '@slaclab/canopy-client';

export type LinePoint = [number, number | null];

export const GAP_FLOOR_MS = 30_000;
const GAP_FACTOR = 3;
const LOCAL_HALF_WINDOW = 5; // 5 + self + 5 = 11 spacings
const GLOBAL_BELOW_POINTS = 5;
const FLOOR_ONLY_BELOW_POINTS = 3;

function upperMedian(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
}

/**
 * Gap threshold (ms) for each spacing `times[i] → times[i + 1]`.
 * Returns `times.length - 1` entries (none for fewer than two times).
 */
export function gapThresholds(times: readonly number[]): number[] {
  const n = times.length;
  if (n < 2) return [];
  const spacings = new Array<number>(n - 1);
  for (let i = 0; i < n - 1; i++) spacings[i] = times[i + 1] - times[i];
  if (n < FLOOR_ONLY_BELOW_POINTS) return spacings.map(() => GAP_FLOOR_MS);
  if (n < GLOBAL_BELOW_POINTS) {
    const thr = Math.max(GAP_FLOOR_MS, GAP_FACTOR * upperMedian(spacings));
    return spacings.map(() => thr);
  }
  const out = new Array<number>(spacings.length);
  for (let i = 0; i < spacings.length; i++) {
    const lo = Math.max(0, i - LOCAL_HALF_WINDOW);
    const hi = Math.min(spacings.length, i + LOCAL_HALF_WINDOW + 1);
    out[i] = Math.max(GAP_FLOOR_MS, GAP_FACTOR * upperMedian(spacings.slice(lo, hi)));
  }
  return out;
}

// Indices `i` whose spacing to `i + 1` is a gap.
function gapIndices(times: readonly number[]): Set<number> {
  const thresholds = gapThresholds(times);
  const out = new Set<number>();
  for (let i = 0; i < thresholds.length; i++) {
    if (times[i + 1] - times[i] > thresholds[i]) out.add(i);
  }
  return out;
}

interface Sampled {
  time: number;
  severity?: WireAlarmSeverity;
}

// `points` as line data: INVALID runs break the line (one null at the run's
// first sample), and so does every index in `gaps` (a null 1 ms after it).
function toLineData<P extends Sampled>(
  points: readonly P[],
  y: (p: P) => number,
  gaps: ReadonlySet<number> = new Set()
): LinePoint[] {
  const out: LinePoint[] = [];
  let inInvalid = false;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (isInvalid(p)) {
      if (!inInvalid) out.push([p.time, null]);
      inInvalid = true;
    } else {
      out.push([p.time, y(p)]);
      inInvalid = false;
    }
    if (gaps.has(i)) out.push([p.time + 1, null]);
  }
  return out;
}

function withArchiveGaps<P extends Sampled>(points: readonly P[], y: (p: P) => number) {
  return toLineData(points, y, gapIndices(points.map((p) => p.time)));
}

/** Archive points with `[t_prev + 1 ms, null]` at every outage. */
export function insertArchiveGaps(points: readonly [number, number][]): LinePoint[] {
  return withArchiveGaps(
    points.map(([time, value]) => ({ time, value })),
    (p) => p.value
  );
}

// Archive arrays are replaced (not mutated) on every fetch, so caching by
// array identity keeps the gap scan off the per-frame render path.
const meanCache = new WeakMap<readonly ArchivePlotPoint[], LinePoint[]>();
const bandCache = new WeakMap<
  readonly ArchiveBandPoint[],
  { min: LinePoint[]; max: LinePoint[] }
>();

function archiveLine(mean: readonly ArchivePlotPoint[]): LinePoint[] {
  let cached = meanCache.get(mean);
  if (!cached) {
    cached = withArchiveGaps(mean, (p) => p.value);
    meanCache.set(mean, cached);
  }
  return cached;
}

/**
 * Stacked band series data: `min` as is and `max` as `max − min`, with nulls
 * at the same t in both (and in the mean, which shares the band's times).
 */
export function bandLineData(band: readonly ArchiveBandPoint[]): {
  min: LinePoint[];
  max: LinePoint[];
} {
  let cached = bandCache.get(band);
  if (!cached) {
    cached = {
      min: withArchiveGaps(band, (p) => p.min),
      max: withArchiveGaps(band, (p) => p.max - p.min),
    };
    bandCache.set(band, cached);
  }
  return cached;
}

// True when the archive's covered window ends more than the tail threshold
// after its last sample (the recorder stopped writing before the window end).
export function archiveTailStale(archive: ArchiveSeriesResult | undefined): boolean {
  if (!archive || archive.mean.length === 0 || archive.coverToNs === undefined) return false;
  const mean = archive.mean;
  // The threshold after the last sample is the last spacing's. The last 7
  // samples hold every spacing its window looks at (and all of them under 7
  // points), so the slice gives the same threshold.
  const tail = mean.slice(-(LOCAL_HALF_WINDOW + 2)).map((p) => p.time);
  const threshold = gapThresholds(tail).at(-1) ?? GAP_FLOOR_MS;
  return nsToMs(archive.coverToNs) - mean[mean.length - 1].time > threshold;
}

function liveLine(live: LiveSeriesResult): LinePoint[] {
  const out: LinePoint[] = [];
  const breaks = live.breaks ?? [];
  let b = 0;
  let inInvalid = false;
  for (const p of live.points) {
    while (b < breaks.length && breaks[b] < p.time) out.push([breaks[b++], null]);
    if (isInvalid(p)) {
      if (!inInvalid) out.push([p.time, null]);
      inInvalid = true;
    } else {
      out.push([p.time, p.value]);
      inInvalid = false;
    }
  }
  while (b < breaks.length) out.push([breaks[b++], null]);
  return out;
}

export function traceLineData(
  trace: PVTrace,
  archive: ArchiveSeriesResult | undefined,
  live: LiveSeriesResult | undefined,
  formula: FormulaSeriesResult | undefined
): LinePoint[] {
  // Formula curves are evaluated server-side (the Formula Engine); their points are the only
  // source — no archive/live merge, no mock seed.
  if (trace.kind === 'formula') {
    return formula ? formula.points : [];
  }
  // Archive feeds the past, live the present; with both on, archive runs up to
  // its last sample and live takes over afterwards (de-duped at the seam).
  const archivePts =
    trace.useArchive && archive && archive.mean.length > 0 ? archiveLine(archive.mean) : null;
  const livePts = trace.useLive && live && live.points.length > 0 ? liveLine(live) : null;

  if (archivePts && livePts) {
    const seamMs = archive!.mean[archive!.mean.length - 1].time;
    let head = 0;
    while (head < livePts.length && livePts[head][0] <= seamMs) head++;
    const rest = livePts.slice(head);
    if (rest.length > 0 && rest[0][1] !== null && archiveTailStale(archive)) {
      return [...archivePts, [seamMs + 1, null], ...rest];
    }
    return archivePts.concat(rest);
  }
  if (archivePts) return archivePts;
  if (livePts) return livePts;
  // Live-capable trace with no live samples yet and no archive: render nothing
  // rather than the mock seed. Mock data stays for traces with neither toggle.
  if (trace.useLive || trace.useArchive) return [];
  return trace.data.map((p) => [p.time, p.value]);
}

/**
 * The curve's samples, INVALID ones included, merged the same way as
 * `traceLineData` (archive up to its last sample, then live). Sorted ascending
 * by time. Archive and live samples keep their severity.
 */
export function traceSamples(
  trace: PVTrace,
  archive: ArchiveSeriesResult | undefined,
  live: LiveSeriesResult | undefined,
  formula: FormulaSeriesResult | undefined
): readonly PlotSample[] {
  if (trace.kind === 'formula') {
    return formula ? formula.points.map(([time, value]) => ({ time, value })) : [];
  }
  const archivePts = trace.useArchive && archive && archive.mean.length > 0 ? archive.mean : null;
  const livePts = trace.useLive && live && live.points.length > 0 ? live.points : null;
  if (archivePts && livePts) {
    const seamMs = archivePts[archivePts.length - 1].time;
    let head = 0;
    while (head < livePts.length && livePts[head].time <= seamMs) head++;
    return head === 0 ? archivePts.concat(livePts) : archivePts.concat(livePts.slice(head));
  }
  if (archivePts) return archivePts;
  if (livePts) return livePts;
  if (trace.useLive || trace.useArchive) return [];
  return trace.data;
}

/**
 * The point the dashed now-extension starts from, or undefined when none is
 * drawn: the last non-null point, provided no gap or INVALID run follows it, a
 * live trace is connected, and an archive-only trace's tail is not stale.
 */
export function extensionAnchor(
  trace: PVTrace,
  data: readonly LinePoint[],
  archive: ArchiveSeriesResult | undefined,
  live: LiveSeriesResult | undefined
): [number, number] | undefined {
  const last = data.at(-1);
  if (!last || last[1] === null) return undefined; // open break or empty
  if (trace.kind !== 'formula') {
    if (trace.useLive) {
      if (!live?.connected) return undefined;
    } else if (trace.useArchive && archiveTailStale(archive)) {
      return undefined;
    }
  }
  return [last[0], last[1]];
}

// Binary search for the sample nearest to `tMs`. Samples are sorted ascending
// by time (archive buffer, live buffer and mock generator all honor this).
export function nearestSample(data: readonly PlotSample[], tMs: number): PlotSample | undefined {
  if (data.length === 0) return undefined;
  let lo = 0;
  let hi = data.length - 1;
  if (tMs <= data[lo].time) return data[lo];
  if (tMs >= data[hi].time) return data[hi];
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (data[mid].time <= tMs) lo = mid;
    else hi = mid;
  }
  return data[hi].time - tMs < tMs - data[lo].time ? data[hi] : data[lo];
}
