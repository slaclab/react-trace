// The strip-chart history shared by every tool: every metric's value per row
// (on or not, so turning a strip on shows the past), appended only when the
// tool's clock advanced, at most `STRIP_CAP` points, cleared by the tool's
// Clear and never saved. The clock is the tool's: Correlation's newest table
// row, Waveform's publish time, Trace's newest sample.

import type { MetricTable } from './evaluate';

export const STRIP_CAP = 3600;

export interface StripPoint {
  /** The clock (ms) of the frame this point was computed from. */
  timeMs: number;
  /** Row id → metric id → its value at that point. */
  values: Record<string, Record<string, number | null>>;
}

export interface StripHistory {
  points: StripPoint[];
}

export const EMPTY_STRIPS: StripHistory = { points: [] };

/** The history without the values of `ids` (their expression changed); same object when nothing is dropped. */
export function forgetMetrics(history: StripHistory, ids: readonly string[]): StripHistory {
  if (ids.length === 0 || history.points.length === 0) return history;
  let dropped = false;
  const points = history.points.map((point) => {
    let values: StripPoint['values'] | null = null;
    for (const [row, byMetric] of Object.entries(point.values)) {
      if (!ids.some((id) => id in byMetric)) continue;
      values ??= { ...point.values };
      const kept = { ...byMetric };
      for (const id of ids) delete kept[id];
      values[row] = kept;
      dropped = true;
    }
    return values === null ? point : { timeMs: point.timeMs, values };
  });
  return dropped ? { points } : history;
}

/**
 * Append every metric of `table` for a frame at clock `timeMs`, only when it
 * advanced past the last point; drop the oldest beyond the cap. Returns the
 * same history when nothing is appended.
 */
export function appendStrips(
  history: StripHistory,
  timeMs: number | null,
  table: MetricTable,
  cap = STRIP_CAP
): StripHistory {
  if (timeMs === null) return history;
  const last = history.points[history.points.length - 1];
  if (last !== undefined && timeMs <= last.timeMs) return history;
  const values: Record<string, Record<string, number | null>> = {};
  for (const row of table.rows) {
    const byMetric: Record<string, number | null> = {};
    for (const [id, cell] of Object.entries(row.cells)) byMetric[id] = cell.value;
    values[row.id] = byMetric;
  }
  const points = [...history.points, { timeMs, values }];
  if (points.length > cap) points.splice(0, points.length - cap);
  return { points };
}
