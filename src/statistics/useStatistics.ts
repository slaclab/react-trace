// The statistics of a frame as a tool's canvas holds them: the metric table
// over the frame on screen and the strip history on the tool's clock. The
// generic half of Correlation's `useCorrelationFrame`; Waveform and Trace use
// it directly.
//
//   - The table is recomputed when the frame or the list changes; `metrics`
//     should keep its identity across renders (the state's list).
//   - A metric whose expression changed, or that left the list (a custom id
//     a later metric may reuse), must not join its old values to new ones:
//     its history is forgotten on the change.
//   - Strips follow the clock; `appendStrips` ignores a clock that did not
//     advance. `clear()` empties the history (the tool's Clear).

import { useCallback, useMemo, useState } from 'react';
import { evaluateMetrics, type MetricTable, type StatFrame } from './evaluate';
import type { Metric, MetricCatalog } from './model';
import { appendStrips, EMPTY_STRIPS, forgetMetrics, type StripHistory } from './history';

export interface Statistics {
  table: MetricTable;
  strips: StripHistory;
  /** Empty the strip history. */
  clear(): void;
}

/** The ids whose history is stale: an expression changed, or the metric left the list. */
export function changedMetricIds(prev: readonly Metric[], next: readonly Metric[]): string[] {
  const after = new Map(next.map((m) => [m.id, m.expr]));
  return prev.filter((m) => !after.has(m.id) || after.get(m.id) !== m.expr).map((m) => m.id);
}

export function useStatistics(
  catalog: MetricCatalog,
  frame: StatFrame | null,
  metrics: readonly Metric[],
  /** The frame's clock (ms); null when it has none yet. */
  clockMs: number | null
): Statistics {
  const [strips, setStrips] = useState(EMPTY_STRIPS);
  const [seen, setSeen] = useState<StatFrame | null>(null);
  const table = useMemo(() => evaluateMetrics(catalog, frame, metrics), [catalog, frame, metrics]);

  const [seenMetrics, setSeenMetrics] = useState(metrics);
  if (metrics !== seenMetrics) {
    setSeenMetrics(metrics);
    const changed = changedMetricIds(seenMetrics, metrics);
    if (changed.length > 0) setStrips((prev) => forgetMetrics(prev, changed));
  }

  if (frame !== seen) {
    setSeen(frame);
    setStrips((prev) => appendStrips(prev, clockMs, table));
  }

  const clear = useCallback(() => setStrips(EMPTY_STRIPS), []);
  return { table, strips, clear };
}
