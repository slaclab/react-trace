// The statistics panel every tool docks under its chart: the
// readout table, the distribution block (when the tool's Show
// distribution is on) and the strip charts, in one "Statistics" region.
// Rendered only while the tool's Show statistics is on and something is
// drawn; the chart above flexes to the remainder (statistics.css `stats-canvas`).

import { useMemo } from 'react';
import type { ChartTheme } from '@slaclab/canopy-charts';
import { panelHasContent, shownRows, type MetricTable, type StatFrame } from './evaluate';
import { Distribution } from './Distribution';
import type { Metric, MetricCatalog } from './model';
import { Readout } from './Readout';
import { Strips } from './Strips';
import type { StripHistory } from './history';
import './statistics.css';

export interface StatisticsPanelProps {
  /** The tool's Show statistics toggle. */
  show: boolean;
  catalog: MetricCatalog;
  metrics: readonly Metric[];
  table: MetricTable;
  strips: StripHistory;
  unitOf: (rowId: string, unit: string) => string;
  rowHeading?: string;
  chartTheme?: ChartTheme;
  /** The tool's Show distribution toggle; the block reads `frame`. */
  distribution?: boolean;
  frame?: StatFrame | null;
}

export function StatisticsPanel({
  show,
  catalog,
  metrics,
  table,
  strips,
  unitOf,
  rowHeading,
  chartTheme,
  distribution = false,
  frame = null,
}: StatisticsPanelProps) {
  const rows = useMemo(
    () => shownRows(table).map(({ id, label, color }) => ({ id, label, color })),
    [table]
  );
  const distributionShown = distribution && frame !== null && frame.rows.length > 0;
  if (!show || (!panelHasContent(metrics, table) && !distributionShown)) return null;
  const valueUnitOf = (rowId: string) => unitOf(rowId, 'y');
  return (
    <section className="stats-panel" aria-label="Statistics" data-testid="stats-panel">
      <Readout table={table} metrics={metrics} unitOf={unitOf} rowHeading={rowHeading} />
      {distributionShown && (
        <Distribution frame={frame} unitOf={valueUnitOf} chartTheme={chartTheme} />
      )}
      <Strips
        catalog={catalog}
        history={strips}
        rows={rows}
        metrics={metrics}
        chartTheme={chartTheme}
      />
    </section>
  );
}
