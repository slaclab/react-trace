// The Statistics tab every tool's schema builds the same way:
// Show statistics (toggle, L1) · Show distribution (toggle, L1, while
// statistics are shown) · Metrics (custom list editor, L1) ·
// Reset metrics (action, L2; disabled at the default). The tool supplies
// where the values live in its state and the row count the editor validates
// against.

import { createElement } from 'react';
import type { FieldDef, ToolContext, ToolUi } from '../workbench/types';
import { MetricsControl } from './MetricsControl';
import { defaultMetrics, metricsAreDefault, type Metric, type MetricCatalog } from './model';

export const STATS_FIELD_IDS = {
  show: 'stats-show',
  distribution: 'stats-dist',
  metrics: 'metrics',
  reset: 'metrics-reset',
} as const;

export interface StatisticsFieldsSpec<S, M, U extends ToolUi> {
  tab: string;
  catalog: MetricCatalog;
  getShow(ctx: ToolContext<S, M, U>): boolean;
  setShow(ctx: ToolContext<S, M, U>, on: boolean): void;
  getDistribution(ctx: ToolContext<S, M, U>): boolean;
  setDistribution(ctx: ToolContext<S, M, U>, on: boolean): void;
  getMetrics(ctx: ToolContext<S, M, U>): readonly Metric[];
  setMetrics(ctx: ToolContext<S, M, U>, metrics: Metric[]): void;
  /** How many rows the frame has (for `y<k>` validation). */
  rowCount(ctx: ToolContext<S, M, U>): number;
}

export function statisticsFields<S, M, U extends ToolUi>(
  spec: StatisticsFieldsSpec<S, M, U>
): FieldDef<S, M, U>[] {
  const { tab, catalog } = spec;
  return [
    {
      id: STATS_FIELD_IDS.show,
      label: 'Show statistics',
      kind: 'toggle',
      tab,
      level: 'L1',
      get: (ctx) => spec.getShow(ctx),
      set: (ctx, on) => spec.setShow(ctx, on),
    },
    {
      id: STATS_FIELD_IDS.distribution,
      label: 'Show distribution',
      kind: 'toggle',
      tab,
      level: 'L1',
      when: (ctx) => spec.getShow(ctx),
      get: (ctx) => spec.getDistribution(ctx),
      set: (ctx, on) => spec.setDistribution(ctx, on),
    },
    {
      id: STATS_FIELD_IDS.metrics,
      label: 'Metrics',
      kind: 'custom',
      tab,
      level: 'L1',
      get: (ctx) => spec.getMetrics(ctx),
      set: (ctx, metrics: Metric[]) => spec.setMetrics(ctx, metrics),
      render: ({ value, onChange, id, ctx }) =>
        createElement(MetricsControl, {
          id,
          catalog,
          value,
          onChange,
          rowCount: spec.rowCount(ctx),
        }),
    },
    {
      id: STATS_FIELD_IDS.reset,
      label: 'Reset metrics',
      kind: 'action',
      tab,
      level: 'L2',
      disabled: (ctx) =>
        metricsAreDefault(catalog, spec.getMetrics(ctx)) ? 'Already the default' : false,
      run: (ctx) => spec.setMetrics(ctx, defaultMetrics(catalog)),
    },
  ];
}
