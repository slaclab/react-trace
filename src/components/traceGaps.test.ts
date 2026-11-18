import { describe, expect, it } from 'vitest';
import {
  GAP_FLOOR_MS,
  archiveTailStale,
  bandLineData,
  extensionAnchor,
  gapThresholds,
  insertArchiveGaps,
  isResumePoint,
  nearestSample,
  traceLineData,
  withLiveResumes,
  type LinePoint,
} from './traceGaps';
import type { ArchiveSeriesResult } from '../hooks/useArchiveSeries';
import type { LiveSeriesResult } from '../hooks/useLiveSeries';
import type { PVTrace } from '../types';

const T0 = Date.UTC(2026, 5, 5, 11, 0, 0);
const S = 1_000;

function grid(startMs: number, stepMs: number, count: number): number[] {
  return Array.from({ length: count }, (_, k) => startMs + k * stepMs);
}

function pts(times: number[], value = 1): [number, number][] {
  return times.map((t) => [t, value]);
}

function nulls(data: readonly LinePoint[]): number[] {
  return data.filter((p) => p[1] === null).map((p) => p[0]);
}

function trace(overrides: Partial<PVTrace> = {}): PVTrace {
  return {
    id: 't1',
    pvName: 'PV',
    displayName: '',
    color: '#0f62fe',
    visible: true,
    axisId: 'ax1',
    useLive: false,
    useArchive: false,
    lineWidth: 2,
    lineType: 'step',
    lineStyle: 'solid',
    showSymbol: false,
    symbolShape: 'circle',
    symbolSize: 10,
    data: [],
    ...overrides,
  };
}

function archive(times: number[], coverToMs: number, value = 1): ArchiveSeriesResult {
  return {
    status: 'ready',
    mode: 'raw',
    mean: times.map((t) => ({ time: t, value, severity: 'NO_ALARM' as const })),
    band: [],
    coverToNs: coverToMs * 1_000_000,
  };
}

function live(
  times: number[],
  breaks: number[] = [],
  connected = true,
  value = 1
): LiveSeriesResult {
  return {
    status: 'connected',
    connected,
    severity: null,
    latest: null,
    error: null,
    points: times.map((t) => ({ time: t, value, severity: 'NO_ALARM' })),
    breaks,
  };
}

describe('archive gap rule', () => {
  it('10 s cadence with a 5 min hole gives one null at t_prev + 1 ms', () => {
    const before = grid(T0, 10 * S, 30);
    const holeStart = before.at(-1)!;
    const after = grid(holeStart + 300 * S, 10 * S, 30);
    const out = insertArchiveGaps(pts([...before, ...after]));
    expect(nulls(out)).toEqual([holeStart + 1]);
    expect(out).toHaveLength(61);
  });

  it('10 s then 60 s density with no hole gives no null', () => {
    const dense = grid(T0, 10 * S, 30);
    const sparse = grid(dense.at(-1)! + 60 * S, 60 * S, 30);
    expect(nulls(insertArchiveGaps(pts([...dense, ...sparse])))).toEqual([]);
  });

  it('two points 40 s apart give one null (30 s floor)', () => {
    expect(nulls(insertArchiveGaps(pts([T0, T0 + 40 * S])))).toEqual([T0 + 1]);
    expect(nulls(insertArchiveGaps(pts([T0, T0 + 20 * S])))).toEqual([]);
  });

  it('four points use the global median', () => {
    // spacings 100, 100, 300 s: median 100 → threshold 300 s, not exceeded.
    expect(nulls(insertArchiveGaps(pts([T0, T0 + 100 * S, T0 + 200 * S, T0 + 500 * S])))).toEqual(
      []
    );
    // spacings 10, 10, 60 s: median 10 → threshold 30 s floor → one null.
    expect(nulls(insertArchiveGaps(pts([T0, T0 + 10 * S, T0 + 20 * S, T0 + 80 * S])))).toEqual([
      T0 + 20 * S + 1,
    ]);
    expect(gapThresholds([T0, T0 + 100 * S, T0 + 200 * S, T0 + 500 * S])).toEqual([
      300 * S,
      300 * S,
      300 * S,
    ]);
  });

  it('uses the upper middle of an even spacing count', () => {
    // three points: spacings 10 s and 200 s, upper middle 200 → threshold 600 s.
    expect(gapThresholds([T0, T0 + 10 * S, T0 + 210 * S])).toEqual([600 * S, 600 * S]);
  });

  it('floors every threshold at 30 s', () => {
    expect(gapThresholds(grid(T0, 1 * S, 20)).every((t) => t === GAP_FLOOR_MS)).toBe(true);
    expect(gapThresholds([T0])).toEqual([]);
    expect(insertArchiveGaps([])).toEqual([]);
  });

  it('puts band nulls at the same t in min and max as in the mean', () => {
    const before = grid(T0, 10 * S, 20);
    const times = [...before, ...grid(before.at(-1)! + 300 * S, 10 * S, 20)];
    const band = times.map((t) => ({ time: t, min: 1, max: 3, severity: 'NO_ALARM' as const }));
    const mean = insertArchiveGaps(pts(times, 2));
    const { min, max } = bandLineData(band);
    expect(nulls(min)).toEqual(nulls(mean));
    expect(nulls(max)).toEqual(nulls(mean));
    expect(nulls(mean)).toHaveLength(1);
    expect(max.find((p) => p[1] !== null)![1]).toBe(2);
  });
});

describe('traceLineData', () => {
  const now = T0 + 3_600 * S;

  it('constant live PV over 10 min: no null and the extension is kept', () => {
    const t = trace({ useLive: true });
    const l = live([now - 600 * S]);
    const data = traceLineData(t, undefined, l, undefined);
    expect(nulls(data)).toEqual([]);
    expect(extensionAnchor(t, data, undefined, l)).toEqual([now - 600 * S, 1]);
  });

  it('stale archive + live from now gives one null at the seam', () => {
    const t = trace({ useLive: true, useArchive: true });
    const times = grid(T0, 10 * S, 100);
    const last = times.at(-1)!;
    const a = archive(times, now);
    const data = traceLineData(t, a, live([now - 2 * S, now - S]), undefined);
    expect(nulls(data)).toEqual([last + 1]);
  });

  it('healthy archive + a live change 45 s later gives no null', () => {
    const t = trace({ useLive: true, useArchive: true });
    const times = grid(now - 600 * S, 10 * S, 60);
    const last = times.at(-1)!;
    const a = archive(times, last + 5 * S);
    const data = traceLineData(t, a, live([last + 45 * S]), undefined);
    expect(nulls(data)).toEqual([]);
    expect(data.at(-1)).toEqual([last + 45 * S, 1]);
  });

  it('now − last = 40 s with coverToNs − last = 8 s: no null, extension kept', () => {
    const t = trace({ useArchive: true });
    const times = grid(now - 640 * S, 10 * S, 61);
    const last = times.at(-1)!;
    expect(now - last).toBe(40 * S);
    const a = archive(times, last + 8 * S);
    const data = traceLineData(t, a, undefined, undefined);
    expect(nulls(data)).toEqual([]);
    expect(archiveTailStale(a)).toBe(false);
    expect(extensionAnchor(t, data, a, undefined)).toEqual([last, 1]);
  });

  it('archive-only stale tail drops the extension', () => {
    const t = trace({ useArchive: true });
    const times = grid(T0, 10 * S, 60);
    const a = archive(times, times.at(-1)! + 120 * S);
    const data = traceLineData(t, a, undefined, undefined);
    expect(archiveTailStale(a)).toBe(true);
    expect(extensionAnchor(t, data, a, undefined)).toBeUndefined();
  });

  it('a recorded live break becomes one null and an open break drops the extension', () => {
    const t = trace({ useLive: true });
    const open = live([now - 30 * S, now - 20 * S], [now - 20 * S + 1], false);
    const data = traceLineData(t, undefined, open, undefined);
    expect(nulls(data)).toEqual([now - 20 * S + 1]);
    expect(extensionAnchor(t, data, undefined, open)).toBeUndefined();
  });

  it('break then reconnect with an unchanged value: line resumes and extension drawn', () => {
    const t = trace({ useLive: true });
    const resumed = live([now - 30 * S, now - S], [now - 30 * S + 1], true);
    const data = traceLineData(t, undefined, resumed, undefined);
    expect(data).toEqual([
      [now - 30 * S, 1],
      [now - 30 * S + 1, null],
      [now - S, 1],
    ]);
    expect(extensionAnchor(t, data, undefined, resumed)).toEqual([now - S, 1]);
  });

  it('no live spacing rule: a 10 min silence is a held line', () => {
    const t = trace({ useLive: true });
    const data = traceLineData(t, undefined, live([now - 700 * S, now - 100 * S]), undefined);
    expect(nulls(data)).toEqual([]);
  });

  it('a disconnected live PV draws no extension', () => {
    const t = trace({ useLive: true });
    const l = live([now - 30 * S], [], false);
    expect(extensionAnchor(t, traceLineData(t, undefined, l, undefined), undefined, l)).toBe(
      undefined
    );
  });
});

describe('withLiveResumes', () => {
  const now = T0 + 3_600 * S;
  const b = now - 60 * S;
  const withResume = (l: LiveSeriesResult, time: number, value = 1): LiveSeriesResult => ({
    ...l,
    resumes: [{ after: b, time, value }],
  });

  it('resumes after a kept break, and the extension anchors there', () => {
    const t = trace({ useLive: true });
    const l = withResume(live([now - 600 * S], [b]), now - 50 * S, 3);
    const data = traceLineData(t, undefined, l, undefined);
    // The line data the read-outs and statistics see has no resume.
    expect(data).toEqual([
      [now - 600 * S, 1],
      [b, null],
    ]);
    const drawn = withLiveResumes(t, data, l);
    expect(drawn).toEqual([
      [now - 600 * S, 1],
      [b, null],
      [now - 50 * S, 3],
    ]);
    expect(drawn.map(isResumePoint)).toEqual([false, false, true]);
    expect(extensionAnchor(t, drawn, undefined, l)).toEqual([now - 50 * S, 3]);
    // Cached: the same drawn line while neither input changes.
    expect(withLiveResumes(t, data, l)).toBe(drawn);
  });

  it('goes between the break and a later sample', () => {
    const t = trace({ useLive: true });
    const l = withResume(live([now - 600 * S, now - 10 * S], [b]), now - 50 * S);
    const drawn = withLiveResumes(t, traceLineData(t, undefined, l, undefined), l);
    expect(drawn.map((p) => p[0])).toEqual([now - 600 * S, b, now - 50 * S, now - 10 * S]);
  });

  it('leaves it out when a sample after the break is at or before it', () => {
    const t = trace({ useLive: true });
    for (const sampleAt of [now - 55 * S, now - 50 * S]) {
      const l = withResume(live([now - 600 * S, sampleAt], [b]), now - 50 * S);
      const data = traceLineData(t, undefined, l, undefined);
      expect(withLiveResumes(t, data, l)).toBe(data);
    }
  });

  it('adds nothing without resumes, for a formula, or with Live off', () => {
    const l = withResume(live([now - 600 * S], [b]), now - 50 * S);
    const data = traceLineData(trace({ useLive: true }), undefined, l, undefined);
    const plain = live([now - 600 * S], [b]);
    expect(withLiveResumes(trace({ useLive: true }), data, plain)).toBe(data);
    expect(withLiveResumes(trace({ useLive: true }), data, undefined)).toBe(data);
    expect(withLiveResumes(trace({ useLive: false }), data, l)).toBe(data);
    expect(withLiveResumes(trace({ useLive: true, kind: 'formula' }), data, l)).toBe(data);
  });

  it('ignores a resume whose break is not in the line (behind the archive seam)', () => {
    const t = trace({ useLive: true, useArchive: true });
    const times = grid(now - 600 * S, 10 * S, 59);
    const a = archive(times, times.at(-1)! + 5 * S);
    // Break and resume both before the archive's last sample.
    const l: LiveSeriesResult = {
      ...live([now - 400 * S], [now - 300 * S]),
      resumes: [{ after: now - 300 * S, time: now - 200 * S, value: 1 }],
    };
    const data = traceLineData(t, a, l, undefined);
    expect(withLiveResumes(t, data, l)).toBe(data);
  });
});

describe('nearestSample', () => {
  it('picks the nearer neighbour and clamps at the ends', () => {
    const data = [
      { time: 0, value: 1 },
      { time: 100, value: 2 },
    ];
    expect(nearestSample(data, 11)).toEqual({ time: 0, value: 1 });
    expect(nearestSample(data, 80)).toEqual({ time: 100, value: 2 });
    expect(nearestSample(data, -50)).toEqual({ time: 0, value: 1 });
    expect(nearestSample(data, 500)).toEqual({ time: 100, value: 2 });
    expect(nearestSample([], 5)).toBeUndefined();
  });

  it('returns an INVALID sample with its severity', () => {
    const data = [
      { time: 0, value: 1, severity: 'NO_ALARM' as const },
      { time: 10, value: 7, severity: 'INVALID' as const },
    ];
    expect(nearestSample(data, 9)).toEqual({ time: 10, value: 7, severity: 'INVALID' });
  });
});

describe('INVALID samples', () => {
  it('break the archive line at the first sample of each run', () => {
    const mean = [
      { time: 0, value: 1, severity: 'NO_ALARM' as const },
      { time: 1000, value: 2, severity: 'INVALID' as const },
      { time: 2000, value: 3, severity: 'INVALID' as const },
      { time: 3000, value: 4, severity: 'NO_ALARM' as const },
    ];
    const data = traceLineData(
      trace({ useArchive: true }),
      { status: 'ready', mode: 'raw', mean, band: [], coverToNs: 3000 * 1_000_000 },
      undefined,
      undefined
    );
    expect(data).toEqual([
      [0, 1],
      [1000, null],
      [3000, 4],
    ]);
  });
});

describe('extension for a Live-on curve with no live sample yet', () => {
  // Main draws the dashed extension from the last sample whatever the live
  // connection: a Live-on curve whose PV has sent nothing (still connecting,
  // archive-only, or the live service down at load) extends its archive line.
  const now = T0 + 3_600 * S;
  const times = grid(now - 600 * S, 10 * S, 60);
  const last = times.at(-1)!;
  const a = archive(times, last + 5 * S);
  const waiting = (status: LiveSeriesResult['status']): LiveSeriesResult => ({
    ...live([], [], false),
    status,
  });

  it('extends the archive line while live is idle, connecting or down', () => {
    const t = trace({ useLive: true, useArchive: true });
    for (const l of [undefined, waiting('idle'), waiting('connecting'), waiting('disconnected')]) {
      const data = traceLineData(t, a, l, undefined);
      expect(extensionAnchor(t, data, a, l)).toEqual([last, 1]);
    }
  });

  it('still draws none once a disconnect has broken the line', () => {
    const t = trace({ useLive: true, useArchive: true });
    const l = live([last + 20 * S], [last + 30 * S], false);
    const data = traceLineData(t, a, l, undefined);
    expect(data.at(-1)).toEqual([last + 30 * S, null]);
    expect(extensionAnchor(t, data, a, l)).toBeUndefined();
  });
});
