import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { serializeWorkspace, deserializeWorkspace } from './serialize';
import { relativeRangeMs } from '../api/time';
import type { Plot } from '../types';

const ONE_MINUTE_MS = 60_000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

// Saved before #66 renamed the month preset, so "-1m" there meant one month.
const MONTH_ERA_SAVED_AT = '2026-07-01T00:00:00.000Z';
// Saved after #66, so "-1m" there is a typed one-minute span.
const CURRENT_SAVED_AT = '2026-10-17T12:00:00.000Z';

function spanPlot(timeRange: string, id = 'plot-1'): Plot {
  return {
    id,
    title: id,
    traces: [],
    axes: [],
    backgroundColor: '#161616',
    showLegend: true,
    showXGridlines: true,
    showYGridlines: true,
    showCrosshair: true,
    gridStyle: 'solid',
    gridOpacity: 1,
    tickFontSize: 11,
    xAxis: { timeRange },
  };
}

// A native workspace file as written to disk. `savedAt` is left out entirely
// when undefined so the "missing" case really has no key.
function nativeFile(timeRanges: string[], savedAt?: unknown): string {
  return JSON.stringify({
    schemaVersion: 1,
    ...(savedAt === undefined ? {} : { savedAt }),
    theme: 'dark',
    plots: timeRanges.map((r, i) => spanPlot(r, `plot-${i + 1}`)),
  });
}

function loadedRanges(text: string): string[] {
  return deserializeWorkspace(text).plots.map((p) => p.xAxis.timeRange);
}

describe('deserializeWorkspace — "-1m" span', () => {
  // serializeWorkspace stamps savedAt from the clock. Pin it after the cutoff so
  // the round trips don't depend on the test machine's clock.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(CURRENT_SAVED_AT));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps a typed 1m span as one minute across save and load', () => {
    const saved = serializeWorkspace({ theme: 'dark', plots: [spanPlot('-1m')] });
    const [plot] = deserializeWorkspace(saved).plots;

    expect(plot.xAxis.timeRange).toBe('-1m');
    expect(relativeRangeMs(plot.xAxis.timeRange)).toBe(ONE_MINUTE_MS);
  });

  it('keeps a legacy .trc 1m span as one minute after re-saving and loading', () => {
    const trc = JSON.stringify({
      plot: { title: 'T' },
      'y-axes': [],
      curves: [],
      time_axis: { start: '-1m', end: 'now' },
    });
    const imported = deserializeWorkspace(trc);
    expect(imported.plots[0].xAxis.timeRange).toBe('-1m');

    const resaved = serializeWorkspace({ theme: 'dark', plots: imported.plots });
    expect(loadedRanges(resaved)).toEqual(['-1m']);
  });

  it('still migrates "-1m" to the month preset in a file saved before the rename', () => {
    const plots = deserializeWorkspace(nativeFile(['-1m', '-5m'], MONTH_ERA_SAVED_AT)).plots;

    expect(plots.map((p) => p.xAxis.timeRange)).toEqual(['-1M', '-5m']);
    expect(relativeRangeMs(plots[0].xAxis.timeRange)).toBe(THIRTY_DAYS_MS);
  });

  // Pins the cutoff to #66's mergedAt instant.
  it('migrates only files saved strictly before the cutoff', () => {
    expect(loadedRanges(nativeFile(['-1m'], '2026-07-17T16:15:54Z'))).toEqual(['-1m']);
    expect(loadedRanges(nativeFile(['-1m'], '2026-07-17T16:15:53.999Z'))).toEqual(['-1M']);
  });

  it.each([
    ['missing', undefined],
    ['unparseable', 'not a date'],
    ['empty', ''],
    ['not a string', 123],
  ])('treats "-1m" as minutes when savedAt is %s', (_label, savedAt) => {
    expect(loadedRanges(nativeFile(['-1m'], savedAt))).toEqual(['-1m']);
  });

  it.each([
    ['saved before the rename', MONTH_ERA_SAVED_AT],
    ['saved after the rename', CURRENT_SAVED_AT],
  ])('leaves every other span unchanged in a file %s', (_label, savedAt) => {
    const others = ['-1M', '-2m', '-60m', '-1.5m', '-01m', '-1.0m', '-1h', 'custom'];
    expect(loadedRanges(nativeFile(others, savedAt))).toEqual(others);
  });
});
